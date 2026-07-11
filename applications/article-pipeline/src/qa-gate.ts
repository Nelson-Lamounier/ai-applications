/**
 * @format
 * qa-gate.ts
 *
 * Pure decision logic for the QA gate: whether a verdict passes, how many
 * retries are allowed (hard-bounded so the pipeline can never loop forever),
 * how each attempt is snapshotted for the durable failure record, and how a
 * failed verdict becomes concrete Writer feedback. The orchestration (calling
 * the Writer/QA agents in a loop) lives in run-pipeline.ts and consumes these;
 * keeping the logic here makes it unit-testable without invoking Bedrock.
 */
import type { QaValidationResult } from '@bedrock/shared';

/** Absolute ceiling on retries — the pipeline can never exceed this. */
export const QA_RETRY_HARD_CAP = 2;

/** One QA attempt, captured for pipeline_runs.metadata.qaGate (queryable audit). */
export interface QaAttempt {
    attempt:          number;
    overallScore:     number;
    recommendation:   string;
    passed:           boolean;
    failedDimensions: string[];
    issues:           Array<{ dimension: string; severity: string; location: string; description: string; fix: string }>;
}

/** Full gate history: every attempt plus the terminal pass/flag decision. */
export interface QaGateResult {
    attempts:     QaAttempt[];
    passed:       boolean;
    finalAttempt: number;
    maxRetries:   number;
}

/**
 * Resolve the retry budget from config, clamped to [0, {@link QA_RETRY_HARD_CAP}].
 * Any missing, non-numeric, negative or oversized value collapses to a safe
 * bound, so no configuration can produce an unbounded loop.
 */
export function resolveMaxRetries(raw: string | undefined): number {
    const parsed = Number.parseInt(raw ?? String(QA_RETRY_HARD_CAP), 10);
    if (!Number.isFinite(parsed)) return QA_RETRY_HARD_CAP;
    return Math.min(QA_RETRY_HARD_CAP, Math.max(0, parsed));
}

/** Pass = the model did not reject AND the weighted score cleared the threshold. */
export function qaPassed(qa: QaValidationResult, threshold: number): boolean {
    return qa.recommendation !== 'reject' && qa.overallScore >= threshold;
}

/** Snapshot one attempt for the durable failure record. */
export function recordAttempt(attempt: number, qa: QaValidationResult, threshold: number): QaAttempt {
    const issues = Object.entries(qa.dimensions).flatMap(([dimension, dim]) =>
        dim.issues.map((i) => ({
            dimension, severity: i.severity, location: i.location,
            description: i.description, fix: i.fix,
        })),
    );
    const failedDimensions = Object.entries(qa.dimensions)
        .filter(([, dim]) => dim.score < threshold)
        .map(([dimension]) => dimension);
    return {
        attempt,
        overallScore:   qa.overallScore,
        recommendation: qa.recommendation,
        passed:         qaPassed(qa, threshold),
        failedDimensions,
        issues,
    };
}

/** Turn a failed QA verdict into concrete revision instructions for the Writer. */
export function buildRevisionNotes(qa: QaValidationResult): string[] {
    const notes = Object.entries(qa.dimensions).flatMap(([dimension, dim]) =>
        dim.issues.map((i) => `[${dimension}/${i.severity}] ${i.location}: ${i.description} -> ${i.fix}`),
    );
    if (qa.summary) notes.unshift(`QA summary: ${qa.summary}`);
    return notes;
}

/** Article row status from the gate verdict: pass -> review, fail -> flagged. */
export function articleStatusFor(passed: boolean): 'review' | 'flagged' {
    if (passed) return 'review';
    return 'flagged';
}
