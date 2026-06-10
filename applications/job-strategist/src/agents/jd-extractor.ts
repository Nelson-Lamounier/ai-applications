/**
 * @format
 * JD Extractor — Phase 0 of the analyse pipeline.
 *
 * Turns the raw (pasted) job description into a small structured signal
 * (required/preferred skills, tools, concepts, responsibilities, domain,
 * seniority, retrieval keywords) via a cheap forced-tool Haiku call.
 *
 * Purpose: the Research agent's KB queries were built from raw JD *substrings*,
 * which dilutes the embedding with boilerplate. Querying with the extracted
 * skills/keywords sharpens retrieval → better verified matches / gaps. ADDITIVE:
 * the raw JD still flows to Research; this only improves retrieval + reuse.
 *
 * FAIL-OPEN: any failure returns null and the pipeline falls back to the legacy
 * substring queries — extraction must never block a run.
 */
import { z } from 'zod';
import { PiiScrubber, runAgent, log } from '@bedrock/shared';
import type { AgentConfig, BasePipelineContext } from '@bedrock/shared';

const piiScrubber = new PiiScrubber();
const MODEL_ID = process.env['JD_EXTRACTOR_MODEL_ID'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
const MAX_JD_CHARS = 20_000;

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

export const JdExtractionSchema = z.object({
    requiredSkills:    z.array(z.string()).default([]),
    preferredSkills:   z.array(z.string()).default([]),
    tools:             z.array(z.string()).default([]),
    concepts:          z.array(z.string()).default([]),
    responsibilities:  z.array(z.string()).default([]),
    domain:            z.string().default(''),
    seniority:         z.string().default(''),
    retrievalKeywords: z.array(z.string()).default([]),
});

const TOOL_SCHEMA = {
    name: 'extract_jd',
    description: 'Extract structured hiring signal from a job description.',
    input_schema: {
        type: 'object',
        properties: {
            requiredSkills:    { type: 'array', items: { type: 'string' }, description: 'Hard requirements / must-have skills.' },
            preferredSkills:   { type: 'array', items: { type: 'string' }, description: 'Nice-to-have / preferred skills.' },
            tools:             { type: 'array', items: { type: 'string' }, description: 'Named technologies, tools, platforms, languages.' },
            concepts:          { type: 'array', items: { type: 'string' }, description: 'Domains / architectural or methodological concepts (e.g. "incident response", "event-driven").' },
            responsibilities:  { type: 'array', items: { type: 'string' }, description: 'Core responsibilities / what the role does day to day.' },
            domain:            { type: 'string', description: 'One-line domain summary (e.g. "Cloud/DevOps platform engineering").' },
            seniority:         { type: 'string', description: 'Seniority signal (e.g. "junior", "mid", "senior", "staff").' },
            retrievalKeywords: { type: 'array', items: { type: 'string' }, description: 'Deduped lowercase technical terms best suited for semantic search over a candidate portfolio.' },
        },
        required: ['requiredSkills', 'preferredSkills', 'tools', 'concepts', 'responsibilities', 'domain', 'seniority', 'retrievalKeywords'],
        additionalProperties: false,
    },
} as const;

const SYSTEM_PROMPT = [
    'You extract structured hiring signal from a job description. Your only task is to call extract_jd.',
    'Rules:',
    '- Extract only what the JD states or strongly implies. Do not invent skills the JD never mentions.',
    '- Separate hard requirements (requiredSkills) from nice-to-haves (preferredSkills).',
    '- tools = concrete named technologies/platforms/languages (Kubernetes, AWS, Terraform, Python…).',
    '- concepts = domains, architectural or methodological ideas (incident response, multi-account governance, observability…).',
    '- retrievalKeywords = a deduped, lowercase set of the most search-worthy technical terms (skills + tools + concepts), best for semantic search over a candidate portfolio. Drop boilerplate, perks, and legal text.',
    '- Use empty arrays/strings when a field is absent — never guess.',
].join('\n');

/**
 * Extract structured signal from a job description. FAIL-OPEN: returns null on
 * any error (sanitiser, Bedrock, schema) so the pipeline falls back to legacy
 * substring retrieval.
 */
export async function extractJobDescription(jobDescription: string): Promise<JdExtraction | null> {
    const safe = piiScrubber.scrub(jobDescription).redacted.slice(0, MAX_JD_CHARS);
    if (safe.trim().length === 0) return null;

    const config: AgentConfig = {
        agentName:      'jd-extractor',
        modelId:        MODEL_ID,
        maxTokens:      2048,
        thinkingBudget: 0,
        systemPrompt:   [{ text: SYSTEM_PROMPT }],
        pipeline:       'job-strategist',
        tool: { name: TOOL_SCHEMA.name, description: TOOL_SCHEMA.description, inputSchema: TOOL_SCHEMA.input_schema as Record<string, unknown> },
    };
    const ctx: BasePipelineContext = {
        pipelineId:        'jd-extract',
        environment:       process.env['DEPLOY_ENV'] ?? 'dev',
        cumulativeTokens:  { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
    };

    try {
        const result = await runAgent<JdExtraction>({
            config,
            userMessage:     `<job_description>\n${safe}\n</job_description>`,
            pipelineContext: ctx,
            parseResponse: (s) => {
                const v = JdExtractionSchema.safeParse(JSON.parse(s));
                if (!v.success) throw new Error(`jd-extractor: schema validation failed: ${v.error.message}`);
                return v.data;
            },
        });
        log('INFO', 'JD extracted', {
            agent: 'jd-extractor',
            requiredSkills: result.data.requiredSkills.length,
            keywords:       result.data.retrievalKeywords.length,
        });
        return result.data;
    } catch (e) {
        log('WARN', 'JD extraction failed (non-fatal) — falling back to substring retrieval', {
            agent: 'jd-extractor', error: (e as Error).message,
        });
        return null;
    }
}

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
