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

import type { IChunkEnricher } from '../interfaces/IChunkEnricher.js';
import type { IEmbeddingProvider } from '../interfaces/IEmbeddingProvider.js';
import type { ISyncStateRepository } from '../interfaces/ISyncStateRepository.js';
import type { IVectorStore } from '../interfaces/IVectorStore.js';
import type {
    DocumentChunk,
    IngestionReport,
    RawChunk,
} from '../types.js';

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
}

export class IngestionPipeline {
    private readonly vectorStore: IVectorStore;
    private readonly syncState: ISyncStateRepository;
    private readonly embedder: IEmbeddingProvider;
    private readonly enricher?: IChunkEnricher;
    private readonly maxEnrichmentPerRun: number;

    constructor(
        vectorStore: IVectorStore,
        syncState: ISyncStateRepository,
        embedder: IEmbeddingProvider,
        options: IngestionPipelineOptions = {},
    ) {
        this.vectorStore = vectorStore;
        this.syncState   = syncState;
        this.embedder    = embedder;
        this.enricher    = options.enricher;
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
            // -----------------------------------------------------------------
            // Step 1: Compute content hashes (CPU-only, no I/O)
            // -----------------------------------------------------------------
            const hashedChunks = rawChunks.map(chunk => ({
                chunk,
                contentHash: createHash('sha256').update(chunk.content).digest('hex'),
            }));

            // -----------------------------------------------------------------
            // Step 2: Classify chunks — single DB round-trip
            // -----------------------------------------------------------------
            const candidates = hashedChunks.map(({ chunk, contentHash }) => ({
                filePath:    chunk.filePath,
                chunkIndex:  chunk.chunkIndex,
                contentHash,
            }));

            const { missing, stale, unchanged } = await this.vectorStore.checkContentHashes(
                userId,
                repoFullName,
                candidates,
            );

            const unchangedSet = new Set(
                unchanged.map(c => `${c.filePath}::${c.chunkIndex}`),
            );

            // -----------------------------------------------------------------
            // Step 3: Embed missing + stale chunks (sequential)
            // Context preamble prepended to embed text only — stored content
            // stays clean. This gives the vector model repo/file/section signal
            // without polluting retrieval results.
            // -----------------------------------------------------------------
            const chunksToEmbed = hashedChunks.filter(
                ({ chunk, contentHash: _ }) =>
                    !unchangedSet.has(`${chunk.filePath}::${chunk.chunkIndex}`),
            );

            // -----------------------------------------------------------------
            // Step 3a: Enrich chunks with skill evidence (best-effort).
            // Hash-skipped chunks already filtered out above — re-running
            // extraction on identical content would waste tokens.
            // -----------------------------------------------------------------
            const enrichedChunks = await this.enrichChunks(
                chunksToEmbed.map(c => c.chunk),
            );
            const enrichedByKey = new Map(
                enrichedChunks.map(c => [`${c.filePath}::${c.chunkIndex}`, c] as const),
            );

            const embeddedChunks: DocumentChunk[] = [];

            for (const { chunk, contentHash } of chunksToEmbed) {
                const enriched = enrichedByKey.get(`${chunk.filePath}::${chunk.chunkIndex}`)
                    ?? chunk;
                const embedText = this.buildEmbedText(enriched.content, repoFullName, enriched.filePath, enriched.heading);
                const embedding = await this.embedder.embed(embedText);

                embeddedChunks.push({
                    ...enriched,
                    userId,
                    repoFullName,
                    contentHash,
                    embedding,
                });
            }

            // -----------------------------------------------------------------
            // Step 4: Upsert embedded chunks
            // -----------------------------------------------------------------
            const upsertResult = embeddedChunks.length > 0
                ? await this.vectorStore.upsertBatch(embeddedChunks)
                : { inserted: 0, updated: 0, skipped: 0, errors: 0 };

            // -----------------------------------------------------------------
            // Step 5: Prune chunks whose file no longer exists in the repo
            // -----------------------------------------------------------------
            const currentFilePaths = [...new Set(rawChunks.map(c => c.filePath))];
            const pruned = await this.vectorStore.pruneDeletedFiles(userId, repoFullName, currentFilePaths);

            // -----------------------------------------------------------------
            // Step 6: Record completion
            // -----------------------------------------------------------------
            const uniqueFiles = currentFilePaths.length;

            await this.syncState.markComplete(
                userId,
                repoFullName,
                uniqueFiles,
                rawChunks.length,
            );

            return {
                userId,
                repoFullName,
                totalRawChunks: rawChunks.length,
                embedded:       chunksToEmbed.length,
                skipped:        unchanged.length,
                pruned,
                upsertResult,
                durationMs:     Date.now() - startMs,
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
        await Promise.all(
            Array.from({ length: Math.min(ENRICHMENT_CONCURRENCY, total) }, async () => {
                while (true) {
                    const myIdx = next++;
                    if (myIdx >= total) return;
                    await enrichOne(myIdx);
                }
            }),
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
