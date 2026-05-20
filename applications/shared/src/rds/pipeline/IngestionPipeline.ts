/**
 * @format
 * IngestionPipeline — Decoupled Orchestrator
 *
 * Coordinates hash-check → embed → upsert for a batch of raw document chunks.
 * Depends exclusively on interfaces — imports no concrete AWS clients, no
 * SQL, no Titan SDK. Swap any implementation without touching this class.
 *
 * Flow:
 *   1. markStarted — record that ingestion is in progress
 *   2. Compute SHA-256 contentHash for every raw chunk
 *   3. checkContentHashes — one DB round-trip to classify missing/stale/unchanged
 *   4. Embed only missing and stale chunks (sequential — see note below)
 *   5. upsertBatch — persist embedded chunks
 *   6. markComplete / markError — record outcome
 *   7. Return IngestionReport
 *
 * Sequential embedding:
 *   Chunks are embedded one at a time. Bedrock InvokeModel has a per-model
 *   TPS limit — sequential calls are safe for portfolio workloads (< 10K chunks
 *   per repo). Introduce parallelism (p-limit 3–5) only after measuring that
 *   both RDS pg Pool and Bedrock stay stable under concurrent load.
 */

import { createHash } from 'crypto';

import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import type { IChunkEnricher } from '../interfaces/IChunkEnricher.js';
import type { IEmbeddingProvider } from '../interfaces/IEmbeddingProvider.js';
import type { ISyncStateRepository } from '../interfaces/ISyncStateRepository.js';
import type { IVectorStore } from '../interfaces/IVectorStore.js';
import { computeKbQuality } from '../quality/computeKbQuality.js';
import type { IRetrievalProbe, RetrievalBreakdown } from '../quality/retrievalProbe.js';
import type {
    DocumentChunk,
    IngestionReport,
    RawChunk,
} from '../types.js';

const tracer = trace.getTracer('ingestion-pipeline');

/**
 * Default cap on how many chunks are sent to the enricher in one ingestion
 * run. Above this, remaining chunks are embedded without enrichment and
 * marked `metadata.enrichment_status = 'skipped_quota'`. Override via the
 * `MAX_ENRICHMENT_PER_INGESTION` environment variable.
 */
const DEFAULT_MAX_ENRICHMENT_PER_INGESTION = 2000;

/** Bounded concurrency for enrichment calls. Bedrock TPS is generous for Haiku. */
const ENRICHMENT_CONCURRENCY = 5;

export interface IngestionPipelineOptions {
    /**
     * Optional skill-evidence enricher. When omitted, enrichment is skipped
     * entirely and chunks are persisted with empty `skills` / `technologies`.
     */
    readonly enricher?: IChunkEnricher;
    /**
     * Hard cap on enrichment calls per ingestion run. Defaults to
     * `MAX_ENRICHMENT_PER_INGESTION` env var or 2000.
     */
    readonly maxEnrichmentPerRun?: number;
    /**
     * Optional retrieval-quality probe. When omitted, the probe phase is
     * skipped entirely and `retrievalScore` / `retrievalBreakdown` are absent
     * from the report. A probe failure MUST NOT fail ingestion.
     */
    readonly retrievalProbe?: IRetrievalProbe;
}

export class IngestionPipeline {
    private readonly vectorStore: IVectorStore;
    private readonly syncState: ISyncStateRepository;
    private readonly embedder: IEmbeddingProvider;
    private readonly enricher?: IChunkEnricher;
    private readonly retrievalProbe?: IRetrievalProbe;
    private readonly maxEnrichmentPerRun: number;

    constructor(
        vectorStore: IVectorStore,
        syncState: ISyncStateRepository,
        embedder: IEmbeddingProvider,
        options: IngestionPipelineOptions = {},
    ) {
        this.vectorStore    = vectorStore;
        this.syncState      = syncState;
        this.embedder       = embedder;
        this.enricher       = options.enricher;
        this.retrievalProbe = options.retrievalProbe;
        this.maxEnrichmentPerRun =
            options.maxEnrichmentPerRun
            ?? parseEnrichmentCapFromEnv()
            ?? DEFAULT_MAX_ENRICHMENT_PER_INGESTION;
    }

    // =========================================================================
    // ingestChunks
    // =========================================================================

