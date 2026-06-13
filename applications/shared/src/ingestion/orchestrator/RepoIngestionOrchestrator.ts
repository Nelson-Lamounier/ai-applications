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
 * Concurrent file fetching:
 *   Files are fetched through a bounded-concurrency worker pool
 *   (FILE_FETCH_CONCURRENCY, default 8). File fetch is I/O-bound (network
 *   round-trip per file), so concurrency cuts a ~2 min sequential fetch of a
 *   few hundred files to ~20s with no extra CPU. Keep the pool small enough to
 *   stay under GitHub's secondary (concurrent-request) rate limit. Each fetch
 *   keeps its own try/catch — one unreadable file never aborts the run. Results
 *   are written into a per-file slot by index so chunk/file ordering is
 *   deterministic despite concurrency.
 */

import type { IngestionReport, RawChunk } from '../../rds/types.js';
import type { IngestionPipeline } from '../../rds/pipeline/IngestionPipeline.js';
import type { IFileFilter }   from '../interfaces/IFileFilter.js';
import type { IRepoAdapter, RepoCommit, RepoPullRequest, RepoFile }  from '../interfaces/IRepoAdapter.js';
import type { ChunkerRegistry }    from '../implementations/ChunkerRegistry.js';
import { CommitChunker }      from '../implementations/CommitChunker.js';
import { deriveRepoSignals }  from '../../projects/repo-signals.js';
import { deriveEvidenceTopology } from '../../projects/evidence-topology.js';

/**
 * Bounded concurrency for GitHub file fetches. Override via
 * FILE_FETCH_CONCURRENCY. Keep small enough to avoid GitHub's secondary
 * (concurrent-request) rate limit.
 */
const FILE_FETCH_CONCURRENCY = (() => {
    const raw = process.env.FILE_FETCH_CONCURRENCY;
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n >= 1 ? n : 8;
})();

/**
 * Per-file blob-sha state for incremental resync — RdsRepoFileStateRepository
 * in production. Structural type so the orchestrator stays decoupled from the
 * concrete repository (same spirit as {@link RepoActivityStore}).
 */
export interface RepoFileStateStore {
    getFileState(userId: string, repoFullName: string): Promise<Map<string, string>>;
    upsertFileState(userId: string, repoFullName: string, files: readonly { path: string; blobSha: string; sizeBytes: number }[]): Promise<void>;
    deleteFileState(userId: string, repoFullName: string): Promise<void>;
}

/**
 * Last-synced HEAD commit watermark for tier-1 skip — RdsSyncStateRepository in
 * production. Structural type, same decoupling rationale as above.
 */
export interface CommitWatermarkStore {
    getLastSyncedCommitSha(userId: string, repoFullName: string): Promise<string | null>;
    setLastSyncedCommitSha(userId: string, repoFullName: string, sha: string): Promise<void>;
}

/** Structured commit/PR persistence — RdsRepoActivityStore in production. */
export interface RepoActivityStore {
    upsertCommits(userId: string, repositoryId: string, repoFullName: string, commits: readonly RepoCommit[]): Promise<number>;
    upsertPullRequests(userId: string, repositoryId: string, repoFullName: string, pulls: readonly RepoPullRequest[]): Promise<number>;
}

