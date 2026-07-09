/**
 * @format
 * Corrective retrieval pass (CRAG-style) — acts on the gap-cause signal.
 *
 * Live measurement showed 76% of classified research gaps (100/131) are
 * `kb_present_not_retrieved`: the classifier says evidence for the skill
 * EXISTS in the user's KB, but the research retrieval never surfaced it, so
 * the JD analysis reports a gap the user does not have. This pass runs after
 * the deterministic guard chain and before the strategist consumes the brief:
 *
 *   1. Classify the guarded gaps (same `classifyGapCauses` used for the
 *      metadata annotation) and take the top MAX_CORRECTIVE_GAPS
 *      `kb_present_not_retrieved` gaps by severity.
 *   2. Re-query the KB once per gap with a SKILL-FOCUSED query (not the JD
 *      soup that missed it the first time).
 *   3. Hand every gap that retrieved passages to one batched adjudicator
 *      call, which must decide honestly: `promote` (the passages demonstrate
 *      the user actually practised the skill → becomes a PartialMatch with
 *      cited evidence) or `stand` (lexical mention only — comparison tables,
 *      wish-lists, lock-file noise — the gap is real).
 *
 * Honesty is the design constraint: the tsv-presence classifier overcounts
 * (e.g. "Angular" marked present because the word appears somewhere), so the
 * adjudicator's default verdict is `stand`. Fail-open by contract — callers
 * catch and keep the unmodified matching result.
 */
import type { Pool } from 'pg';
import type { BasePipelineContext, PartialMatch, SkillGap } from '@bedrock/shared';
import { runAgent } from '@bedrock/shared';
import { classifyGapCauses } from './gap-cause.js';

/** Cap re-queries per run — keeps the pass at pennies (N retrievals + 1 Haiku call). */
export const MAX_CORRECTIVE_GAPS = 5;
export const MAX_PASSAGES_PER_GAP = 5;

export interface CorrectiveCandidate {
    readonly gap: SkillGap;
    readonly passages: readonly string[];
}

export interface CorrectiveVerdict {
    readonly skill: string;
    readonly verdict: 'promote' | 'stand';
    /** One-line summary of the evidence found (promote only). */
    readonly evidenceSummary?: string;
    /** How the candidate should frame this on an application (promote only). */
    readonly framingSuggestion?: string;
    /** Source paths quoted from the passage annotations (promote only). */
    readonly evidenceFiles?: readonly string[];
}

export interface CorrectiveStats {
    /** present_not_retrieved gaps selected for re-query (post-cap). */
    readonly candidates: number;
    /** Candidates whose re-query returned at least one passage. */
    readonly retrieved: number;
    /** Gaps promoted to partial matches by the adjudicator. */
    readonly promoted: number;
    /** Skills promoted (for the run log / metadata). */
    readonly promotedSkills: readonly string[];
}

interface MatchingSlice {
    readonly gaps: SkillGap[];
    readonly partialMatches: PartialMatch[];
}

const EMPTY_STATS: CorrectiveStats = { candidates: 0, retrieved: 0, promoted: 0, promotedSkills: [] };

const SEVERITY_ORDER: Record<string, number> = { blocking: 0, significant: 1, minor: 2 };

/** Skill-focused re-query — deliberately NOT the JD-wide query that already missed. */
export function correctiveQuery(skill: string): string {
    return `${skill} hands-on implementation configuration usage`;
}

function buildPromotion(gap: SkillGap, v: CorrectiveVerdict): PartialMatch {
    return {
        skill: gap.skill,
        gapDescription: gap.disqualifyingAssessment,
        transferableFoundation: v.evidenceSummary ?? 'Evidence recovered by corrective retrieval.',
        framingSuggestion: v.framingSuggestion ?? `Reference the recovered ${gap.skill} evidence directly.`,
        evidenceFiles: [...(v.evidenceFiles ?? [])],
    };
}

/** Move promoted gaps into partialMatches; everything else stands. */
function applyPromotions<T extends MatchingSlice>(
    matching: T,
    promotions: ReadonlyMap<string, CorrectiveVerdict>,
): { matching: T; promotedSkills: string[] } {
    const promotedMatches: PartialMatch[] = [];
    const remainingGaps: SkillGap[] = [];
    for (const gap of matching.gaps) {
        const v = promotions.get(gap.skill.toLowerCase());
        if (v) promotedMatches.push(buildPromotion(gap, v));
        else remainingGaps.push(gap);
    }
    return {
        matching: { ...matching, gaps: remainingGaps, partialMatches: [...matching.partialMatches, ...promotedMatches] },
        promotedSkills: promotedMatches.map((m) => m.skill),
    };
}

/**
 * Re-retrieve and adjudicate `kb_present_not_retrieved` gaps. Returns the
 * (possibly) corrected matching slice plus stats for metadata/metrics.
 * Pure orchestration — retrieval and adjudication are injected so the unit
 * test needs no Bedrock or Postgres.
 */