    /**
     * Ingest a batch of raw chunks for a single (userId, repoFullName).
     *
     * @param userId       - Owner of the chunks
     * @param repoFullName - "owner/repo" format
     * @param rawChunks    - Pre-split chunks without embedding or hash
     */
    async ingestChunks(
        userId: string,
        repoFullName: string,
        rawChunks: RawChunk[],
    ): Promise<IngestionReport> {
        const startMs = Date.now();
        await this.syncState.markStarted(userId, repoFullName);

        try {
            // ── Phase: Chunk + classify ──────────────────────────────────────────
            const { chunksToEmbed, unchanged } = await tracer.startActiveSpan('ingestion.chunk', async (span) => {
                try {
                    const hashedChunks = rawChunks.map(chunk => ({
                        chunk,
                        contentHash: createHash('sha256').update(chunk.content).digest('hex'),
                    }));
                    const candidates = hashedChunks.map(({ chunk, contentHash }) => ({
                        filePath:   chunk.filePath,
                        chunkIndex: chunk.chunkIndex,
                        contentHash,
                    }));
                    const { missing, stale: _stale, unchanged } = await this.vectorStore.checkContentHashes(
                        userId, repoFullName, candidates,
                    );
                    const unchangedSet = new Set(unchanged.map(c => `${c.filePath}::${c.chunkIndex}`));
                    const chunksToEmbed = hashedChunks.filter(
                        ({ chunk }) => !unchangedSet.has(`${chunk.filePath}::${chunk.chunkIndex}`),
                    );
                    span.setAttributes({ 'chunk.total': rawChunks.length, 'chunk.to_embed': chunksToEmbed.length });
                    return { chunksToEmbed, missing, unchanged };
                } catch (err) {
                    span.recordException(err instanceof Error ? err : new Error(String(err)));
                    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
                    throw err;
                } finally {
                    span.end();
                }
            });

            // ── Phase: Enrich ────────────────────────────────────────────────────
            const enrichedChunks = await tracer.startActiveSpan('ingestion.enrich', async (span) => {
                try {
                    const result = await this.enrichChunks(chunksToEmbed.map(c => c.chunk));
                    span.setAttribute('chunk.enrich_count', result.length);
                    return result;
                } catch (err) {
                    span.recordException(err instanceof Error ? err : new Error(String(err)));
                    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
                    throw err;
                } finally {
                    span.end();
                }
            });

            // ── Phase: Embed + Upsert ────────────────────────────────────────────
            const upsertResult = await tracer.startActiveSpan('ingestion.embed_upsert', async (span) => {
                try {
                    const enrichedByKey = new Map(
                        enrichedChunks.map(c => [`${c.filePath}::${c.chunkIndex}`, c] as const),
                    );
                    const embeddedChunks: DocumentChunk[] = [];
                    for (const { chunk, contentHash } of chunksToEmbed) {
                        const enriched  = enrichedByKey.get(`${chunk.filePath}::${chunk.chunkIndex}`) ?? chunk;
                        const embedText = this.buildEmbedText(enriched.content, repoFullName, enriched.filePath, enriched.heading);
                        const embedding = await this.embedder.embed(embedText);
                        embeddedChunks.push({ ...enriched, userId, repoFullName, contentHash, embedding });
                    }
                    const result = embeddedChunks.length > 0
                        ? await this.vectorStore.upsertBatch(embeddedChunks)
                        : { inserted: 0, updated: 0, skipped: 0, errors: 0 };
                    span.setAttributes({ 'embed.count': embeddedChunks.length, 'upsert.inserted': result.inserted });
                    return result;
                } catch (err) {
                    span.recordException(err instanceof Error ? err : new Error(String(err)));
                    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
                    throw err;
                } finally {
                    span.end();
                }
            });

            // ── Phase: Prune ─────────────────────────────────────────────────────
            const pruned = await tracer.startActiveSpan('ingestion.prune', async (span) => {
                try {
                    const currentFilePaths = [...new Set(rawChunks.map(c => c.filePath))];
                    const n = await this.vectorStore.pruneDeletedFiles(userId, repoFullName, currentFilePaths);
                    span.setAttribute('prune.count', n);
                    return n;
                } catch (err) {
                    span.recordException(err instanceof Error ? err : new Error(String(err)));
                    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
                    throw err;
                } finally {
                    span.end();
                }
            });

            // ── Quality + completion ─────────────────────────────────────────────
            const currentFilePaths = [...new Set(rawChunks.map(c => c.filePath))];
            const quality = computeKbQuality(rawChunks);

            let retrieval: RetrievalBreakdown | undefined;
            if (this.retrievalProbe) {
                retrieval = await tracer.startActiveSpan('ingestion.retrieval_probe', async (span) => {
                    try {
                        const r = await this.retrievalProbe!.evaluate({
                            userId,
                            repoFullName,
                            rawChunks,
                            embedder:    this.embedder,
                            vectorStore: this.vectorStore,
                        });
                        span.setAttributes({ 'retrieval.status': r.status, 'retrieval.score': r.score });
                        return r;
                    } catch (err) {
                        // Best-effort: probe failures MUST NOT break ingestion.
                        // IRetrievalProbe.evaluate() is contracted to return
                        // status:'failed' rather than throw, so reaching here means an
                        // unexpected error — log it, swallow it, continue ingestion.
                        console.error('[IngestionPipeline] retrieval probe threw unexpectedly:', err);
                        span.recordException(err instanceof Error ? err : new Error(String(err)));
                        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
                        return undefined;
                    } finally {
                        span.end();
                    }
                });
            }
            const persistRetrieval = retrieval && retrieval.status === 'ok' ? retrieval : undefined;

            await this.syncState.markComplete(
                userId,
                repoFullName,
                currentFilePaths.length,
                rawChunks.length,
                quality.score,
                quality.breakdown as unknown as Record<string, unknown>,
                persistRetrieval?.score,
                persistRetrieval as unknown as Record<string, unknown> | undefined,
            );

            return {
                userId,
                repoFullName,
                totalRawChunks:     rawChunks.length,
                embedded:           chunksToEmbed.length,
                skipped:            unchanged.length,
                pruned,
                upsertResult,
                durationMs:         Date.now() - startMs,
                kbQualityScore:     quality.score,
                kbQualityBreakdown: quality.breakdown as unknown as Record<string, unknown>,
                retrievalScore:     persistRetrieval?.score,
                retrievalBreakdown: persistRetrieval as unknown as Record<string, unknown> | undefined,
            };

        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            await this.syncState.markError(userId, repoFullName, errorMessage);
            throw err;
        }
    }

