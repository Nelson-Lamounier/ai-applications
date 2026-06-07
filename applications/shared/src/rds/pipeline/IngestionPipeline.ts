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
 *   4. Embed missing and stale chunks via a bounded worker pool
 *   5. upsertBatch — persist embedded chunks
 *   6. markComplete / markError — record outcome
 *   7. Return IngestionReport
 *
 * Concurrent embedding:
 *   Chunks are embedded through a bounded-concurrency worker pool
 *   (EMBED_CONCURRENCY, default 8) that writes results into a pre-sized array
 *   by index, preserving order. This replaced the previous one-at-a-time loop,
 *   which made large repos (~2800 chunks) spend ~10 min embedding and risk the
 *   Job deadline. Keep the concurrency within the per-model Bedrock Titan quota.
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
 *
 * Sized to enrich a typical single repo fully in one pass (observed repos run
 * ~2–2.4k chunks each). Chunks beyond the cap are backfilled cheaply by the
 * standalone re-enrich Job (run-reenrich) without re-embedding — so the cap
 * stays a cost guard, not a coverage ceiling.
 */
const DEFAULT_MAX_ENRICHMENT_PER_INGESTION = 4000;

/** Bounded concurrency for enrichment calls. Bedrock TPS is generous for Haiku. */
const ENRICHMENT_CONCURRENCY = 10;

/**
 * Bounded concurrency for embedding calls. Embedding was previously sequential
 * (one awaited Bedrock Titan call per chunk), making a ~2800-chunk repo spend
 * ~10 min in this phase alone and risk the Job's activeDeadlineSeconds. A small
 * worker pool cuts that to ~1-2 min. Override via EMBED_CONCURRENCY. Titan TPS
 * is high; keep within the per-model quota.
 */
const EMBED_CONCURRENCY = (() => {
    const raw = process.env.EMBED_CONCURRENCY;
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n >= 1 ? n : 8;
})();

/** Log embedding progress every N chunks so the pod is not silent for minutes. */
const EMBED_PROGRESS_LOG_EVERY = 250;

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
     * @param opts.knownFilePaths - The FULL set of file paths currently included
     *   in the repo tree. Pruning deletes stored chunks whose file_path is NOT in
     *   this set. Under incremental ingest, `rawChunks` carries only the CHANGED
     *   files, so deriving the prune set from `rawChunks` would wrongly delete
     *   unchanged files. Pass the full tree here to make pruning incremental-safe.
     *   When omitted, the prune set is derived from `rawChunks` (full-reindex
     *   behaviour — back-compatible).
     */
    async ingestChunks(
        userId: string,
        repoFullName: string,
        rawChunks: RawChunk[],
        opts?: { knownFilePaths?: string[] },
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
            await this.syncState.markPhase(userId, repoFullName, 'enriching', 0, chunksToEmbed.length).catch(() => {});
            const enrichedChunks = await tracer.startActiveSpan('ingestion.enrich', async (span) => {
                try {
                    const result = await this.enrichChunks(userId, repoFullName, chunksToEmbed.map(c => c.chunk));
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
                    // Embed via a bounded-concurrency worker pool (same shape as
                    // enrichChunks). Results are written into a pre-sized array by
                    // index so chunk ordering is preserved despite concurrency.
                    const embeddedChunks: DocumentChunk[] = new Array(chunksToEmbed.length);
                    const embedTotal = chunksToEmbed.length;
                    let embedNext = 0;
                    let embedDone = 0;

                    // Set the embedding phase up-front so the UI label/total are
                    // correct before the first checkpoint write.
                    await this.syncState.markPhase(userId, repoFullName, 'embedding', 0, embedTotal).catch(() => {});

                    const embedOne = async (idx: number): Promise<void> => {
                        const { chunk, contentHash } = chunksToEmbed[idx]!;
                        const enriched  = enrichedByKey.get(`${chunk.filePath}::${chunk.chunkIndex}`) ?? chunk;
                        const embedText = this.buildEmbedText(enriched.content, repoFullName, enriched.filePath, enriched.heading);
                        const embedding = await this.embedder.embed(embedText);
                        embeddedChunks[idx] = { ...enriched, userId, repoFullName, contentHash, embedding };
                        embedDone++;
                        if (embedDone % EMBED_PROGRESS_LOG_EVERY === 0 || embedDone === embedTotal) {
                            console.log(`[IngestionPipeline] ${repoFullName}: embedded ${embedDone}/${embedTotal} chunks`);
                            // Persist intra-repo progress so the UI shows movement.
                            // Best-effort: a progress write must never fail ingestion.
                            await this.syncState
                                .markPhase(userId, repoFullName, 'embedding', embedDone, embedTotal)
                                .catch(() => { /* swallow — progress is advisory */ });
                        }
                    };

                    const embedCtx = context.active();
                    await Promise.all(
                        Array.from({ length: Math.min(EMBED_CONCURRENCY, embedTotal) }, () =>
                            context.with(embedCtx, async () => {
                                while (true) {
                                    const myIdx = embedNext++;
                                    if (myIdx >= embedTotal) return;
                                    await embedOne(myIdx);
                                }
                            }),
                        ),
                    );
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
                    const currentFilePaths = opts?.knownFilePaths
                        ?? [...new Set(rawChunks.map(c => c.filePath))];
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
            const currentFilePaths = opts?.knownFilePaths
                ?? [...new Set(rawChunks.map(c => c.filePath))];
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

            await this.syncState.markPhase(userId, repoFullName, 'finalizing').catch(() => {});

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
    private async enrichChunks(userId: string, repoFullName: string, chunks: RawChunk[]): Promise<RawChunk[]> {
        if (!this.enricher || chunks.length === 0) return chunks;

        const out: RawChunk[] = new Array(chunks.length);
        const cap = this.maxEnrichmentPerRun;
        let enrichDone = 0;

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
                        enrichDone++;
                        if (enrichDone % EMBED_PROGRESS_LOG_EVERY === 0 || enrichDone === total) {
                            await this.syncState
                                .markPhase(userId, repoFullName, 'enriching', enrichDone, total)
                                .catch(() => { /* advisory progress */ });
                        }
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