export interface OrchestratorOptions {
    /**
     * When provided, the orchestrator pulls the last N commits from the
     * repo (default 500), groups them by ISO week via this chunker, and
     * ingests the resulting chunks alongside file content. Pass `null` to
     * disable commit-history ingestion entirely.
     */
    readonly commitChunker?: CommitChunker | null;
    /** Hard cap on commits pulled per ingestion. Default 500. */
    readonly maxCommits?:    number;
    /** When provided (with repositoryId), structured commits + PRs are persisted. */
    readonly activityStore?: RepoActivityStore;
    /** repositories.id for the repo being ingested — required to persist activity. */
    readonly repositoryId?: string;
    /** Hard cap on PRs pulled per ingestion. Default 100. */
    readonly maxPullRequests?: number;
    /**
     * When provided, the orchestrator derives the 46-signal archetype map from
     * the repo's full file tree and persists it. Structural type (not the
     * concrete RdsSyncStateRepository) so this stays decoupled — same spirit as
     * {@link RepoActivityStore}. Best-effort: persist failures never abort a run.
     */
    readonly syncStateSignalSink?: {
        saveArchetypeSignals(userId: string, repoFullName: string, signals: Record<string, boolean>): Promise<void>;
        /** Optional: persist the evidence topology (scripts + DB migrations + monorepo). */
        saveEvidenceTopology?(userId: string, repoFullName: string, topology: Record<string, unknown>): Promise<void>;
    };
    /**
     * When provided together with {@link watermarkStore}, ingestRepo runs an
     * incremental two-tier resync: tier 1 skips fetching entirely when HEAD is
     * unchanged, tier 2 fetches only files whose blob sha differs from the
     * persisted state. Absent either store, ingestRepo fetches all included
     * files (degradable to today's behavior).
     */
    readonly fileStateStore?: RepoFileStateStore;
    /** HEAD-commit watermark store — see {@link fileStateStore}. */
    readonly watermarkStore?: CommitWatermarkStore;
}

export class RepoIngestionOrchestrator {
    private readonly repoAdapter:       IRepoAdapter;
    private readonly fileFilter:        IFileFilter;
    private readonly chunkerRegistry:   ChunkerRegistry;
    private readonly ingestionPipeline: IngestionPipeline;
    private readonly commitChunker:     CommitChunker | null;
    private readonly maxCommits:        number;
    private readonly activityStore:     RepoActivityStore | null;
    private readonly repositoryId:      string | null;
    private readonly maxPullRequests:   number;
    private readonly syncStateSignalSink: OrchestratorOptions['syncStateSignalSink'] | null;
    private readonly fileStateStore:    RepoFileStateStore | null;
    private readonly watermarkStore:    CommitWatermarkStore | null;

    constructor(
        repoAdapter:       IRepoAdapter,
        fileFilter:        IFileFilter,
        chunkerRegistry:   ChunkerRegistry,
        ingestionPipeline: IngestionPipeline,
        options:           OrchestratorOptions = {},
    ) {
        this.repoAdapter       = repoAdapter;
        this.fileFilter        = fileFilter;
        this.chunkerRegistry   = chunkerRegistry;
        this.ingestionPipeline = ingestionPipeline;
        // Default ON: caller passes `null` to opt out.
        this.commitChunker     = options.commitChunker === null
            ? null
            : (options.commitChunker ?? new CommitChunker());
        this.maxCommits        = options.maxCommits ?? 500;
        this.activityStore     = options.activityStore ?? null;
        this.repositoryId      = options.repositoryId ?? null;
        this.maxPullRequests   = options.maxPullRequests ?? 100;
        this.syncStateSignalSink = options.syncStateSignalSink ?? null;
        this.fileStateStore    = options.fileStateStore ?? null;
        this.watermarkStore    = options.watermarkStore ?? null;
    }

    // =========================================================================
    // ingestRepo
    // =========================================================================

