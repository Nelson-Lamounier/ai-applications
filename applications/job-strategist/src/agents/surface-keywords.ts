/**
 * @format
 * Surface keywords — the honest re-write in the ATS feedback loop.
 *
 * Given attainable-but-missing entries (the candidate genuinely HAS the skill,
 * or can honestly transfer it, yet the rendered resume + every ATS tier missed
 * it), a Haiku forced-tool call surfaces each keyword into the most relevant
 * section using ONLY the candidate's real evidence. It never fabricates a new
 * claim; transferable skills are framed honestly via the provided bridge.
 *
 * GAP tools never reach this function — `splitAttainable` excludes them — so a
 * gap can never be surfaced.
 *
 * FAIL-OPEN: any error (or empty input) → the input resume, unchanged.
 */

import { runAgent, log } from '@bedrock/shared';
import type { AgentConfig, BasePipelineContext, StructuredResumeData, SkillEvidenceEntry } from '@bedrock/shared';
import { ResumeRewriteSchema, buildEmitResumeTool } from './resume-tool-schema.js';
import { citableFiles } from '../ats/tool-evidence-retrieval.js';

const MODEL_ID = process.env['SURFACE_KEYWORDS_MODEL'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

const ResumeSchema = ResumeRewriteSchema;

const TOOL = buildEmitResumeTool('Return the resume as structured JSON with the keywords surfaced (plain-text strings, NO markdown).');

const CTX: BasePipelineContext = {
    pipelineId: 'surface-keywords',
    environment: process.env['DEPLOY_ENV'] ?? 'dev',
    cumulativeTokens: { input: 0, output: 0, thinking: 0 },
    cumulativeCostUsd: 0,
};

/**
 * The honest evidence payload handed to the model — only real, provided
 * fields. Defence-in-depth on evidenceFiles: the ledger is sanitised at
 * build time, but this prompt TRUSTS whatever reaches it, so non-citable
 * paths (lockfiles, build output) are filtered again at the boundary and
 * the list is capped — a wrong file here becomes fabricated grounding.
 */
function evidencePayload(missing: ReadonlyArray<SkillEvidenceEntry>) {
    return missing.map((e) => ({
        tool: e.tool,
        evidence: e.evidence,
        evidenceFiles: citableFiles(e.evidenceFiles).slice(0, 3),
        transferableBridge: e.transferableBridge,
    }));
}

/** Optional grounding inputs for the XYZ + red-flag refinement pass. */
export interface SurfaceKeywordsOpts {
    /** Red-flag phrasings the rewrite must drop or reframe (e.g. "8-month gap"). */
    readonly redFlags?: string[];
    /** Verbatim career facts + project evidence + verified-match citations. */
    readonly groundingFacts?: string;
}

/**
 * Grounded experience-refinement pass: surface attainable-but-missing keywords
 * AND rewrite the experience section in the Google XYZ formula, using ONLY the
 * candidate's real evidence + the provided grounding facts. Red flags are
 * dropped/reframed. FAIL-OPEN: empty input or any error → the input resume.
 */
export async function surfaceKeywords(
    resume: StructuredResumeData,
    missing: ReadonlyArray<SkillEvidenceEntry>,
    opts: SurfaceKeywordsOpts = {},
): Promise<StructuredResumeData> {
    if (missing.length === 0) return resume;

    const redFlags = opts.redFlags ?? [];
    const groundingFacts = opts.groundingFacts ?? '';

    const system = [
        'You refine a resume\'s EXPERIENCE section and surface attainable keywords, using ONLY the',
        'candidate\'s real evidence: the current resume, the provided grounding facts, and each missing',
        'keyword\'s evidence (tool, description, source files, transferable bridge). Call emit_resume with',
        'the FULL resume JSON.',
        '',
        '1. XYZ FORMULA — rewrite each experience highlight as "Accomplished X, as measured by Y, by doing Z"',
        '   (outcome + metric + action). Lead with the outcome, then the action that produced it.',
        '   The OUTCOME (X) does NOT need a number: it may be a DEFENSIBLE qualitative result — the',
        '   well-established purpose or benefit the verified action delivers. Example: source says only',
        '   "Migrated self-hosted Kubernetes to EKS" → "Migrated self-hosted Kubernetes to EKS, offloading',
        '   control-plane management and enabling managed, elastic scaling." That is a TRUE description of',
        '   what the action accomplishes, not an invented number. Pick the framing most relevant to the JD.',
        '2. GROUNDED, NEVER INVENTED — the ACTION (Z) and any METRIC (Y) must come ONLY from the current resume',
        '   or grounding facts. NEVER invent a number, percentage, duration, count, or any MEASURED result the',
        '   source does not state. You may restructure a real number into the Y slot, never create one. What',
        '   you MAY add is the qualitative, well-known benefit a verified action inherently provides (the X) —',
        '   never a benefit the action does not actually deliver. Fabricated metrics are forbidden; defensible',
        '   qualitative outcomes of real actions are encouraged. This honesty rule overrides everything.',
        '3. SURFACE UNDER-FRAMED VALUE — proactively scan the verified evidence for actions stated flatly',
        '   (e.g. just "Built X" or "Migrated A to B") whose favorable, JD-relevant outcome the candidate',
        '   did not make explicit. Restructure them so the real value shows — using the established benefit of',
        '   that action/technology that the source supports. Identify wins the candidate under-sold; never',
        '   manufacture one the evidence cannot back.',
        '4. WEAVE ATTAINABLE KEYWORDS — naturally include the missing tools/skills where the evidence supports',
        '   them. If a keyword is only transferable, frame it honestly via its bridge',
        "   (e.g. 'AWS Bedrock/Claude (transferable to OpenAI API)'). Never add a claim the evidence lacks.",
        '5. REMOVE RED FLAGS — drop or reframe any phrasing that exposes a listed red flag: gap-naming,',
        '   "pending/unrealised" impact, apologetic or hedged wording. Never add a claim to mask a flag —',
        '   reframe with real evidence or simply omit the offending phrase.',
        '6. PRESERVE every company, title, and period exactly, and the profile identity. Leave education and',
        '   certifications unchanged. Only touch skills/projects when a keyword or red-flag fix requires it.',
        '7. NEVER GROW THE RESUME — total length must be the SAME or FEWER words than the input. For every',
        '   keyword you weave in, tighten or cut lower-value wording in the same section. Hard caps: each',
        '   bullet <= 32 words; a skill entry is a NAME (<= 6 words), never a sentence; a project description',
        '   <= 80 words. Do NOT copy grounding-facts prose into the resume — grounding facts justify claims,',
        '   they are not resume content.',
        '',
        'Output plain text only: no markdown, no em-dashes (the pipeline normalizes em-dashes anyway).',
    ].join('\n');

    const config: AgentConfig = {
        agentName: 'surface-keywords',
        modelId: MODEL_ID,
        maxTokens: 8000,
        thinkingBudget: 0,
        systemPrompt: [{ text: system }],
        pipeline: 'job-strategist',
        tool: { name: TOOL.name, description: TOOL.description, inputSchema: TOOL.input_schema as Record<string, unknown> },
    };

    const userMessage =
        `<keywords>${JSON.stringify(evidencePayload(missing))}</keywords>\n` +
        `<grounding_facts>${groundingFacts}</grounding_facts>\n` +
        `<red_flags>${JSON.stringify(redFlags)}</red_flags>\n` +
        `<resume>${JSON.stringify(resume)}</resume>`;

    try {
        const result = await runAgent<StructuredResumeData>({
            config, userMessage, pipelineContext: CTX,
            parseResponse: (s) => {
                const parsed = ResumeSchema.safeParse(JSON.parse(s));
                if (!parsed.success) throw new Error(`surface-keywords: ${parsed.error.message}`);
                return parsed.data as unknown as StructuredResumeData;
            },
        });
        return result.data;
    } catch (e) {
        log('WARN', 'surface-keywords failed — keeping original resume', { error: e instanceof Error ? e.message : String(e) });
        return resume;
    }
}
