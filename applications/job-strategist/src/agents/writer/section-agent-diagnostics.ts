/** @format */
import type { StrategistAnalysisResult } from '@bedrock/shared';

/**
 * Shared observability for the three PR-B section agents that do NOT already
 * have a dedicated diagnostics module (experience/projects keep their own --
 * see experience-agent-diagnostics.ts / projects-agent-diagnostics.ts). This
 * is the THIRD copy of that same targets/scored/rewrite/fallback-event
 * pattern; rather than adding a fourth and fifth near-identical file for
 * skills and cover-letter (and a fifth shape for analysis, which has no
 * rewrite lane at all), it is collapsed into one emitter parameterised by
 * `agentKey`, plus one bounded outcome mapper per agent.
 */

/** Correlation keys stamped on every section-agent Loki event. */
export interface SectionAgentLogKeys {
    readonly pipelineRunId: string;
    readonly applicationId: string | null;
    readonly traceId: string | null;
}

/** Minimal structural logger (pino-compatible) so this module needs no logger import. */
interface EventLogger { info(obj: object, msg: string): void; }

/** One Loki line to emit: the event name is `${agentKey}_${suffix}`; `data` (if any) is folded into the line alongside the correlation keys. */
export interface SectionAgentEvent {
    readonly suffix: string;
    readonly data?: Record<string, unknown>;
}

/**
 * Emit a section agent's event stream to Loki (via the pipeline's structured
 * logger). Stable schema; every line carries pipeline_run_id / application_id
 * / trace_id plus an `event` field of `${agentKey}_${suffix}` (e.g.
 * `agentKey: 'skills_agent'`, `suffix: 'scored'` -> `skills_agent_scored`).
 * Callers build the bounded `events` list from their own diagnostics shape
 * (see skillsAgentEvents / coverLetterAgentEvents / analysisAgentEvents
 * below) -- this function does no interpretation, only namespacing + stamping.
 */
export function logSectionAgentEvents(
    log: EventLogger,
    keys: SectionAgentLogKeys,
    agentKey: string,
    events: readonly SectionAgentEvent[],
): void {
    const base = { pipeline_run_id: keys.pipelineRunId, application_id: keys.applicationId, trace_id: keys.traceId };
    for (const e of events) {
        const eventName = `${agentKey}_${e.suffix}`;
        log.info({ ...base, event: eventName, ...(e.data ?? {}) }, eventName);
    }
}

// =============================================================================
// Skills agent
// =============================================================================

/**
 * T7's plain skills-agent diagnostics shape (fillResumeSkills, run-pipeline.ts)
 * -- single-sourced here so run-pipeline and this module share ONE definition
 * rather than a second copy drifting out of sync.
 */
export interface SkillsAgentDiagnostics {
    readonly outcome: 'agent' | 'fallback';
    readonly violations: string[];
    readonly categories: number;
    readonly items: number;
}

export type SkillsAgentOutcomeReason = 'membership-invalid' | 'agent-error' | 'caps' | 'ok';

/**
 * Derive the bounded Prometheus outcome+reason from the skills diagnostics.
 * CRITICAL: `violations` tokens come from validateSkillsMembership
 * (skills-validate.ts) -- `unknown_skill:*` is the hard ledger-membership
 * contract (checked first, mirroring that file's "MEMBERSHIP CONTRACT
 * (hard)" header), `category_cap:*` / `item_cap:*` are the softer shape
 * caps, and an empty violations array on a fallback outcome means
 * executeSkillsAgent itself rejected (network/schema) before validation ever
 * ran. NEVER surface a raw violation token or thrown error message here --
 * unbounded label cardinality; the raw detail belongs on the Loki
 * `skills_agent_membership_reject` event only (see skillsAgentEvents below).
 */
export function skillsAgentOutcome(diag: SkillsAgentDiagnostics): { outcome: 'agent' | 'fallback'; reason: SkillsAgentOutcomeReason } {
    if (diag.outcome === 'agent') return { outcome: 'agent', reason: 'ok' };
    if (diag.violations.some((v) => v.startsWith('unknown_skill:'))) return { outcome: 'fallback', reason: 'membership-invalid' };
    if (diag.violations.some((v) => v.startsWith('category_cap:') || v.startsWith('item_cap:'))) return { outcome: 'fallback', reason: 'caps' };
    return { outcome: 'fallback', reason: 'agent-error' };
}