    /**
     * List, filter, fetch, chunk, and ingest all relevant files in a repo.
     *
     * @param userId       - Owner of the ingested content
     * @param repoFullName - "owner/repo" format
     * @param onFileProgress - optional callback fired during file fetch with
     *                         (fetched, total) so callers can surface progress.
     */
    async ingestRepo(
        userId: string,
        repoFullName: string,
        onFileProgress?: (fetched: number, total: number) => void,
        prefetchedFiles?: RepoFile[],
    ): Promise<IngestionReport> {
        // -----------------------------------------------------------------
        // Step 1: List all files in the repo (reuse the caller's tree when
        // provided — profile collection already fetched it this run).
        // -----------------------------------------------------------------
        const allFiles = prefetchedFiles ?? await this.repoAdapter.listFiles(repoFullName);

        // Derive + persist archetype signals from the FULL file tree (best-effort).
        await this.persistArchetypeSignals(userId, repoFullName, allFiles);

        // -----------------------------------------------------------------
        // Step 2: Filter — exclude noise, apply size limit
        // filterWithSize passes sizeBytes so files > maxSizeBytes are dropped
        // before any content is fetched — saves GitHub API quota and bandwidth.
        // -----------------------------------------------------------------
        const includedPaths = this.fileFilter.filterWithSize(allFiles);   // string[]
        const includedSet   = new Set(includedPaths);
        const includedFiles = allFiles.filter(f => includedSet.has(f.path)); // {path,sizeBytes,blobSha}[]

        if (includedPaths.length === 0) {
            console.warn(
                `[RepoIngestionOrchestrator] no files matched the filter for ${repoFullName}`,
            );
        }

        // -----------------------------------------------------------------
        // Step 2.5: Decide which files to actually fetch.
        //  - default (first sync / no stores wired): all included paths.
        //  - tier 1: HEAD unchanged + state present → fetch nothing.
        //  - tier 2: fetch only files whose blob sha differs (new or changed).
        // headSha / includedFiles / pathsToFetch are LOCALS — never instance
        // fields — so concurrent ingestions of different repos never collide.
        // -----------------------------------------------------------------
        let pathsToFetch: string[] = includedPaths;
        let tier1Skip = false;
        let headSha: string | null = null;
        if (this.fileStateStore && this.watermarkStore) {
            headSha          = await this.repoAdapter.getHeadCommitSha(repoFullName);
            const lastSha    = await this.watermarkStore.getLastSyncedCommitSha(userId, repoFullName);
            const priorState = await this.fileStateStore.getFileState(userId, repoFullName);
            if (lastSha && lastSha === headSha && priorState.size > 0) {
                pathsToFetch = [];                 // Tier 1: HEAD unchanged
                tier1Skip = true;
            } else {
                pathsToFetch = includedFiles
                    .filter(f => priorState.get(f.path) !== f.blobSha)  // new or changed
                    .map(f => f.path);
            }
        }

        // -----------------------------------------------------------------
        // Step 3: Fetch content + chunk (bounded-concurrency — see class doc)
        // -----------------------------------------------------------------
        const rawChunks = await this.fetchAndChunkFiles(
            repoFullName, pathsToFetch, onFileProgress,
        );

        console.info(
            `[RepoIngestionOrchestrator] ${repoFullName}: ${allFiles.length} files total, ` +
            `${includedPaths.length} included, ${pathsToFetch.length} to fetch (tier1Skip=${tier1Skip})`,
        );

        // -----------------------------------------------------------------
        // Step 3.5: Pull commits + chunk by ISO week.
        // Independent of file ingestion — failures here log and continue
        // so a token-scope problem does not abort the whole run.
        // -----------------------------------------------------------------
        const commitChunks = await this.fetchAndChunkCommits(userId, repoFullName);
        rawChunks.push(...commitChunks);
        await this.fetchAndPersistPulls(userId, repoFullName);

        // -----------------------------------------------------------------
        // Step 4: Hand off to IngestionPipeline (hash-check → embed → upsert).
        // Pass the FULL included path set so unchanged files (not re-fetched
        // this run) are NOT pruned from the vector store.
        // -----------------------------------------------------------------
        const report = await this.ingestionPipeline.ingestChunks(
            userId, repoFullName, rawChunks, { knownFilePaths: includedPaths },
        );

        // -----------------------------------------------------------------
        // Step 5: Persist file state + watermark (only when stores wired).
        // -----------------------------------------------------------------
        if (this.fileStateStore && this.watermarkStore && headSha !== null) {
            await this.fileStateStore.upsertFileState(userId, repoFullName,
                includedFiles.map(f => ({ path: f.path, blobSha: f.blobSha, sizeBytes: f.sizeBytes })));
            await this.watermarkStore.setLastSyncedCommitSha(userId, repoFullName, headSha);
        }

        return report;
    }

