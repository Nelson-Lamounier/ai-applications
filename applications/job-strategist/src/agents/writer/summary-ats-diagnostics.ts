/** @format */
import type { SummaryAtsDiagnostics } from './summary-ats-flow.js';

/** Correlation keys stamped on every summary-ATS Loki event. */
export interface SummaryAtsLogKeys {
  readonly pipelineRunId: string;
  readonly applicationId: string | null;
  readonly traceId: string | null;
}

/** Minimal structural logger (pino-compatible) so this module needs no logger import. */
interface EventLogger { info(obj: object, msg: string): void; }

/**
 * Emit the summary-ATS event stream to Loki (via the pipeline's structured logger).
 * Stable schema; every line carries pipeline_run_id / application_id / trace_id.
 */
export function logSummaryAtsEvents(log: EventLogger, keys: SummaryAtsLogKeys, diag: SummaryAtsDiagnostics): void {
  const base = { pipeline_run_id: keys.pipelineRunId, application_id: keys.applicationId, trace_id: keys.traceId };
  log.info({ ...base, event: 'summary_ats_targets', targets: diag.targets.map((t) => ({ skill: t.skill, source: t.source, verdict: t.verdict })) }, 'summary_ats_targets');
  log.info({ ...base, event: 'summary_ats_scored', covered: diag.coverageBefore.covered, of: diag.coverageBefore.targets, missing: diag.coverageBefore.missing }, 'summary_ats_scored');
  if (diag.rewrite.fired) {
    log.info({ ...base, event: 'summary_ats_rewrite', reason: diag.rewrite.reason, coverage_after: diag.rewrite.coverageAfter?.covered ?? null, kept: diag.rewrite.kept, kept_reason: diag.rewrite.keptReason }, 'summary_ats_rewrite');
  }
  for (const which of diag.guardRejections) {
    log.info({ ...base, event: 'summary_ats_guard_reject', which }, 'summary_ats_guard_reject');
  }
  if (diag.fallback.fired) {
    log.info({ ...base, event: 'summary_ats_fallback', reason: diag.fallback.reason }, 'summary_ats_fallback');
  }
}

export type SummaryAtsOutcome = 'aware' | 'rewritten' | 'kept_first' | 'fallback';

/**
 * Derive the bounded Prometheus outcome+reason from the diagnostics. CRITICAL: the
 * `reason` is always from a bounded set (keptReason / rewrite.reason are enum-like,
 * fallback maps to the fixed token 'agent-error'). NEVER return the raw fallback error
 * message here -- that is unbounded and would explode metric-label cardinality (the raw
 * message goes to the Loki summary_ats_fallback event only).
 */
export function summaryAtsOutcome(diag: SummaryAtsDiagnostics): { outcome: SummaryAtsOutcome; reason: string } {
  if (diag.fallback.fired) return { outcome: 'fallback', reason: 'agent-error' };
  if (diag.rewrite.fired) {
    return diag.rewrite.kept === 'rewrite'
      ? { outcome: 'rewritten', reason: diag.rewrite.keptReason ?? 'rewrite' }
      : { outcome: 'kept_first', reason: diag.rewrite.keptReason ?? 'kept-first' };
  }
  return { outcome: 'aware', reason: diag.rewrite.reason ?? 'coverage-met' };
}
