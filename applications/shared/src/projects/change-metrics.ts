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
import type { FileChange } from '../rds/implementations/RdsRepoActivityStore.js';

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

/**
 * Decision-point keywords + boolean operators counted as +1 cyclomatic
 * complexity each. A deterministic proxy (not a true AST CC): it counts
 * branch/loop constructs in the changed hunks, which is enough to ground a
 * "this change added/removed N branches" claim honestly. Covers C-family and
 * Python (if/elif/for/while/case/catch/when) plus `&&` / `||`.
 */
const DECISION_RE = /\b(?:if|elif|for|while|case|catch|when)\b|&&|\|\|/g;

function decisionPoints(codeLine: string): number {
    return (codeLine.match(DECISION_RE) ?? []).length;
}

/**
 * Net cyclomatic-complexity delta from a unified-diff patch: decision points
 * on added (`+`) lines minus those on removed (`-`) lines. Diff headers
 * (`+++`/`---`/`@@`) and context lines are ignored. Pure; null/empty → 0.
 * A negative result means the change simplified control flow.
 */
export function cyclomaticComplexityDelta(patch: string | null): number {
    if (!patch) return 0;
    let delta = 0;
    for (const line of patch.split('\n')) {
        if (line.startsWith('+++') || line.startsWith('---')) continue;
        if (line.startsWith('+')) delta += decisionPoints(line.slice(1));
        else if (line.startsWith('-')) delta -= decisionPoints(line.slice(1));
    }
    return delta;
}

/** Grounded change-impact facts for one file, aggregated over its history. */
export interface FileChangeImpact {
    readonly filePath: string;
    readonly changeCount: number;
    /** Total lines touched across all changes (additions + deletions). */
    readonly churn: number;
    /** Net lines added across all changes (additions - deletions). */
    readonly netLoc: number;
    /** Summed cyclomatic-complexity delta across all stored patches. */
    readonly complexityDelta: number;
    /** ISO timestamp of the most recent change, or null if none. */
    readonly lastChangedAt: string | null;
}

/**
 * Aggregate a file's stored change history (from getFileChanges) into the
 * deterministic fact bundle the inc-3 narration agent is allowed to cite.
 * Pure — operates only on the provided rows.
 */
export function buildFileChangeImpact(filePath: string, changes: readonly FileChange[]): FileChangeImpact {
    let churn = 0;
    let netLoc = 0;
    let complexityDelta = 0;
    let lastChangedAt: string | null = null;
    for (const c of changes) {
        churn += c.additions + c.deletions;
        netLoc += c.additions - c.deletions;
        complexityDelta += cyclomaticComplexityDelta(c.patch);
        if (lastChangedAt === null || c.authoredAt > lastChangedAt) lastChangedAt = c.authoredAt;
    }
    return { filePath, changeCount: changes.length, churn, netLoc, complexityDelta, lastChangedAt };
}