    /**
     * Fetch + chunk every path through a bounded-concurrency worker pool.
     *
     * Order-preserving: each path's chunks are written into a pre-sized slot by
     * index, then flattened, so the resulting RawChunk[] is identical to the
     * old sequential order regardless of completion order. Per-file try/catch
     * keeps a single unreadable file from aborting the run.
     *
     * @param onFileProgress - fired with (fetched, total) every 25 files and on
     *                         the last, so callers can surface fetch progress.
     */
    private async fetchAndChunkFiles(
        repoFullName: string,
        includedPaths: string[],
        onFileProgress?: (fetched: number, total: number) => void,
    ): Promise<RawChunk[]> {
        const fileTotal = includedPaths.length;
        const perFileChunks: RawChunk[][] = new Array(fileTotal);

        let next = 0;
        let fileDone = 0;
        onFileProgress?.(0, fileTotal);

        const fetchOne = async (idx: number): Promise<void> => {
            const filePath = includedPaths[idx]!;
            try {
                const content = await this.repoAdapter.fetchFile(repoFullName, filePath);
                perFileChunks[idx] = this.chunkerRegistry.chunk(content, filePath);
            } catch (err) {
                // Non-fatal — log and continue. One unreadable file should not
                // abort the entire repo ingestion.
                console.error(
                    `[RepoIngestionOrchestrator] failed to fetch/chunk ${filePath}:`,
                    err,
                );
                perFileChunks[idx] = [];
            }
            fileDone++;
            // Report every 25 files (and on the last) — keeps the UI moving
            // without hammering the progress sink.
            if (fileDone % 25 === 0 || fileDone === fileTotal) onFileProgress?.(fileDone, fileTotal);
        };

        await Promise.all(
            Array.from({ length: Math.min(FILE_FETCH_CONCURRENCY, fileTotal) }, async () => {
                while (true) {
                    const myIdx = next++;
                    if (myIdx >= fileTotal) return;
                    await fetchOne(myIdx);
                }
            }),
        );

        const rawChunks: RawChunk[] = [];
        for (let i = 0; i < fileTotal; i++) rawChunks.push(...perFileChunks[i]!);
        return rawChunks;
    }

    /**
     * Pull commit history and produce weekly RawChunks.
     * Best-effort: any failure (auth, rate limit) logs and returns []
     * so file-content ingestion still completes.
     */
    private async fetchAndChunkCommits(userId: string, repoFullName: string): Promise<RawChunk[]> {
        if (!this.commitChunker) return [];

        try {
            const commits = await this.repoAdapter.listCommits(
                repoFullName,
                { maxCommits: this.maxCommits },
            );
            if (this.activityStore && this.repositoryId) {
                await this.activityStore.upsertCommits(userId, this.repositoryId, repoFullName, commits);
            }
            const chunks = this.commitChunker.chunkWeekly(commits);
            console.info(
                `[RepoIngestionOrchestrator] ${repoFullName}: ` +
                `${commits.length} commits → ${chunks.length} commit-history chunks`,
            );
            return chunks;
        } catch (err) {
            console.error(
                `[RepoIngestionOrchestrator] commit history unavailable for ${repoFullName}:`,
                err,
            );
            return [];
        }
    }

    /**
     * Pull pull-request metadata and persist it via the activity store.
     * Best-effort: PRs produce no RawChunks, and any failure (auth, rate
     * limit, missing adapter capability) logs and returns so commit + file
     * ingestion still completes. No-op when no store/repositoryId is wired.
     */
    private async fetchAndPersistPulls(userId: string, repoFullName: string): Promise<void> {
        if (!this.activityStore || !this.repositoryId) return;
        if (typeof this.repoAdapter.listPullRequests !== 'function') return;
        try {
            const pulls = await this.repoAdapter.listPullRequests(
                repoFullName,
                { maxPullRequests: this.maxPullRequests },
            );
            await this.activityStore.upsertPullRequests(userId, this.repositoryId, repoFullName, pulls);
            console.info(
                `[RepoIngestionOrchestrator] ${repoFullName}: persisted ${pulls.length} pull requests`,
            );
        } catch (err) {
            console.warn(
                `[RepoIngestionOrchestrator] pull-request ingestion skipped for ${repoFullName}:`,
                err,
            );
        }
    }

