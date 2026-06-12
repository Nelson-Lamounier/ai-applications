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

import { z } from 'zod';
import { runAgent, log } from '@bedrock/shared';
import type { AgentConfig, BasePipelineContext, StructuredResumeData, SkillEvidenceEntry } from '@bedrock/shared';

const MODEL_ID = process.env['SURFACE_KEYWORDS_MODEL'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

const ProfileSchema = z.object({
    name: z.string(),
    title: z.string(),
    email: z.string(),
    location: z.string(),
    linkedin: z.string().optional(),
    github: z.string().optional(),
}).passthrough();

const ExperienceSchema = z.object({
    company: z.string(),
    title: z.string(),
    period: z.string(),
    highlights: z.array(z.string()),
}).passthrough();

const SkillCategorySchema = z.object({
    category: z.string(),
    skills: z.array(z.string()),
}).passthrough();

const EducationSchema = z.object({
    degree: z.string(),
    institution: z.string(),
    period: z.string(),
}).passthrough();

const ResumeSchema = z.object({
    profile: ProfileSchema,
    summary: z.string(),
    experience: z.array(ExperienceSchema),
    skills: z.array(SkillCategorySchema),
    education: z.array(EducationSchema),
    certifications: z.array(z.object({}).passthrough()),
    projects: z.array(z.object({}).passthrough()),
    keyAchievements: z.array(z.object({}).passthrough()),
    sectionOrder: z.array(z.string()).optional(),
});

const TOOL = {
    name: 'emit_resume',
    description: 'Return the resume as structured JSON with the keywords surfaced (plain-text strings, NO markdown).',
    input_schema: {
        type: 'object',
        properties: {
            profile: {
                type: 'object',
                properties: {
                    name: { type: 'string' }, title: { type: 'string' }, email: { type: 'string' },
                    location: { type: 'string' }, linkedin: { type: 'string' }, github: { type: 'string' },
                },
                required: ['name', 'title', 'email', 'location'],
            },
            summary: { type: 'string' },
            experience: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        company: { type: 'string' }, title: { type: 'string' },
                        period: { type: 'string' }, highlights: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['company', 'title', 'period', 'highlights'],
                },
            },
            skills: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: { category: { type: 'string' }, skills: { type: 'array', items: { type: 'string' } } },
                    required: ['category', 'skills'],
                },
            },
            education: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: { degree: { type: 'string' }, institution: { type: 'string' }, period: { type: 'string' } },
                    required: ['degree', 'institution', 'period'],
                },
            },
            certifications: { type: 'array', items: { type: 'object' } },
            projects: { type: 'array', items: { type: 'object' } },
            keyAchievements: { type: 'array', items: { type: 'object' } },
            sectionOrder: { type: 'array', items: { type: 'string' } },
        },
        required: ['profile', 'summary', 'experience', 'skills', 'education', 'certifications', 'projects', 'keyAchievements'],
        additionalProperties: false,
    },
} as const;

const CTX: BasePipelineContext = {
    pipelineId: 'surface-keywords',
    environment: process.env['DEPLOY_ENV'] ?? 'dev',
    cumulativeTokens: { input: 0, output: 0, thinking: 0 },
    cumulativeCostUsd: 0,
};

/** The honest evidence payload handed to the model — only real, provided fields. */
function evidencePayload(missing: ReadonlyArray<SkillEvidenceEntry>) {
    return missing.map((e) => ({
        tool: e.tool,
        evidence: e.evidence,
        evidenceFiles: e.evidenceFiles,
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
        '   (outcome + metric + action). Lead with the outcome/metric, then the action that produced it.',
        '2. GROUNDED, NEVER INVENTED — use ONLY metrics, actions, and outcomes that already appear in the',
        '   current resume or the grounding facts. NEVER invent a number. You may restructure a real number',
        '   into the Y slot, but you must NEVER create one. A highlight with no real metric becomes a',
        '   qualitative "X by Z" (outcome + action, no fabricated Y). This honesty rule overrides everything.',
        '3. WEAVE ATTAINABLE KEYWORDS — naturally include the missing tools/skills where the evidence supports',
        '   them. If a keyword is only transferable, frame it honestly via its bridge',
        "   (e.g. 'AWS Bedrock/Claude (transferable to OpenAI API)'). Never add a claim the evidence lacks.",
        '4. REMOVE RED FLAGS — drop or reframe any phrasing that exposes a listed red flag: gap-naming,',
        '   "pending/unrealised" impact, apologetic or hedged wording. Never add a claim to mask a flag —',
        '   reframe with real evidence or simply omit the offending phrase.',
        '5. PRESERVE every company, title, and period exactly, and the profile identity. Leave education and',
        '   certifications unchanged. Only touch skills/projects when a keyword or red-flag fix requires it.',
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
