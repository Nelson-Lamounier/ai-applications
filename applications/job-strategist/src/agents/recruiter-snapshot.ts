/** @format */
import { z } from 'zod';
import { runAgent, log } from '@bedrock/shared';
import type { AgentConfig, BasePipelineContext } from '@bedrock/shared';
import type { AtsCheckResult } from '../ats/ats-check.schema.js';
import type { StrategistResearchResult } from '@bedrock/shared';

export const RecruiterRedFlagSchema = z.object({
    flag: z.string(),
    why:  z.string(),
});

export const RecruiterSnapshotSchema = z.object({
    score:           z.number().int().min(0).max(100),
    scoreRationale:  z.string(),
    missingKeywords: z.array(z.string()).max(5),
    redFlags:        z.array(RecruiterRedFlagSchema).max(3),
});

export type RecruiterSnapshot = z.infer<typeof RecruiterSnapshotSchema>;

/** Weights for the deterministic baseline (sum to 1). Tunable in one place. */
const W_COVERAGE = 0.5;
const W_VERIFIED = 0.3;
const W_HARDREQ  = 0.2;

// Weights must sum to 1 or the score can leave [0,100].
if (W_COVERAGE + W_VERIFIED + W_HARDREQ !== 1) {
    throw new Error('recruiter-snapshot: baseline score weights must sum to 1');
}

/**
 * Deterministic 0–100 baseline from real signals: ATS keyword coverage, the
 * verified-vs-gap ratio, and how many hard requirements are evidenced.
 */
export function computeBaselineScore(
    research: Pick<StrategistResearchResult, 'verifiedMatches' | 'gaps' | 'hardRequirements'>,
    atsCheck: AtsCheckResult,
): number {
    const cov = atsCheck.jdKeywordCoverage;
    const keywordCoverage = cov.length === 0 ? 0 : cov.filter((k) => k.present).length / cov.length;

    const v = research.verifiedMatches.length;
    const g = research.gaps.length;
    const verifiedRatio = v + g === 0 ? 0 : v / (v + g);

    const hardReqs = research.hardRequirements;
    const verifiedSkills = new Set(research.verifiedMatches.map((m) => m.skill.toLowerCase()));
    const hardReqHit = hardReqs.length === 0
        ? 1
        : hardReqs.filter((r) => verifiedSkills.has(r.skill.toLowerCase())).length / hardReqs.length;

    return Math.round(100 * (W_COVERAGE * keywordCoverage + W_VERIFIED * verifiedRatio + W_HARDREQ * hardReqHit));
}

// ---------------------------------------------------------------------------
// Haiku forced-tool agent
// ---------------------------------------------------------------------------

const MODEL_ID = process.env['RECRUITER_SNAPSHOT_MODEL'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

/** Haiku tool output: a bounded score nudge + grounded selections. */
const NudgeSchema = z.object({
    scoreDelta:      z.number().int().min(-10).max(10),
    scoreRationale:  z.string(),
    missingKeywords: z.array(z.string()).max(5).default([]),
    redFlags:        z.array(RecruiterRedFlagSchema).max(3).default([]),
});
type Nudge = z.infer<typeof NudgeSchema>;

const TOOL = {
    name: 'emit_recruiter_snapshot',
    description: 'Emit a bounded score adjustment and the grounded keyword/flag selections.',
    input_schema: {
        type: 'object',
        properties: {
            scoreDelta:      { type: 'integer', minimum: -10, maximum: 10, description: 'Adjustment to the baseline score, [-10,10].' },
            scoreRationale:  { type: 'string', description: 'One line explaining the score.' },
            missingKeywords: { type: 'array', items: { type: 'string' }, description: 'Up to 5 most impactful missing JD keywords.' },
            redFlags:        { type: 'array', items: { type: 'object', properties: { flag: { type: 'string' }, why: { type: 'string' } }, required: ['flag', 'why'], additionalProperties: false }, description: 'Up to 3 red flags a recruiter notices in 10 seconds.' },
        },
        required: ['scoreDelta', 'scoreRationale', 'missingKeywords', 'redFlags'],
        additionalProperties: false,
    },
} as const;

const SYSTEM_PROMPT = [
    'You are a hiring manager doing a 10-second read of a tailored resume against a job description.',
    'Call emit_recruiter_snapshot. Rules:',
    '- scoreDelta: adjust the given baseline by at most ±10 based on overall impression; explain in scoreRationale (one line).',
    '- missingKeywords: pick the up-to-5 MOST IMPACTFUL JD terms not yet covered, ONLY from the provided candidate list. Never invent terms.',
    '- redFlags: pick the up-to-3 sharpest concerns, ONLY from the provided gaps/concerns. Phrase each as {flag, why} a recruiter would actually say. Never invent.',
].join('\n');

function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }

/**
 * Produce the recruiter snapshot. FAIL-OPEN: returns null when atsCheck is null
 * or the agent errors, so the pipeline never fails because of it.
 */
export async function buildRecruiterSnapshot(
    ctx: BasePipelineContext,
    research: Pick<StrategistResearchResult, 'verifiedMatches' | 'gaps' | 'hardRequirements'>,
    atsCheck: AtsCheckResult | null,
): Promise<RecruiterSnapshot | null> {
    if (!atsCheck) return null;

    const baseline = computeBaselineScore(research, atsCheck);
    const missingCandidates = atsCheck.jdKeywordCoverage.filter((k) => !k.present).map((k) => k.term);
    const gapLines = research.gaps.map((g) => `${g.skill} [${g.gapType}/${g.impactSeverity}] ${g.disqualifyingAssessment}`.trim());

    const userMessage = [
        `<baseline_score>${baseline}</baseline_score>`,
        `<missing_keyword_candidates>${missingCandidates.join(', ') || '(none)'}</missing_keyword_candidates>`,
        `<gaps_and_concerns>`,
        ...(gapLines.length ? gapLines.map((l) => `- ${l}`) : ['(none)']),
        `</gaps_and_concerns>`,
    ].join('\n');

    const config: AgentConfig = {
        agentName:      'recruiter-snapshot',
        modelId:        MODEL_ID,
        maxTokens:      1024,
        thinkingBudget: 0,
        systemPrompt:   [{ text: SYSTEM_PROMPT }],
        pipeline:       'job-strategist',
        tool: { name: TOOL.name, description: TOOL.description, inputSchema: TOOL.input_schema as Record<string, unknown> },
    };

    try {
        const result = await runAgent<Nudge>({
            config,
            userMessage,
            pipelineContext: ctx,
            parseResponse: (s) => {
                const parsed = NudgeSchema.safeParse(JSON.parse(s));
                if (!parsed.success) throw new Error(`recruiter-snapshot: schema validation failed: ${parsed.error.message}`);
                return parsed.data;
            },
        });
        const n: Nudge = result.data;
        const snapshot: RecruiterSnapshot = {
            score:           clamp(baseline + n.scoreDelta, 0, 100),
            scoreRationale:  n.scoreRationale,
            missingKeywords: n.missingKeywords.slice(0, 5),
            redFlags:        n.redFlags.slice(0, 3),
        };
        log('INFO', 'Recruiter snapshot built', { agent: 'recruiter-snapshot', score: snapshot.score, baseline });
        return snapshot;
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log('WARN', 'Recruiter snapshot failed (non-fatal)', { agent: 'recruiter-snapshot', error: msg });
        return null;
    }
}