    /**
     * Derive the 46-signal archetype map from the repo's FULL file tree and
     * persist it via the optional sink. Best-effort: any failure (derivation or
     * persistence) is logged and swallowed so it never aborts ingestion. No-op
     * when no sink is wired.
     */
    private async persistArchetypeSignals(
        userId: string,
        repoFullName: string,
        allFiles: readonly { path: string }[],
    ): Promise<void> {
        if (!this.syncStateSignalSink) return;
        try {
            const fileList = allFiles.map((f) => ({ path: f.path }));
            const signals = deriveRepoSignals(fileList, { projectShape: undefined });
            await this.syncStateSignalSink.saveArchetypeSignals(userId, repoFullName, signals);
            // Evidence topology — needs package.json content (scripts) + the full tree
            // (DB migrations across ecosystems). Best-effort; package.json may be absent.
            if (this.syncStateSignalSink.saveEvidenceTopology) {
                const pkg = await this.fetchPackageJson(repoFullName);
                const topology = deriveEvidenceTopology(fileList, pkg);
                await this.syncStateSignalSink.saveEvidenceTopology(userId, repoFullName, { ...topology });
            }
        } catch (err) {
            console.warn(
                `[RepoIngestionOrchestrator] archetype-signal persist skipped for ${repoFullName}:`,
                err,
            );
        }
    }

    /** Fetch + parse the repo-root package.json (null when absent or unparseable). */
    private async fetchPackageJson(repoFullName: string): Promise<Record<string, unknown> | null> {
        try {
            const content = await this.repoAdapter.fetchFile(repoFullName, 'package.json');
            if (!content) return null;
            const parsed: unknown = JSON.parse(content);
            return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
        } catch {
            return null;
        }
    }

    // =========================================================================
    // forceReindex
    // =========================================================================

    /**
     * Delete all existing chunks for a repo, then re-ingest from scratch.
     * Use when the chunking strategy has changed significantly.
     */
    async forceReindex(userId: string, repoFullName: string, prefetchedFiles?: RepoFile[]): Promise<IngestionReport> {
        console.info(
            `[RepoIngestionOrchestrator] force re-index: ${repoFullName}`,
        );

        // Clear incremental state up front so a partial/failed run can never
        // leave a stale watermark that would tier-1-skip the next ingestion.
        if (this.fileStateStore)  await this.fileStateStore.deleteFileState(userId, repoFullName);
        if (this.watermarkStore)  await this.watermarkStore.setLastSyncedCommitSha(userId, repoFullName, '');

        const allFiles     = prefetchedFiles ?? await this.repoAdapter.listFiles(repoFullName);

        // Derive + persist archetype signals from the FULL file tree (best-effort).
        await this.persistArchetypeSignals(userId, repoFullName, allFiles);

        const includedPaths = this.fileFilter.filterWithSize(allFiles);
        const includedSet   = new Set(includedPaths);
        const includedFiles = allFiles.filter(f => includedSet.has(f.path));
        const rawChunks    = await this.fetchAndChunkFiles(repoFullName, includedPaths);

        // Mirror Step 3.5 from ingestRepo — re-ingest commit history too.
        rawChunks.push(...await this.fetchAndChunkCommits(userId, repoFullName));
        await this.fetchAndPersistPulls(userId, repoFullName);

        const report = await this.ingestionPipeline.forceReindex(userId, repoFullName, rawChunks);

        // Refresh state + watermark to the just-synced tree (only when wired).
        if (this.fileStateStore && this.watermarkStore) {
            await this.fileStateStore.upsertFileState(userId, repoFullName,
                includedFiles.map(f => ({ path: f.path, blobSha: f.blobSha, sizeBytes: f.sizeBytes })));
            await this.watermarkStore.setLastSyncedCommitSha(
                userId, repoFullName, await this.repoAdapter.getHeadCommitSha(repoFullName));
        }

        return report;
    }
}
