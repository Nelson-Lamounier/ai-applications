/**
 * @format
 * Pure per-stage timing helper for the Strategist pipeline (job_strategist_
 * pipeline_stage_seconds{stage}). Deliberately its own module -- NOT inline
 * in run-pipeline.ts -- so it is unit-testable without pulling in run-
 * pipeline.ts's module graph (pdf-parse et al; see
 * __tests__/experience-weave-scope.test.ts's doc comment for the same
 * constraint on a sibling helper). Clock is injected so the unit test never
 * depends on real wall-clock timing.
 */

export interface Clock {
    now(): number;
}

/** Real wall-clock time (milliseconds since epoch), the production default. */
export const systemClock: Clock = { now: () => Date.now() };

/** The minimal Prometheus Histogram surface this helper needs. */
export interface StageHistogram {
    observe(labels: { stage: string }, value: number): void;
}

/**
 * Time an async pipeline stage and record its wall-clock duration (seconds)
 * on `histogram` under label {stage}. Records on BOTH the success and the
 * throw path (finally) -- a failing stage still contributes its real cost to
 * the metric, matching every other fail-open observability point in this
 * pipeline. The stage's own success/failure semantics are untouched: this
 * helper never swallows a rejection, it only measures around it.
 */
export async function stageSeconds<T>(
    histogram: StageHistogram,
    stage: string,
    fn: () => Promise<T>,
    clock: Clock = systemClock,
): Promise<T> {
    const start = clock.now();
    try {
        return await fn();
    } finally {
        histogram.observe({ stage }, (clock.now() - start) / 1000);
    }
}
