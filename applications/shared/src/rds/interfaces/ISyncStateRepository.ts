/**
 * @format
 * ISyncStateRepository — Repo Sync State Persistence Contract
 *
 * Tracks ingestion status per (userId, repoFullName) pair.
 * The pipeline calls markStarted at the top of every run and
 * markComplete / markError at the end, regardless of implementation.
 */

import type { RepoSyncState, IngestionPhase } from '../types.js';

export interface ISyncStateRepository {
    /** Fetch current sync state. Returns undefined if the repo has never been synced. */
    get(userId: string, repoFullName: string): Promise<RepoSyncState | undefined>;

    /** Write or overwrite sync state for a (userId, repoFullName) pair. */
    upsert(state: RepoSyncState): Promise<void>;

    /** Shorthand: set status to 'syncing', reset counts. */
    markStarted(userId: string, repoFullName: string): Promise<void>;

    /**
     * Update the current pipeline phase and (optionally) a done/total within
     * that phase, so the UI can show a labelled, continuously-advancing
     * indicator across ALL phases — not just embedding. Omit done/total for
     * indeterminate phases (e.g. 'analyzing'). Best-effort, lightweight (one
     * UPDATE); callers invoke it at phase boundaries + periodically within a
     * phase. Status stays 'syncing'.
     */
    markPhase(
        userId: string,
        repoFullName: string,
        phase: IngestionPhase,
        done?: number,
        total?: number,
    ): Promise<void>;

    /**
     * Shorthand: set status to 'complete', record final file/chunk counts
     * and (optionally) the computed KB quality score and per-factor
     * breakdown. Both quality fields are nullable for back-compat with
     * runs that pre-date pick #4 (KB quality scoring).
     * retrievalScore / retrievalBreakdown are nullable for back-compat with
     * runs that pre-date the retrieval-quality probe.
     */
    markComplete(
        userId: string,
        repoFullName: string,
        fileCount: number,
        chunkCount: number,
        kbQualityScore?: number,
        kbQualityBreakdown?: Record<string, unknown>,
        retrievalScore?: number,
        retrievalBreakdown?: Record<string, unknown>,
    ): Promise<void>;

    /**
     * Persist the derived 46-signal archetype map (see repo-signals.ts) onto
     * the repo_sync_state row for this (userId, repoFullName). Best-effort:
     * a no-op if the row does not yet exist.
     */
    saveArchetypeSignals(
        userId: string,
        repoFullName: string,
        signals: Record<string, boolean>,
    ): Promise<void>;

    /**
     * Read the last-synced commit SHA watermark for this (userId, repoFullName).
     * Returns null when no row exists or the column has not been set yet
     * (e.g. runs that pre-date migration 048).
     */
    getLastSyncedCommitSha(userId: string, repoFullName: string): Promise<string | null>;

    /**
     * Persist the last-synced commit SHA watermark onto the existing
     * repo_sync_state row. No-op safe: a no-op if the row does not yet exist.
     */
    setLastSyncedCommitSha(userId: string, repoFullName: string, sha: string): Promise<void>;

    /** Shorthand: set status to 'error', record the failure reason. */
    markError(
        userId: string,
        repoFullName: string,
        errorMessage: string,
    ): Promise<void>;
}
