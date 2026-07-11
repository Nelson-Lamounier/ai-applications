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
import type { IChunkEnricher, ChunkEnrichment } from '../interfaces/IChunkEnricher.js';
import type { IEmbeddingProvider } from '../interfaces/IEmbeddingProvider.js';
import type { ISyncStateRepository } from '../interfaces/ISyncStateRepository.js';
import type { IVectorStore } from '../interfaces/IVectorStore.js';
import { assignSkillsToChunks } from '../enrichment/assignSkillsToChunks.js';
import { groupChunksByFile } from '../enrichment/groupChunksByFile.js';
import { packChunks } from '../enrichment/packChunks.js';
import { computeKbQuality, type KbQualityInput } from '../quality/computeKbQuality.js';
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

/** Count chunks per fileClass lane (metadata.fileClass), for build-phase visibility. */
function tallyFileClassLanes(chunks: RawChunk[]): Record<string, number> {
    const lanes: Record<string, number> = {};
    for (const c of chunks) {
        const lane = (c.metadata?.['fileClass'] as string | undefined) ?? '(unclassified)';
        lanes[lane] = (lanes[lane] ?? 0) + 1;
    }
    return lanes;
}

/** Render lane tallies as "source=1368 docs=703 …", busiest first. */
function formatLanes(lanes: Record<string, number>): string {
    return Object.entries(lanes)
        .sort((a, b) => b[1] - a[1])
        .map(([lane, n]) => `${lane}=${n}`)
        .join(' ');
}

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
    /**
     * Fast-scan mode: skip inline enrichment entirely and tag every embedded
     * chunk `enrichment_status='pending'` so a background re-enrich pass
     * (reenrichSkippedChunks / run-reenrich) can fill skills off the critical
     * path. Set via DEFER_ENRICHMENT by run-ingestion. Default false (inline).
     */
    readonly deferEnrichment?: boolean;
    /**
     * Stored enrichment mode for this run. Passed through to markComplete so
     * repo_sync_state.enrichment_mode records exactly which enrichment tier was
     * active. Values are the narrow stored enum: 'llm' | 'tier1' | 'none'.
     */
    readonly enrichmentMode?: 'llm' | 'tier1' | 'none';
    /**
     * Model ID of the LLM enricher used in this run (e.g. 'anthropic.claude-haiku-…').
     * Null when no LLM enricher was active. Persisted to
     * repo_sync_state.enrichment_model for lineage and cost attribution.
     */
    readonly enrichmentModel?: string | null;
}

export class IngestionPipeline {
    private readonly vectorStore: IVectorStore;
    private readonly syncState: ISyncStateRepository;
    private readonly embedder: IEmbeddingProvider;
    private readonly enricher?: IChunkEnricher;
    private readonly retrievalProbe?: IRetrievalProbe;
    private readonly maxEnrichmentPerRun: number;
    private readonly deferEnrichment: boolean;
    private readonly enrichmentMode?: 'llm' | 'tier1' | 'none';
    private readonly enrichmentModel?: string | null;

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
        this.deferEnrichment = options.deferEnrichment ?? false;
        this.enrichmentMode  = options.enrichmentMode;
        this.enrichmentModel = options.enrichmentModel;
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

            // Visibility: this is where document_embeddings is built — name the
            // target table, what visited/produced the chunks, the per-fileClass
            // lane distribution that will land in metadata->>'fileClass', and the
            // components that create the rows. Previously the only signal was the
            // "embedded N/N" counter, which named neither the table nor the lanes.
            const lanes = tallyFileClassLanes(rawChunks);
            console.log(
                `[IngestionPipeline] ${repoFullName}: document_embeddings build — ` +
                `${new Set(rawChunks.map(c => c.filePath)).size} files visited, ` +
                `${rawChunks.length} chunks (${chunksToEmbed.length} to embed, ${unchanged.length} unchanged); ` +
                `lanes ${formatLanes(lanes)}; ` +
                `embedder=titan-embed writer=RdsVectorStore.upsertBatch table=document_embeddings`,
            );

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