/**
 * Loki event set for one skills-agent run: `scored` always fires (categories
 * / items counts of whatever ended up in the resume, agent or fallback);
 * `membership_reject` fires only when the ledger-membership contract was
 * violated, carrying the raw `unknown_skill:*` tokens (Loki-only -- never a
 * metric label); `fallback` fires only on the fallback outcome.
 */
export function skillsAgentEvents(diag: SkillsAgentDiagnostics): SectionAgentEvent[] {
    const events: SectionAgentEvent[] = [
        { suffix: 'scored', data: { categories: diag.categories, items: diag.items } },
    ];
    const rejectedTokens = diag.violations.filter((v) => v.startsWith('unknown_skill:'));
    if (rejectedTokens.length > 0) {
        events.push({ suffix: 'membership_reject', data: { tokens: rejectedTokens } });
    }
    if (diag.outcome === 'fallback') {
        events.push({ suffix: 'fallback', data: { reason: skillsAgentOutcome(diag).reason } });
    }
    return events;
}

// =============================================================================
// Cover-letter agent
// =============================================================================

/**
 * Whether the cover-letter lane was requested (ctx.includeCoverLetter) and
 * whether the agent call itself failed -- distinct from guardCoverLetter's
 * rewrite pass, which never nulls a non-null letter (see
 * cover-letter-guard.ts's `if (!letter) return { letter, violations: [] }`
 * early-out), so the outcome is fully determined before the guard stage runs.
 */
export interface CoverLetterAgentResult {
    readonly requested: boolean;
    readonly failed: boolean;
}

export type CoverLetterAgentOutcomeReason = 'ok' | 'agent-error' | 'not-requested';

/**
 * Derive the bounded Prometheus outcome+reason from the cover-letter result.
 * NEVER surface the raw catch()-caught error here -- that goes to the
 * pipeline's `cover_letter_agent_failed_no_letter` warn log only.
 */
export function coverLetterAgentOutcome(res: CoverLetterAgentResult): { outcome: 'agent' | 'omitted'; reason: CoverLetterAgentOutcomeReason } {
    if (!res.requested) return { outcome: 'omitted', reason: 'not-requested' };
    if (res.failed) return { outcome: 'omitted', reason: 'agent-error' };
    return { outcome: 'agent', reason: 'ok' };
}

/** Loki event set for one cover-letter-agent run: exactly one of generated/omitted fires. */
export function coverLetterAgentEvents(res: CoverLetterAgentResult): SectionAgentEvent[] {
    const { outcome, reason } = coverLetterAgentOutcome(res);
    return outcome === 'agent'
        ? [{ suffix: 'generated' }]
        : [{ suffix: 'omitted', data: { reason } }];
}

// =============================================================================
// Analysis agent
// =============================================================================

/**
 * Compact metadata fold for pipeline_runs.metadata.analysis.analysisAgent.
 * Analysis failure aborts the whole run (parseAnalysisResponse throws on an
 * empty/blank analysisXml -- see runBatch1Agents's doc comment in
 * run-pipeline.ts) and that failure is already visible in the pipeline's
 * status transition, so this carries no outcome/reason of its own -- only
 * the archetype + mitigations facts a later read (UI, coach hand-off) wants.
 */
export interface AnalysisAgentSummary {
    readonly archetypeId: number | null;
    readonly confidence: number | null;
    readonly mitigations: number;
}

export function analysisAgentSummary(analysisData: StrategistAnalysisResult): AnalysisAgentSummary {
    return {
        archetypeId: analysisData.archetypeSelection?.archetypeId ?? null,
        confidence: analysisData.archetypeSelection?.confidenceScore ?? null,
        mitigations: analysisData.gapMitigations.length,
    };
}

/**
 * Loki event set for one analysis-agent run: `archetype` always fires
 * (id/confidence/whether a lead identity line was produced); `mitigations`
 * fires only when there is at least one Phase-3 gap defence to report.
 */
export function analysisAgentEvents(analysisData: StrategistAnalysisResult): SectionAgentEvent[] {
    const summary = analysisAgentSummary(analysisData);
    const events: SectionAgentEvent[] = [
        {
            suffix: 'archetype',
            data: {
                archetype_id: summary.archetypeId,
                confidence: summary.confidence,
                lead_identity_present: Boolean(analysisData.archetypeSelection?.leadIdentity),
            },
        },
    ];
    if (summary.mitigations > 0) {
        events.push({ suffix: 'mitigations', data: { count: summary.mitigations } });
    }
    return events;
}
