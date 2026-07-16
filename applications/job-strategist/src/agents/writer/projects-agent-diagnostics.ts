/** @format */
import type { ProjectsAgentDiagnostics } from './projects-ats-flow.js';
import type { VerifiedMatch } from '../evidence/project-agent-inputs.js';
import { OPERATIONS_THEMES } from '../evidence/operations-themes.js';
import { repoOfFile } from '../../ats/grounding/evidence-lane.js';

/** Theme label -> theme key, for turning an operations-evidence VerifiedMatch's
 *  `skill` (the theme's human label) back into its bounded ontology key for
 *  the Loki event below. */
const THEME_KEY_BY_LABEL = new Map(OPERATIONS_THEMES.map((t) => [t.label, t.key]));

/** Correlation keys stamped on every projects-agent Loki event. */
export interface ProjectsAgentLogKeys {
  readonly pipelineRunId: string;
  readonly applicationId: string | null;
  readonly traceId: string | null;
}

/** Minimal structural logger (pino-compatible) so this module needs no logger import. */
interface EventLogger { info(obj: object, msg: string): void; }

/**
 * Emit the projects-agent event stream to Loki (via the pipeline's structured
 * logger). Stable schema; every line carries pipeline_run_id / application_id /
 * trace_id. Mirrors experience-agent-diagnostics.ts's logExperienceAgentEvents,
 * plus two projects-only events: projects_repo_unresolved, fired once (with the
 * unresolved repo name list) when ProjectAgentInputs.unresolvedRepos is
 * non-empty -- citations that failed fail-closed attribution to a known
 * repository during pool construction (see project-agent-inputs.ts) -- and
 * projects_agent_normalised, fired once (with the bounded int count) when the
 * normalise-then-validate pass (normaliseProjectsAgentOutput) stripped at
 * least one item/field from the agent's raw response before it could parse.
 */
export function logProjectsAgentEvents(log: EventLogger, keys: ProjectsAgentLogKeys, diag: ProjectsAgentDiagnostics): void {
  const base = { pipeline_run_id: keys.pipelineRunId, application_id: keys.applicationId, trace_id: keys.traceId };
  log.info({ ...base, event: 'projects_agent_targets', targets: diag.targets.map((t) => ({ skill: t.skill, source: t.source, verdict: t.verdict })) }, 'projects_agent_targets');
  log.info({ ...base, event: 'projects_agent_scored', covered: diag.coverageBefore.covered, of: diag.coverageBefore.targets, missing: diag.coverageBefore.missing }, 'projects_agent_scored');
  if (diag.normalisedExtras > 0) {
    log.info({ ...base, event: 'projects_agent_normalised', extras: diag.normalisedExtras }, 'projects_agent_normalised');
  }
  if (diag.rewrite.fired) {
    log.info({ ...base, event: 'projects_agent_rewrite', reason: diag.rewrite.reason, coverage_after: diag.rewrite.coverageAfter?.covered ?? null, kept: diag.rewrite.kept, kept_reason: diag.rewrite.keptReason }, 'projects_agent_rewrite');
  }
  if (diag.provenance.firstViolations.length > 0) {
    log.info({ ...base, event: 'projects_agent_provenance_reject', which: 'first', tokens: diag.provenance.firstViolations }, 'projects_agent_provenance_reject');
  }
  if (diag.provenance.rewriteViolations.length > 0) {
    log.info({ ...base, event: 'projects_agent_provenance_reject', which: 'rewrite', tokens: diag.provenance.rewriteViolations }, 'projects_agent_provenance_reject');
  }
  if (diag.fallback.fired) {
    log.info({ ...base, event: 'projects_agent_fallback', reason: diag.fallback.reason }, 'projects_agent_fallback');
  }
  if (diag.unresolvedRepos.length > 0) {
    log.info({ ...base, event: 'projects_repo_unresolved', repos: diag.unresolvedRepos }, 'projects_repo_unresolved');
  }
}

/**
 * Emit the `projects_theme_evidence` Loki event -- the operations-evidence
 * gather step's yield, nested `theme key -> { repo full name -> count }`
 * (docs/superpowers/specs/2026-07-16-projects-operations-evidence-design.md
 * Component 4). Built from the raw `VerifiedMatch[]` `gatherOperationsEvidence`
 * returned (skill = theme label, evidenceFiles = [file]) rather than from the
 * flat `factCounts`/`byRepo` counters on its result, which are bounded
 * summaries, not the theme x repo cross-tab this event needs. Emitted only
 * when at least one fact was gathered -- a themeless or evidence-less run
 * produces no event, no log noise. Called by run-pipeline.ts right after the
 * gather (independent of, and well before, `logProjectsAgentEvents`, which
 * fires only after the projects agent itself resolves).
 */
export function logProjectsThemeEvidence(
  log: EventLogger,
  keys: ProjectsAgentLogKeys,
  matches: readonly VerifiedMatch[],
): void {
  if (matches.length === 0) return;
  const byThemeRepo: Record<string, Record<string, number>> = {};
  for (const m of matches) {
    const themeKey = THEME_KEY_BY_LABEL.get(m.skill) ?? m.skill;
    const repo = repoOfFile(m.evidenceFiles[0] ?? '') ?? 'unknown';
    const forTheme = byThemeRepo[themeKey] ?? {};
    forTheme[repo] = (forTheme[repo] ?? 0) + 1;
    byThemeRepo[themeKey] = forTheme;
  }
  const base = { pipeline_run_id: keys.pipelineRunId, application_id: keys.applicationId, trace_id: keys.traceId };
  log.info({ ...base, event: 'projects_theme_evidence', themes: byThemeRepo }, 'projects_theme_evidence');
}

export type ProjectsAgentOutcome = 'aware' | 'rewritten' | 'kept_first' | 'fallback';

/**
 * Derive the bounded Prometheus outcome+reason from the diagnostics. CRITICAL:
 * the `reason` is always from a bounded set -- keptReason / rewrite.reason are
 * enum-like, and fallback maps to a fixed token: 'provenance-invalid' when the
 * first draft was rejected on provenance grounds (diag.provenance.firstViolations
 * non-empty), else the generic 'agent-error'. NEVER return the raw fallback
 * error message here -- that is unbounded and would explode metric-label
 * cardinality (the raw message goes to the Loki projects_agent_fallback
 * event only). Mirrors experienceAgentOutcome exactly.
 */
export function projectsAgentOutcome(diag: ProjectsAgentDiagnostics): { outcome: ProjectsAgentOutcome; reason: string } {
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
