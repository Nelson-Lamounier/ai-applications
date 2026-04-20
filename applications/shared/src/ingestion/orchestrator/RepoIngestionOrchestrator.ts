/**
 * @format
 * RepoIngestionOrchestrator — Top-Level Coordinator
 *
 * Coordinates the full repo-to-vector-store pipeline:
 *   IRepoAdapter   → listFiles + fetchFile
 *   IFileFilter    → exclude noise, limit to relevant file types
 *   ChunkerRegistry → split content into RawChunk[]
 *   IngestionPipeline → hash-check → embed → upsert
 *
 * This class owns only coordination logic. Each step is delegated to its
 * interface — no SQL, no GitHub API calls, no Bedrock calls here.
 *
 * Sequential file fetching:
 *   Files are fetched from GitHub one at a time. GitHub's API rate limit
 *   (5000 req/hour authenticated) is not a concern at portfolio scale
 *   (< 200 files per repo). If throughput becomes a concern, introduce a
 *   concurrency limit of 3–5 parallel fetchFile() calls using a semaphore.
 */

import type { IngestionReport } from '../../aurora/types.js';
import { IngestionPipeline } from '../../aurora/pipeline/IngestionPipeline.js';
import type { IFileFilter }   from '../interfaces/IFileFilter.js';
import type { IRepoAdapter }  from '../interfaces/IRepoAdapter.js';
import { ChunkerRegistry }    from '../implementations/ChunkerRegistry.js';

export class RepoIngestionOrchestrator {
    private readonly repoAdapter:       IRepoAdapter;
    private readonly fileFilter:        IFileFilter;
    private readonly chunkerRegistry:   ChunkerRegistry;
    private readonly ingestionPipeline: IngestionPipeline;

    constructor(
        repoAdapter:       IRepoAdapter,
        fileFilter:        IFileFilter,
        chunkerRegistry:   ChunkerRegistry,
        ingestionPipeline: IngestionPipeline,
    ) {
        this.repoAdapter       = repoAdapter;
        this.fileFilter        = fileFilter;
        this.chunkerRegistry   = chunkerRegistry;
        this.ingestionPipeline = ingestionPipeline;
    }

    // =========================================================================
    // ingestRepo
    // =========================================================================

    /**
     * List, filter, fetch, chunk, and ingest all relevant files in a repo.
     *
     * @param userId       - Owner of the ingested content
     * @param repoFullName - "owner/repo" format
     */
    async ingestRepo(userId: string, repoFullName: string): Promise<IngestionReport> {
        // -----------------------------------------------------------------
        // Step 1: List all files in the repo (single API call via tree API)
        // -----------------------------------------------------------------
        const allFiles = await this.repoAdapter.listFiles(repoFullName);

        // -----------------------------------------------------------------
        // Step 2: Filter — exclude noise, apply size limit
        // -----------------------------------------------------------------
        const includedPaths = this.fileFilter.filter(allFiles.map(f => f.path));

        if (includedPaths.length === 0) {
            console.warn(
                `[RepoIngestionOrchestrator] no files matched the filter for ${repoFullName}`,
            );
        }

        console.info(
            `[RepoIngestionOrchestrator] ${repoFullName}: ` +
            `${allFiles.length} files total, ${includedPaths.length} to ingest`,
        );

        // -----------------------------------------------------------------
        // Step 3: Fetch content + chunk (sequential — see class doc)
        // -----------------------------------------------------------------
        const rawChunks = [];

        for (const filePath of includedPaths) {
            try {
                const content = await this.repoAdapter.fetchFile(repoFullName, filePath);
                const chunks  = this.chunkerRegistry.chunk(content, filePath);
                rawChunks.push(...chunks);
            } catch (err) {
                // Non-fatal — log and continue. One unreadable file should not
                // abort the entire repo ingestion.
                console.error(
                    `[RepoIngestionOrchestrator] failed to fetch/chunk ${filePath}:`,
                    err,
                );
            }
        }

        console.info(
            `[RepoIngestionOrchestrator] ${repoFullName}: ` +
            `${rawChunks.length} chunks from ${includedPaths.length} files`,
        );

        // -----------------------------------------------------------------
        // Step 4: Hand off to IngestionPipeline (hash-check → embed → upsert)
        // -----------------------------------------------------------------
        return this.ingestionPipeline.ingestChunks(userId, repoFullName, rawChunks);
    }

    // =========================================================================
    // forceReindex
    // =========================================================================

    /**
     * Delete all existing chunks for a repo, then re-ingest from scratch.
     * Use when the chunking strategy has changed significantly.
     */
    async forceReindex(userId: string, repoFullName: string): Promise<IngestionReport> {
        console.info(
            `[RepoIngestionOrchestrator] force re-index: ${repoFullName}`,
        );

        const allFiles     = await this.repoAdapter.listFiles(repoFullName);
        const includedPaths = this.fileFilter.filter(allFiles.map(f => f.path));
        const rawChunks    = [];

        for (const filePath of includedPaths) {
            try {
                const content = await this.repoAdapter.fetchFile(repoFullName, filePath);
                rawChunks.push(...this.chunkerRegistry.chunk(content, filePath));
            } catch (err) {
                console.error(
                    `[RepoIngestionOrchestrator] failed to fetch/chunk ${filePath}:`,
                    err,
                );
            }
        }

        return this.ingestionPipeline.forceReindex(userId, repoFullName, rawChunks);
    }
}
