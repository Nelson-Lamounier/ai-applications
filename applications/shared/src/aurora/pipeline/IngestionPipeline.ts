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

import type { IEmbeddingProvider } from '../interfaces/IEmbeddingProvider.js';
import type { ISyncStateRepository } from '../interfaces/ISyncStateRepository.js';
import type { IVectorStore } from '../interfaces/IVectorStore.js';
import type {
    DocumentChunk,
    IngestionReport,
    RawChunk,
} from '../types.js';

export class IngestionPipeline {
    private readonly vectorStore: IVectorStore;
    private readonly syncState: ISyncStateRepository;
    private readonly embedder: IEmbeddingProvider;

    constructor(
        vectorStore: IVectorStore,
        syncState: ISyncStateRepository,
        embedder: IEmbeddingProvider,
    ) {
        this.vectorStore = vectorStore;
        this.syncState   = syncState;
        this.embedder    = embedder;
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

            const embeddedChunks: DocumentChunk[] = [];

            for (const { chunk, contentHash } of chunksToEmbed) {
                const embedText = this.buildEmbedText(chunk.content, repoFullName, chunk.filePath, chunk.heading);
                const embedding = await this.embedder.embed(embedText);

                embeddedChunks.push({
                    ...chunk,
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
}
