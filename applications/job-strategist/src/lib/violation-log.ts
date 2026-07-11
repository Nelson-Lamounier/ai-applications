/**
 * @format
 * Violation log — collects every guard-violation (stage, code) pair fired
 * during a run so they can be PERSISTED, not just counted.
 *
 * Before this, violation codes existed only as Prometheus counter increments.
 * Short-lived strategist Job pods increment labelled series that are born
 * mid-run and die seconds after completion, so the increments rarely survive
 * to a scrape (verified on run 77e325ea, 2026-07-09: three resume-rewrites
 * fired, zero counter increase visible across all 209 violation series;
 * nothing in Loki or pipeline_runs.metadata either). run-pipeline stashes
 * this log on pipeline_runs.metadata.guard and emits one structured log line,
 * making "why did each rewrite fire?" answerable per run.
 *
 * The optional onRecord hook keeps the existing Prometheus increments live at
 * every call site; a throwing hook never loses the violation.
 */

export interface ViolationEntry {
    /** Pipeline stage that fired the violation (e.g. resume_guard, length_budget). */
    readonly stage: string;
    /** Violation code (e.g. headline_is_title, experience_bullet_jd_echo). */
    readonly code: string;
}

export interface GuardMetadata {
    readonly total: number;
    readonly violations: ViolationEntry[];
}

export interface ViolationLog {
    /** Record one violation code under a stage. */
    record(stage: string, code: string): void;
    /** Record a guard result's violation array ({ code } objects). */
    recordAll(stage: string, violations: ReadonlyArray<{ code: string }>): void;
    /** Shape for pipeline_runs.metadata.guard — null when the run was clean. */
    toMetadata(): GuardMetadata | null;
}

export function createViolationLog(onRecord?: (stage: string, code: string) => void): ViolationLog {
    const violations: ViolationEntry[] = [];

    function record(stage: string, code: string): void {
        violations.push({ stage, code });
        try {
            onRecord?.(stage, code);
        } catch {
            /* observability hook must never lose the violation */
        }
    }

    return {
        record,
        recordAll(stage, vs) {
            for (const v of vs) record(stage, v.code);
        },
        toMetadata() {
            if (violations.length === 0) return null;
            return { total: violations.length, violations: [...violations] };
        },
    };
}
