/**
 * @format
 * Surface metrics — the metric-weave stage of the grounded-metrics loop.
 *
 * Runs on EVERY resume when the candidate's documentation supplies grounded
 * numbers (the ledger). Feeding the ledger to the WRITER tripled its extended
 * thinking (13.9K -> 37-56K output tokens, 4 -> 12-17 min, measured across
 * personas v6-v8 on 2026-07-08) because Sonnet treats the thinking budget as
 * a target and deliberates over every number-to-bullet pairing — so the
 * writer never sees the ledger; this one bounded Haiku rewrite weaves 2-4
 * JD-relevant ledger metrics into EXISTING bullets afterwards — values
 * verbatim, no new claims — mirroring surface-keywords' honesty rails. The
 * caller re-runs stripUngroundedNumbers afterwards, so any value the rewrite
 * alters is deterministically removed.
 *
 * FAIL-OPEN: empty ledger or any error → the input resume, unchanged.
 */

import { runAgent, log } from '@bedrock/shared';
import { CLAIM_STRENGTH_RULE } from '../../lib/claim-strength.js';
import type { AgentConfig, BasePipelineContext, StructuredResumeData } from '@bedrock/shared';
import { ResumeRewriteSchema, buildEmitResumeTool } from '../writer/resume-tool-schema.js';

const MODEL_ID = process.env['SURFACE_KEYWORDS_MODEL'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

/** Ledger identity for the inline prompt below — bump version on any wording change (pairs with system_prompt_hash in prompt_invocations). */
export const SURFACE_METRICS_PROMPT_META = { id: 'surface-metrics', version: '1' } as const;

const TOOL = buildEmitResumeTool('Return the resume as structured JSON with grounded metrics surfaced (plain-text strings, NO markdown).');

const CTX: BasePipelineContext = {
    pipelineId: 'surface-metrics',
    environment: process.env['DEPLOY_ENV'] ?? 'dev',
    cumulativeTokens: { input: 0, output: 0, thinking: 0 },
    cumulativeCostUsd: 0,
};

/** Optional grounding inputs for the metric-surfacing pass. */
export interface SurfaceMetricsOpts {
    /** Verbatim career facts + project evidence + verified-match citations. */
    readonly groundingFacts?: string;
    /** Target role + required skills — steers WHICH ledger metrics are most JD-relevant. */
    readonly jdContext?: string;
}

/**
 * Weave grounded metrics from the ledger into the resume's existing bullets.
 * The ledger lines are the ONLY permitted number source; each value must be
 * used EXACTLY as stated or not at all.
 */
export async function surfaceMetrics(
    resume: StructuredResumeData,
    metricsLedger: string,
    opts: SurfaceMetricsOpts = {},
): Promise<StructuredResumeData> {
    if (!metricsLedger.trim()) return resume;

    const system = [
        'The candidate\'s own documentation (the GROUNDED METRICS list) provides verified numbers.',
        'Strengthen the resume by weaving 2-4 of the most JD-relevant metrics into EXISTING experience',
        'highlights or project descriptions. Call emit_resume with the FULL resume JSON.',
        '',
        '1. VALUES ARE IMMUTABLE — use each metric EXACTLY as stated in its ledger line: never invent,',
        '   alter, round, combine, or re-derive a number. If no ledger metric fits a bullet honestly,',
        '   leave that bullet unchanged. Only numbers from the ledger (or already in the resume) may',
        '   appear in the output.',
        '2. NO NEW CLAIMS — a metric may only quantify work the bullet ALREADY describes and the ledger',
        '   attributes to the same project/work. Never attach a metric to unrelated work.',
        '3. NEVER GROW THE RESUME — same or fewer words: tighten wording in the same bullet to make room.',
        '   Each bullet keeps at most one number (two only for a before/after pair stated in one ledger',
        '   line). Do NOT add a number to a bullet that already carries one; at most 4 woven metrics total.',
        '4. PRESERVE every company, title, period, and the profile identity. Leave education and',
        '   certifications unchanged.',
        '',
        'Output plain text only: no markdown, no em-dashes.',
        CLAIM_STRENGTH_RULE,
    ].join('\n');

    const config: AgentConfig = {
        agentName: 'surface-metrics',
        promptId: SURFACE_METRICS_PROMPT_META.id,
        promptVersion: SURFACE_METRICS_PROMPT_META.version,
        modelId: MODEL_ID,
        maxTokens: 8000,
        thinkingBudget: 0,
        systemPrompt: [{ text: system }],
        pipeline: 'job-strategist',
        tool: { name: TOOL.name, description: TOOL.description, inputSchema: TOOL.input_schema as Record<string, unknown> },
    };

    const userMessage =
        `<jd_context>${opts.jdContext ?? ''}</jd_context>\n` +
        `<grounded_metrics>${metricsLedger}</grounded_metrics>\n` +
        `<grounding_facts>${opts.groundingFacts ?? ''}</grounding_facts>\n` +
        `<resume>${JSON.stringify(resume)}</resume>`;

    try {
        const result = await runAgent<StructuredResumeData>({
            config, userMessage, pipelineContext: CTX,
            parseResponse: (s) => {
                const parsed = ResumeRewriteSchema.safeParse(JSON.parse(s));
                if (!parsed.success) throw new Error(`surface-metrics: ${parsed.error.message}`);
                return parsed.data as unknown as StructuredResumeData;
            },
        });
        return result.data;
    } catch (e) {
        log('WARN', 'surface-metrics failed — keeping original resume', { error: e instanceof Error ? e.message : String(e) });
        return resume;
    }
}
