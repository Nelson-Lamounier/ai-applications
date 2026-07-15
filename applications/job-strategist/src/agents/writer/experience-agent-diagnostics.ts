/** @format */
import type { ExperienceAgentDiagnostics } from './experience-ats-flow.js';

/** Correlation keys stamped on every experience-agent Loki event. */
export interface ExperienceAgentLogKeys {
  readonly pipelineRunId: string;
  readonly applicationId: string | null;
  readonly traceId: string | null;
}

/** Minimal structural logger (pino-compatible) so this module needs no logger import. */
interface EventLogger { info(obj: object, msg: string): void; }

/**
 * Emit the experience-agent event stream to Loki (via the pipeline's structured
 * logger). Stable schema; every line carries pipeline_run_id / application_id /
 * trace_id. Mirrors summary-ats-diagnostics.ts's logSummaryAtsEvents.
 */
export function logExperienceAgentEvents(log: EventLogger, keys: ExperienceAgentLogKeys, diag: ExperienceAgentDiagnostics): void {
  const base = { pipeline_run_id: keys.pipelineRunId, application_id: keys.applicationId, trace_id: keys.traceId };
  log.info({ ...base, event: 'experience_agent_targets', targets: diag.targets.map((t) => ({ skill: t.skill, source: t.source, verdict: t.verdict })) }, 'experience_agent_targets');
  log.info({ ...base, event: 'experience_agent_scored', covered: diag.coverageBefore.covered, of: diag.coverageBefore.targets, missing: diag.coverageBefore.missing }, 'experience_agent_scored');
  if (diag.provenance.dropped.length > 0) {
    log.info({ ...base, event: 'experience_agent_dropped', dropped: diag.provenance.dropped }, 'experience_agent_dropped');
  }
  if (diag.rewrite.fired) {
    log.info({ ...base, event: 'experience_agent_rewrite', reason: diag.rewrite.reason, coverage_after: diag.rewrite.coverageAfter?.covered ?? null, kept: diag.rewrite.kept, kept_reason: diag.rewrite.keptReason }, 'experience_agent_rewrite');
  }
  if (diag.provenance.firstViolations.length > 0) {
    log.info({ ...base, event: 'experience_agent_provenance_reject', which: 'first', tokens: diag.provenance.firstViolations }, 'experience_agent_provenance_reject');
  }
  if (diag.provenance.rewriteViolations.length > 0) {
    log.info({ ...base, event: 'experience_agent_provenance_reject', which: 'rewrite', tokens: diag.provenance.rewriteViolations }, 'experience_agent_provenance_reject');
  }
  if (diag.fallback.fired) {
    log.info({ ...base, event: 'experience_agent_fallback', reason: diag.fallback.reason }, 'experience_agent_fallback');
  }
}

export type ExperienceAgentOutcome = 'aware' | 'rewritten' | 'kept_first' | 'fallback';

/**
 * Derive the bounded Prometheus outcome+reason from the diagnostics. CRITICAL:
 * the `reason` is always from a bounded set -- keptReason / rewrite.reason are
 * enum-like, and fallback maps to a fixed token: 'provenance-invalid' when the
 * first draft was rejected on provenance grounds (diag.provenance.firstViolations
 * non-empty), else the generic 'agent-error'. NEVER return the raw fallback
 * error message here -- that is unbounded and would explode metric-label
 * cardinality (the raw message goes to the Loki experience_agent_fallback
 * event only).
 */
export function experienceAgentOutcome(diag: ExperienceAgentDiagnostics): { outcome: ExperienceAgentOutcome; reason: string } {
  if (diag.fallback.fired) {
    return { outcome: 'fallback', reason: diag.provenance.firstViolations.length > 0 ? 'provenance-invalid' : 'agent-error' };
  }
  if (diag.rewrite.fired) {
    return diag.rewrite.kept === 'rewrite'
      ? { outcome: 'rewritten', reason: diag.rewrite.keptReason ?? 'rewrite' }
      : { outcome: 'kept_first', reason: diag.rewrite.keptReason ?? 'kept-first' };
  }
  return { outcome: 'aware', reason: diag.rewrite.reason ?? 'coverage-met' };
}
