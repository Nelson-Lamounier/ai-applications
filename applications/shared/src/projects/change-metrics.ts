/**
 * @format
 * change-metrics — deterministic Layer-1 change facts from a commit's diff.
 *
 * The ONLY sanctioned source of numbers for change-impact narration (see the
 * grounding contract in docs/superpowers/specs/2026-06-17-commit-diff-grounded-impact.md).
 * These are computed, never estimated: an LLM may narrate these figures but may
 * not invent a number absent from them. Pure — no I/O, no clock, no randomness.
 */

import type { CommitDetail } from '../ingestion/interfaces/IRepoAdapter.js';

export interface CommitChangeMetrics {
    readonly sha: string;
    /** additions - deletions — net lines added. */
    readonly locDelta: number;
    /** additions + deletions — total lines touched (code churn). */
    readonly churn: number;
    readonly filesChanged: number;
    /** File count per GitHub status (added|modified|removed|renamed|…). */
    readonly byStatus: Record<string, number>;
}

/** Reduce a commit's detail to its deterministic structural change facts. */
export function summariseCommitChange(detail: CommitDetail): CommitChangeMetrics {
    const byStatus: Record<string, number> = {};
    for (const f of detail.files) {
        byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
    }
    return {
        sha:          detail.sha,
        locDelta:     detail.additions - detail.deletions,
        churn:        detail.additions + detail.deletions,
        filesChanged: detail.filesChanged,
        byStatus,
    };
}
