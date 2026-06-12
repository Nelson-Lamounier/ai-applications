/**
 * @format
 * JD Extractor / JD Agent — Phase 0 of the analyse pipeline.
 *
 * Turns the raw (pasted) job description into the complete JdSignal:
 * hard + soft requirements, technology inventory, experience signals, target
 * role title, AND the atomic retrieval keywords — the single source of JD
 * understanding for the whole pipeline.
 *
 * Purpose: the Research agent's KB queries were built from raw JD *substrings*,
 * which dilutes the embedding with boilerplate. Querying with the extracted
 * skills/keywords sharpens retrieval → better verified matches / gaps. ADDITIVE:
 * the raw JD still flows to Research; this only improves retrieval + reuse.
 *
 * FAIL-OPEN: any failure returns a minimal valid JdSignal so the pipeline never
 * blocks on an extraction error.
 */
import { z } from 'zod';
import { PiiScrubber, runAgent, log } from '@bedrock/shared';
import type { AgentConfig, BasePipelineContext, JdSignal } from '@bedrock/shared';

const piiScrubber = new PiiScrubber();
const MODEL_ID = process.env['JD_EXTRACTOR_MODEL_ID'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
const MAX_JD_CHARS = 20_000;

// ─────────────────────────────────────────────────────────────────────────────
// Legacy narrow type — kept for callers that import JdExtraction directly
// (research-agent.ts, ats/jd-keywords.ts, ats/run-ats-check.ts).
// ─────────────────────────────────────────────────────────────────────────────

export interface JdExtraction {
    readonly requiredSkills:    string[];
    readonly preferredSkills:   string[];
    readonly tools:             string[];
    readonly concepts:          string[];
    readonly responsibilities:  string[];
    readonly domain:            string;
    readonly seniority:         string;
    /** Deduped lowercase technical terms for vector retrieval. */
    readonly retrievalKeywords: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Zod schema — full JdSignal shape with safe defaults on every field
// ─────────────────────────────────────────────────────────────────────────────

const JobRequirementSchema = z.object({
    skill:         z.string().default(''),
    context:       z.string().default(''),
    disqualifying: z.boolean().optional(),
});

const TechnologyInventorySchema = z.object({
    languages:      z.array(z.string()).default([]),
    frameworks:     z.array(z.string()).default([]),
    infrastructure: z.array(z.string()).default([]),
    tools:          z.array(z.string()).default([]),
    methodologies:  z.array(z.string()).default([]),
}).default({ languages: [], frameworks: [], infrastructure: [], tools: [], methodologies: [] });

const ExperienceSignalsSchema = z.object({
    yearsExpected:         z.string().default(''),
    domainExperience:      z.string().default(''),
    leadershipExpectation: z.string().default(''),
    scaleIndicators:       z.string().default(''),
}).default({ yearsExpected: '', domainExperience: '', leadershipExpectation: '', scaleIndicators: '' });

export const JdExtractionSchema = z.object({
    // New JdSignal fields
    targetRole:           z.string().default(''),
    companyProblem:       z.string().default(''),
    hardRequirements:     z.array(JobRequirementSchema).default([]),
    softRequirements:     z.array(JobRequirementSchema).default([]),
    implicitRequirements: z.array(z.string()).default([]),
    technologyInventory:  TechnologyInventorySchema,
    experienceSignals:    ExperienceSignalsSchema,
    // Existing atomic fields
    requiredSkills:    z.array(z.string()).default([]),
    preferredSkills:   z.array(z.string()).default([]),
    tools:             z.array(z.string()).default([]),
    concepts:          z.array(z.string()).default([]),
    responsibilities:  z.array(z.string()).default([]),
    domain:            z.string().default(''),
    seniority:         z.string().default(''),
    retrievalKeywords: z.array(z.string()).default([]),
});

// ─────────────────────────────────────────────────────────────────────────────
// Minimal fail-open fallback — all arrays empty, all strings ''
// ─────────────────────────────────────────────────────────────────────────────

const MINIMAL_JD_SIGNAL: JdSignal = {
    targetRole:           '',
    seniority:            '',
    domain:               '',
    companyProblem:       '',
    hardRequirements:     [],
    softRequirements:     [],
    implicitRequirements: [],
    technologyInventory:  { languages: [], frameworks: [], infrastructure: [], tools: [], methodologies: [] },
    experienceSignals:    { yearsExpected: '', domainExperience: '', leadershipExpectation: '', scaleIndicators: '' },
    requiredSkills:    [],
    preferredSkills:   [],
    tools:             [],
    concepts:          [],
    responsibilities:  [],
    retrievalKeywords: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool schema — full JdSignal JSON Schema
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_SCHEMA = {
    name: 'extract_jd',
    description: 'Extract the complete structured JD signal from a job description.',
    input_schema: {
        type: 'object',
        properties: {
            targetRole: {
                type: 'string',
                description: 'The exact job title as stated in the JD (e.g. "Senior Platform Engineer").',
            },
            companyProblem: {
                type: 'string',
                description: 'The underlying problem the company is trying to solve with this role — a 1-3 sentence synthesis of WHY the role exists, inferred from the JD\'s framing (the team\'s mission, what they are building, the pain they describe). NOT the requirements list. Example: "Scaling expert support for a frontier-AI product whose problems are novel and undefined, at a volume where hiring linearly fails — by building a support org that uses automation/agentic AI to scale its own leverage." Empty string only if the JD gives no signal about intent.',
            },
            hardRequirements: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        skill:         { type: 'string' },
                        context:       { type: 'string', description: 'Verbatim or paraphrased context from the JD (e.g. "5+ years production experience").' },
                        disqualifying: { type: 'boolean', description: 'True when not meeting this requirement likely rejects the candidate.' },
                    },
                    required: ['skill', 'context'],
                },
                description: 'Must-have requirements; set disqualifying=true when absence likely rejects the candidate.',
            },
            softRequirements: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        skill:   { type: 'string' },
                        context: { type: 'string' },
                    },
                    required: ['skill', 'context'],
                },
                description: 'Nice-to-have / preferred requirements.',
            },
            implicitRequirements: {
                type: 'array',
                items: { type: 'string' },
                description: 'Unstated but strongly implied expectations (e.g. "on-call availability", "incident-response mindset").',
            },
            technologyInventory: {
                type: 'object',
                properties: {
                    languages:      { type: 'array', items: { type: 'string' }, description: 'Programming languages.' },
                    frameworks:     { type: 'array', items: { type: 'string' }, description: 'Libraries and frameworks.' },
                    infrastructure: { type: 'array', items: { type: 'string' }, description: 'Cloud providers, platforms, infra tools.' },
                    tools:          { type: 'array', items: { type: 'string' }, description: 'Named developer tools, CLIs, platforms.' },
                    methodologies:  { type: 'array', items: { type: 'string' }, description: 'Processes and methodologies (GitOps, Agile, CI/CD…).' },
                },
                description: 'Named technologies grouped by category.',
            },
            experienceSignals: {
                type: 'object',
                properties: {
                    yearsExpected:         { type: 'string', description: 'Expected years of experience, e.g. "5+", "3-5", or "" if unstated.' },
                    domainExperience:      { type: 'string', description: 'Required domain background, e.g. "fintech", "cloud infrastructure".' },
                    leadershipExpectation: { type: 'string', description: 'Leadership signal, e.g. "tech lead", "IC only", "".' },
                    scaleIndicators:       { type: 'string', description: 'Scale signals, e.g. "100k+ users", "multi-region", "".' },
                },
                description: 'Experience and seniority signals from the JD.',
            },
            requiredSkills:    { type: 'array', items: { type: 'string' }, description: 'Hard requirements / must-have skills (flat list, mirrors hardRequirements.skill).' },
            preferredSkills:   { type: 'array', items: { type: 'string' }, description: 'Nice-to-have / preferred skills (flat list).' },
            tools:             { type: 'array', items: { type: 'string' }, description: 'Named technologies, tools, platforms, languages.' },
            concepts:          { type: 'array', items: { type: 'string' }, description: 'Domains / architectural or methodological concepts (e.g. "incident response", "event-driven").' },
            responsibilities:  { type: 'array', items: { type: 'string' }, description: 'Core responsibilities / what the role does day to day.' },
            domain:            { type: 'string', description: 'One-line domain summary (e.g. "Cloud/DevOps platform engineering").' },
            seniority:         { type: 'string', description: 'Seniority signal (e.g. "junior", "mid", "senior", "staff").' },
            retrievalKeywords: { type: 'array', items: { type: 'string' }, description: 'Deduped lowercase technical terms best suited for semantic search over a candidate portfolio.' },
        },
        required: [
            'targetRole', 'companyProblem',
            'hardRequirements', 'softRequirements', 'implicitRequirements',
            'technologyInventory', 'experienceSignals',
            'requiredSkills', 'preferredSkills', 'tools', 'concepts',
            'responsibilities', 'domain', 'seniority', 'retrievalKeywords',
        ],
        additionalProperties: false,
    },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
    'You extract the COMPLETE structured JD signal from a job description. Your only task is to call extract_jd.',
    'You are the single source of JD understanding for the whole pipeline — be thorough and atomic.',
    'Rules:',
    '- Extract only what the JD states or strongly implies. Do not invent skills the JD never mentions.',
    '- companyProblem = the UNDERLYING problem the role exists to solve. Read past the requirements list: infer from the team mission, what they are building, the pain/scale they describe, and how they frame the role. Write 1-3 sentences capturing WHY this role exists and what success changes for the company — the thing a great candidate should position themselves as the solution to. This is judgement, not a keyword list. Empty only if the JD truly gives no signal of intent.',
    '- hardRequirements = must-haves; set disqualifying=true when the absence of the skill/qualification would likely reject the candidate at screening.',
    '- softRequirements = nice-to-haves / "preferred" / "bonus" items.',
    '- implicitRequirements = unstated but strongly implied expectations (e.g. on-call availability, autonomous working style).',
    '- technologyInventory = all named technologies grouped by category (languages / frameworks / infrastructure / tools / methodologies).',
    '- experienceSignals = years expected ("5+", "3-5", "" if unstated), domain, leadership expectation, scale indicators.',
    '- requiredSkills / preferredSkills = flat lists that mirror hardRequirements/softRequirements skill names (for retrieval compatibility).',
    '- tools = concrete named technologies/platforms/languages (Kubernetes, AWS, Terraform, Python…).',
    '- concepts = domains, architectural or methodological ideas (incident response, multi-account governance, observability…).',
    '- retrievalKeywords = a deduped, lowercase set of the most search-worthy technical terms (skills + tools + concepts), best for semantic search over a candidate portfolio. Drop boilerplate, perks, and legal text.',
    '- Use empty arrays/strings when a field is absent — never guess.',
].join('\n');