    // =========================================================================
    // Context enrichment
    // =========================================================================

    /**
     * Build the text that is actually sent to the embedding model.
     * The preamble injects repository, file, and section metadata so the
     * resulting vector captures structural context beyond the raw prose.
     * The `content` field stored in the DB is kept clean (no preamble) so
     * retrieval results are readable verbatim.
     */
    private buildEmbedText(
        content: string,
        repoFullName: string,
        filePath: string,
        heading?: string,
    ): string {
        const section  = heading ?? 'root';
        const preamble = `[Repository: ${repoFullName} | File: ${filePath} | Section: ${section}]`;
        return `${preamble}\n\n${content}`;
    }

    // =========================================================================
    // forceReindex
    // =========================================================================

    /**
     * Delete all existing chunks for a repo then re-ingest from scratch.
     * Use when file paths or chunk boundaries have changed significantly.
     */
    async forceReindex(
        userId: string,
        repoFullName: string,
        rawChunks: RawChunk[],
    ): Promise<IngestionReport> {
        await this.vectorStore.deleteChunksByRepo(userId, repoFullName);
        return this.ingestChunks(userId, repoFullName, rawChunks);
    }

    // =========================================================================
    // Enrichment (skill evidence + technologies)
    // =========================================================================

    /**
     * Run the IChunkEnricher across `chunks` with bounded concurrency.
     *
     * Best-effort semantics:
     *   - No enricher configured → return chunks unchanged.
     *   - Enricher throws on a chunk → log + write
     *     `metadata.enrichment_status = 'failed'`, never block ingestion.
     *   - Cap exceeded → remaining chunks tagged `'skipped_quota'`.
     *
     * Returns chunks in the same order as input, with `skills` /
     * `technologies` / `metadata.enrichment_status` populated.
     */
    private async enrichChunks(chunks: RawChunk[]): Promise<RawChunk[]> {
        if (!this.enricher || chunks.length === 0) return chunks;

        const out: RawChunk[] = new Array(chunks.length);
        const cap = this.maxEnrichmentPerRun;

        const enrichOne = async (idx: number): Promise<void> => {
            const chunk = chunks[idx];
            if (idx >= cap) {
                out[idx] = withMetadata(chunk, { enrichment_status: 'skipped_quota' });
                return;
            }
            try {
                const { skills, technologies } = await this.enricher!.enrich(chunk);
                out[idx] = {
                    ...chunk,
                    skills,
                    technologies,
                    metadata: {
                        ...(chunk.metadata ?? {}),
                        enrichment_status: 'ok',
                    },
                };
            } catch (err) {
                console.error(
                    `[IngestionPipeline.enrichChunks] failed for ` +
                    `${chunk.filePath}#${chunk.chunkIndex}:`,
                    err,
                );
                out[idx] = withMetadata(chunk, { enrichment_status: 'failed' });
            }
        };

        // Bounded-concurrency worker pool — N workers pulling from a shared
        // index counter. Faster than batching in slices of N when individual
        // calls vary widely in latency (which Bedrock does).
        let next = 0;
        const total = chunks.length;
        const currentCtx = context.active();
        await Promise.all(
            Array.from({ length: Math.min(ENRICHMENT_CONCURRENCY, total) }, () =>
                context.with(currentCtx, async () => {
                    while (true) {
                        const myIdx = next++;
                        if (myIdx >= total) return;
                        await enrichOne(myIdx);
                    }
                }),
            ),
        );

        return out;
    }
}

// =============================================================================
// Module helpers
// =============================================================================

function parseEnrichmentCapFromEnv(): number | undefined {
    const raw = process.env.MAX_ENRICHMENT_PER_INGESTION;
    if (!raw) return undefined;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function withMetadata(
    chunk: RawChunk,
    extra: Record<string, unknown>,
): RawChunk {
    return {
        ...chunk,
        skills:       chunk.skills       ?? [],
        technologies: chunk.technologies ?? [],
        metadata:     { ...(chunk.metadata ?? {}), ...extra },
    };
}