export async function applyCorrectiveRetrieval<T extends MatchingSlice>(
    matching: T,
    deps: {
        pool: Pool;
        userId: string;
        retrieve: (query: string, maxPassages: number) => Promise<string[]>;
        adjudicate: (candidates: readonly CorrectiveCandidate[]) => Promise<CorrectiveVerdict[]>;
    },
): Promise<{ matching: T; stats: CorrectiveStats }> {
    if (matching.gaps.length === 0) return { matching, stats: EMPTY_STATS };

    const causes = await classifyGapCauses(deps.pool, deps.userId, matching.gaps.map((g) => g.skill));
    const candidates = matching.gaps
        .filter((g) => causes.get(g.skill) === 'kb_present_not_retrieved')
        .sort((a, b) => (SEVERITY_ORDER[a.impactSeverity] ?? 3) - (SEVERITY_ORDER[b.impactSeverity] ?? 3))
        .slice(0, MAX_CORRECTIVE_GAPS);
    if (candidates.length === 0) return { matching, stats: EMPTY_STATS };

    const withPassages: CorrectiveCandidate[] = [];
    for (const gap of candidates) {
        const passages = await deps.retrieve(correctiveQuery(gap.skill), MAX_PASSAGES_PER_GAP);
        if (passages.length > 0) withPassages.push({ gap, passages });
    }
    if (withPassages.length === 0) {
        return { matching, stats: { ...EMPTY_STATS, candidates: candidates.length } };
    }

    const verdicts = await deps.adjudicate(withPassages);
    const promotions = new Map(
        verdicts.filter((v) => v.verdict === 'promote').map((v) => [v.skill.toLowerCase(), v]),
    );
    const partialStats = { ...EMPTY_STATS, candidates: candidates.length, retrieved: withPassages.length };
    if (promotions.size === 0) return { matching, stats: partialStats };

    const applied = applyPromotions(matching, promotions);
    return {
        matching: applied.matching,
        stats: { ...partialStats, promoted: applied.promotedSkills.length, promotedSkills: applied.promotedSkills },
    };
}

// ---------------------------------------------------------------------------
// Bedrock adjudicator (one batched forced-tool call, Haiku by default)
// ---------------------------------------------------------------------------

const ADJUDICATOR_TOOL = {
    name: 'record_corrective_verdicts',
    description: 'Record the promote/stand verdict for each re-retrieved gap.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            verdicts: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        skill: { type: 'string' },
                        verdict: { type: 'string', enum: ['promote', 'stand'] },
                        evidenceSummary: { type: 'string' },
                        framingSuggestion: { type: 'string' },
                        evidenceFiles: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['skill', 'verdict'],
                },
            },
        },
        required: ['verdicts'],
    },
};

const ADJUDICATOR_SYSTEM = [
    'You are an evidence adjudicator for a resume-generation system. For each',
    'skill below, retrieval found KB passages AFTER the skill was reported as a',
    'gap. Decide per skill:',
    '- promote: the passages demonstrate the candidate has actually practised',
    '  the skill (their own code, config, or first-person documentation).',
    '  Provide a one-line evidenceSummary, a framingSuggestion, and the source',
    '  paths (from the [Source: ...] annotations) as evidenceFiles.',
    '- stand: the passages only MENTION the skill (comparison tables, wish',
    '  lists, third-party references, dependency noise). The gap is real.',
    'Be strict: promote only on genuine practised evidence. When uncertain,',
    'answer stand. You MUST respond by calling record_corrective_verdicts.',
].join('\n');

/** Ledger identity for ADJUDICATOR_SYSTEM above — bump version on any wording change (pairs with system_prompt_hash in prompt_invocations). */
export const CORRECTIVE_RETRIEVAL_PROMPT_META = { id: 'corrective-retrieval', version: '1' } as const;

/** Build the production adjudicator: one batched Haiku call for all candidates. */
export function buildBedrockAdjudicator(opts: {
    pipelineContext: BasePipelineContext;
    userId: string;
}): (candidates: readonly CorrectiveCandidate[]) => Promise<CorrectiveVerdict[]> {
    const modelId = process.env['CORRECTIVE_MODEL_ID'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
    return async (candidates) => {
        const userMessage = candidates
            .map((c) => [
                `<gap skill="${c.gap.skill}" severity="${c.gap.impactSeverity}">`,
                `<original_assessment>${c.gap.disqualifyingAssessment}</original_assessment>`,
                ...c.passages.map((p) => `<passage>${p}</passage>`),
                '</gap>',
            ].join('\n'))
            .join('\n\n');
        const result = await runAgent<{ verdicts: CorrectiveVerdict[] }>({
            config: {
                agentName: 'corrective-retrieval',
                promptId: CORRECTIVE_RETRIEVAL_PROMPT_META.id,
                promptVersion: CORRECTIVE_RETRIEVAL_PROMPT_META.version,
                modelId,
                maxTokens: 2048,
                thinkingBudget: 0,
                systemPrompt: [{ text: ADJUDICATOR_SYSTEM }],
                pipeline: 'job-strategist',
                tool: {
                    name: ADJUDICATOR_TOOL.name,
                    description: ADJUDICATOR_TOOL.description,
                    inputSchema: ADJUDICATOR_TOOL.inputSchema,
                },
            },
            userMessage,
            pipelineContext: opts.pipelineContext,
            userId: opts.userId,
            parseResponse: (text) => JSON.parse(text) as { verdicts: CorrectiveVerdict[] },
        });
        return result.data.verdicts ?? [];
    };
}