// ─────────────────────────────────────────────────────────────────────────────
// Primary export: extractJdSignal → JdSignal (never null — fail-open)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the complete JD signal from a job description.
 *
 * FAIL-OPEN: always returns a valid JdSignal. On any error (sanitiser,
 * Bedrock, schema) it returns a minimal JdSignal with all empty fields so
 * the pipeline can continue.
 */
export async function extractJdSignal(jobDescription: string): Promise<JdSignal> {
    const safe = piiScrubber.scrub(jobDescription).redacted.slice(0, MAX_JD_CHARS);
    if (safe.trim().length === 0) return { ...MINIMAL_JD_SIGNAL };

    const config: AgentConfig = {
        agentName:      'jd-extractor',
        modelId:        MODEL_ID,
        maxTokens:      2048,
        thinkingBudget: 0,
        systemPrompt:   [{ text: SYSTEM_PROMPT }],
        pipeline:       'job-strategist',
        tool: {
            name:        TOOL_SCHEMA.name,
            description: TOOL_SCHEMA.description,
            inputSchema: TOOL_SCHEMA.input_schema as Record<string, unknown>,
        },
    };
    const ctx: BasePipelineContext = {
        pipelineId:        'jd-extract',
        environment:       process.env['DEPLOY_ENV'] ?? 'dev',
        cumulativeTokens:  { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
    };

    try {
        const result = await runAgent<JdSignal>({
            config,
            userMessage:     `<job_description>\n${safe}\n</job_description>`,
            pipelineContext: ctx,
            parseResponse: (s) => {
                const v = JdExtractionSchema.safeParse(JSON.parse(s));
                if (!v.success) throw new Error(`jd-extractor: schema validation failed: ${v.error.message}`);
                return v.data as JdSignal;
            },
        });
        log('INFO', 'JD extracted', {
            agent:          'jd-extractor',
            targetRole:     result.data.targetRole,
            requiredSkills: result.data.requiredSkills.length,
            hardReqs:       result.data.hardRequirements.length,
            keywords:       result.data.retrievalKeywords.length,
        });
        return result.data;
    } catch (e) {
        log('WARN', 'JD extraction failed (non-fatal) — returning minimal JdSignal', {
            agent: 'jd-extractor', error: (e as Error).message,
        });
        return { ...MINIMAL_JD_SIGNAL };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Back-compat alias — run-pipeline.ts imports extractJobDescription; Task 5
// will rewire it. Keep the old signature (returns JdSignal which is a superset
// of the old JdExtraction, so ATS callers that typed JdExtraction still compile).
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated Use extractJdSignal. Kept for run-pipeline.ts back-compat until Task 5. */
export const extractJobDescription: (jd: string) => Promise<JdSignal> = extractJdSignal;

// ─────────────────────────────────────────────────────────────────────────────
// Utility helpers (unchanged — callers in research-agent.ts / ats/ still use these)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build sharper KB retrieval queries from the extracted signal — replaces the
 * legacy raw-JD substring queries. Returns the three keyword-driven queries
 * (skills, experience, projects); the DORA query stays static in the agent.
 */
export function jdRetrievalQueries(jd: JdExtraction): { skill: string; experience: string; project: string } {
    const dedupe = (xs: string[]): string => [...new Set(xs.map((s) => s.trim()).filter(Boolean))].join(' ');
    const skillTerms = [...jd.requiredSkills, ...jd.preferredSkills, ...jd.tools, ...jd.retrievalKeywords];
    return {
        skill:      dedupe(skillTerms),
        experience: `professional experience skills qualifications ${dedupe([...jd.responsibilities, ...jd.concepts])}`,
        project:    `portfolio project implementation achievements ${dedupe([...jd.tools, ...jd.concepts])}`,
    };
}

/** Compact structured summary of the extraction for the Research prompt (additive view). */
export function formatJdExtraction(jd: JdExtraction): string {
    const line = (label: string, xs: string[]): string | null => (xs.length > 0 ? `- ${label}: ${xs.join(', ')}` : null);
    const lines = [
        'EXTRACTED JD SIGNAL (a structured read of the job description above — use as a checklist; the JD prose remains authoritative):',
        jd.domain ? `- Domain: ${jd.domain}` : null,
        jd.seniority ? `- Seniority: ${jd.seniority}` : null,
        line('Required skills', jd.requiredSkills),
        line('Preferred skills', jd.preferredSkills),
        line('Tools', jd.tools),
        line('Concepts', jd.concepts),
        line('Responsibilities', jd.responsibilities),
    ].filter((x): x is string => x !== null);
    return lines.join('\n');
}