            console.log(
                `[IngestionPipeline] ${repoFullName}: document_embeddings written — ` +
                `inserted ${upsertResult.inserted}, updated ${upsertResult.updated}, ` +
                `skipped ${upsertResult.skipped}, errors ${upsertResult.errors}`,
            );

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
            // Quality must reflect the repo's FULL persisted corpus, not this
            // run's delta — same cumulative-vs-delta rule as totalChunkCount
            // below. An incremental sync's rawChunks are only the changed-file
            // slice (a 61-chunk activity delta once overwrote a 0.65 whole-repo
            // score with 0.29: no README, no skills in the delta). Read lite
            // rows from the store post upsert+prune; fail-open to the run's
            // own chunks if the read fails.
            const quality = computeKbQuality(await this.qualityInputsOrFallback(userId, repoFullName, rawChunks));

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

            // chunk_count must reflect the repo's cumulative KB size, not this
            // run's chunks. On an incremental sync `rawChunks` is only the changed
            // -file delta, so persisting rawChunks.length made large repos read as
            // "<200 chunks". Read the true total from the store (post upsert+prune).
            const totalChunkCount = await this.vectorStore
                .countChunks(userId, repoFullName)
                .catch(() => rawChunks.length);

            await this.syncState.markComplete(
                userId,
                repoFullName,
                currentFilePaths.length,
                totalChunkCount,
                quality.score,
                quality.breakdown as unknown as Record<string, unknown>,
                persistRetrieval?.score,
                persistRetrieval as unknown as Record<string, unknown> | undefined,
                this.enrichmentMode ?? 'none',
                this.enrichmentModel ?? null,
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
     * Full-corpus quality inputs from the store; fail-open to the run's own
     * chunks so a store read failure can never break ingestion. Extracted from
     * ingestChunks to keep its lint complexity at the pre-change baseline.
     */
    private async qualityInputsOrFallback(
        userId: string,
        repoFullName: string,
        fallback: readonly RawChunk[],
    ): Promise<readonly KbQualityInput[]> {
        try {
            return await this.vectorStore.loadQualityInputs(userId, repoFullName);
        } catch {
            return fallback;
        }
    }

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
        // Fast-scan: defer ALL enrichment to a background pass. Tag chunks
        // 'pending' (so reenrichSkippedChunks finds them) and return without any
        // inline Bedrock calls — this is what takes enrichment off the critical
        // path and makes the first scan ~searchable in minutes.
        if (this.deferEnrichment) {
            return chunks.map(chunk => withMetadata(chunk, { enrichment_status: 'pending' }));
        }
        if (!this.enricher || chunks.length === 0) return chunks;

        // Per-file lever (feature 002): one model call per file instead of per
        // chunk, fanning skills back by evidence. Opt-in + requires enrichText;
        // falls through to the per-chunk path otherwise (fail-safe).
        if (process.env.ENRICH_PER_FILE === '1' && this.enricher.enrichText) {
            return this.enrichChunksPerFile(userId, repoFullName, chunks);
        }

        // Chunk-packing lever (feature 004): many chunks per model call, skills
        // keyed per chunk (the recall-safe cost cut — the model still judges each
        // chunk). Opt-in + requires enrichPack; missing keys + pack errors fall
        // back to per-chunk (fail-safe).
        if (process.env.ENRICH_PACK === '1' && this.enricher.enrichPack) {
            return this.enrichChunksPacked(userId, repoFullName, chunks);
        }

        const out: RawChunk[] = new Array(chunks.length);
        const cap = this.maxEnrichmentPerRun;
        let enrichDone = 0;

        // Batch lever (US3, recall-neutral): the per-chunk calls as ONE Bedrock
        // batch job (~50% cheaper). Fail-safe — null leaves the inline path below.
        const chunkBatch = await this.tryChunkBatch(userId, repoFullName, chunks, cap);

        const enrichOne = async (idx: number): Promise<void> => {
            const chunk = chunks[idx];
            if (idx >= cap) {
                out[idx] = withMetadata(chunk, { enrichment_status: 'skipped_quota' });
                return;
            }
            try {
                const fromBatch = chunkBatch?.get(`${chunk.filePath}::${chunk.chunkIndex}`);
                const { skills, technologies } = fromBatch ?? await this.enricher!.enrich(chunk);
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

    /**
     * Per-file enrichment (feature 002 cost lever, opt-in via ENRICH_PER_FILE):
     * group chunks by file, make ONE model call per file via enrichText, then
     * fan the file's skills back to its chunks under the per-chunk evidence
     * guard (a chunk gets a skill only if it evidences it — no smearing). On the
     * reference repo this is ~1,066 calls vs ~3,932, a ~3.7x reduction.
     *
     * Same fail-safe posture as the per-chunk path: a unit whose call throws
     * marks its chunks 'failed' (never blocks ingestion). The cap applies to
     * UNITS (model calls) here; chunks of skipped units → 'skipped_quota'.
     */
    private async enrichChunksPerFile(userId: string, repoFullName: string, chunks: RawChunk[]): Promise<RawChunk[]> {
        const maxChars = Number.parseInt(process.env.ENRICH_PER_FILE_MAX_CHARS ?? '12000', 10) || 12000;
        const units = groupChunksByFile(chunks, maxChars);
        const cap = this.maxEnrichmentPerRun;
        // No resolver-near evidence wired here yet — surface-match (built into
        // assignSkillsToChunks) is the v1 guard; the US2 eval decides if the
        // embedding lane is needed. Deterministic + cheap (no extra model call).
        const noExtraEvidence = (): boolean => false;

        // Batch lever (US3): one Bedrock batch job for all units (~50% cheaper).
        // Fail-safe — any batch error leaves batchSkills null and the per-unit
        // inline enrichText path below runs, so skills are never lost.
        let batchSkills: Map<string, ChunkEnrichment> | null = null;
        if (process.env.ENRICH_BATCH === '1' && this.enricher!.enrichBatch) {
            const runKey = `${repoFullName}/${userId}`.replace(/[^a-zA-Z0-9.-]/g, '-');
            try {
                const items = units.slice(0, cap).map((u) => ({
                    id: u.filePath, filePath: u.filePath, content: u.text, heading: u.chunks[0]?.heading,
                }));
                batchSkills = await this.enricher!.enrichBatch(items, runKey);
            } catch (err) {
                console.warn('[IngestionPipeline.enrichChunksPerFile] batch failed — falling back to inline:', err);
                batchSkills = null;
            }
        }

        const byKey = new Map<string, string[]>();   // `${filePath}::${chunkIndex}` -> skills
        const statusByKey = new Map<string, string>();
        let callsDone = 0;

        const enrichUnit = async (unitIdx: number): Promise<void> => {
            const unit = units[unitIdx];
            const tag = (status: string, skillsFor: (c: RawChunk) => string[]): void => {
                for (const c of unit.chunks) {
                    const key = `${c.filePath}::${c.chunkIndex}`;
                    statusByKey.set(key, status);
                    byKey.set(key, skillsFor(c));
                }
            };
            if (unitIdx >= cap) { tag('skipped_quota', () => []); return; }
            try {
                const fromBatch = batchSkills?.get(unit.filePath);
                const { skills } = fromBatch
                    ?? await this.enricher!.enrichText!(unit.filePath, unit.text, unit.chunks[0]?.heading);
                const assigned = assignSkillsToChunks(unit, skills, noExtraEvidence);
                const byIndex = new Map(assigned.map(a => [a.chunkIndex, a.skills]));
                tag('ok', (c) => byIndex.get(c.chunkIndex) ?? []);
            } catch (err) {
                console.error(`[IngestionPipeline.enrichChunksPerFile] failed for ${unit.filePath}:`, err);
                tag('failed', () => []);
            }
        };

        let next = 0;
        const currentCtx = context.active();
        await Promise.all(
            Array.from({ length: Math.min(ENRICHMENT_CONCURRENCY, units.length) }, () =>
                context.with(currentCtx, async () => {
                    while (true) {
                        const myIdx = next++;
                        if (myIdx >= units.length) return;
                        await enrichUnit(myIdx);
                        callsDone++;
                        if (callsDone % EMBED_PROGRESS_LOG_EVERY === 0 || callsDone === units.length) {
                            await this.syncState
                                .markPhase(userId, repoFullName, 'enriching', callsDone, units.length)
                                .catch(() => { /* advisory progress */ });
                        }
                    }
                }),
            ),
        );

        // SC-001/SC-002 measurability: model calls ≈ files, not chunks.
        console.info(
            `[IngestionPipeline] per-file enrichment: ${units.length} model calls ` +
            `for ${chunks.length} chunks (${(chunks.length / Math.max(units.length, 1)).toFixed(1)}x fewer)`,
        );

        return chunks.map((c) => {
            const key = `${c.filePath}::${c.chunkIndex}`;
            return {
                ...c,
                skills:       byKey.get(key) ?? [],
                technologies: [],
                metadata: { ...(c.metadata ?? {}), enrichment_status: statusByKey.get(key) ?? 'ok' },
            };
        });
    }

    /** Per-chunk Bedrock batch (feature 002 US3) — null when off/failed (caller uses inline). */
    private async tryChunkBatch(userId: string, repoFullName: string, chunks: RawChunk[], cap: number): Promise<Map<string, ChunkEnrichment> | null> {
        if (process.env.ENRICH_BATCH !== '1' || !this.enricher!.enrichBatch) return null;
        const runKey = `${repoFullName}/${userId}`.replace(/[^a-zA-Z0-9.-]/g, '-');
        try {
            const items = chunks.slice(0, cap).map((c) => ({
                id: `${c.filePath}::${c.chunkIndex}`, filePath: c.filePath, content: c.content, heading: c.heading,
            }));
            return await this.enricher!.enrichBatch(items, runKey);
        } catch (err) {
            console.warn('[IngestionPipeline.enrichChunks] batch failed — falling back to inline:', err);
            return null;
        }
    }

    /**
     * Packed enrichment (feature 004): group chunks into packs, one model call
     * per pack via enrichPack, attribute skills back BY KEY (filePath::chunkIndex
     * — never positional). Missing keys (model dropped/short) and whole-pack
     * transport errors fall back to per-chunk enrich, so skills are never lost or
     * mis-mapped. Calls ≈ chunks / packSize.
     */
    private async enrichChunksPacked(userId: string, repoFullName: string, chunks: RawChunk[]): Promise<RawChunk[]> {
        const cap = this.maxEnrichmentPerRun;
        const packSize = Number.parseInt(process.env.ENRICH_PACK_SIZE ?? '20', 10) || 20;
        const maxChars = Number.parseInt(process.env.ENRICH_PACK_MAX_CHARS ?? '24000', 10) || 24_000;
        const out: RawChunk[] = new Array(chunks.length);
        const keyOf = (c: RawChunk): string => `${c.filePath}::${c.chunkIndex}`;

        const idxByKey = new Map<string, number>();
        const packable: { key: string; filePath: string; content: string; heading?: string }[] = [];
        chunks.forEach((c, i) => {
            if (i >= cap) { out[i] = withMetadata(c, { enrichment_status: 'skipped_quota' }); return; }
            idxByKey.set(keyOf(c), i);
            packable.push({ key: keyOf(c), filePath: c.filePath, content: c.content, heading: c.heading });
        });
        const packs = packChunks(packable, packSize, maxChars);

        const enrichPackOne = async (pack: { items: { key: string; filePath: string; content: string; heading?: string }[] }): Promise<void> => {
            let result: Map<string, { skills: string[] }> | null = null;
            try {
                result = await this.enricher!.enrichPack!(pack.items);
            } catch (err) {
                console.warn('[IngestionPipeline.enrichChunksPacked] pack failed — per-chunk fallback:', err);
            }
            for (const item of pack.items) {
                const idx = idxByKey.get(item.key);
                if (idx === undefined) continue;
                try {
                    const fromPack = result?.get(item.key);
                    const { skills } = fromPack ?? await this.enricher!.enrich(chunks[idx]);   // missing key -> per-chunk
                    out[idx] = { ...chunks[idx], skills, technologies: [], metadata: { ...(chunks[idx].metadata ?? {}), enrichment_status: 'ok' } };
                } catch (err) {
                    console.error(`[IngestionPipeline.enrichChunksPacked] failed for ${item.key}:`, err);
                    out[idx] = withMetadata(chunks[idx], { enrichment_status: 'failed' });
                }
            }
        };

        let next = 0;
        const currentCtx = context.active();
        await Promise.all(
            Array.from({ length: Math.min(ENRICHMENT_CONCURRENCY, packs.length) }, () =>
                context.with(currentCtx, async () => {
                    while (true) {
                        const myIdx = next++;
                        if (myIdx >= packs.length) return;
                        await enrichPackOne(packs[myIdx]);
                        await this.syncState
                            .markPhase(userId, repoFullName, 'enriching', Math.min((myIdx + 1) * packSize, packable.length), packable.length)
                            .catch(() => { /* advisory progress */ });
                    }
                }),
            ),
        );

        console.info(
            `[IngestionPipeline] packed enrichment: ${packs.length} model calls for ${packable.length} chunks ` +
            `(~${(packable.length / Math.max(packs.length, 1)).toFixed(1)} per call)`,
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
