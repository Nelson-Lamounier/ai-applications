/**
 * @format
 * Free-tier narrative resume writer — LLM #2 in the free-tier pipeline.
 *
 * Combines the impact-bullet resume and the cover letter into a single
 * Sonnet call, enforcing the anti-hallucination storytelling contract
 * defined in the free-resume-persona prompt.
 *
 * Also exports gradeFreeResume — a deterministic grounding grader that
 * rejects fabricated employers, unsupported metrics, and non-action-verb
 * bullets without making any LLM calls.
 */
import { z } from 'zod';
import { runAgent, parseJsonResponse } from '@bedrock/shared';
import type { AgentConfig, BasePipelineContext } from '@bedrock/shared';
import type { JdSignal } from '@bedrock/shared';
import { StructuredResumeDataSchema } from '../schemas/resume-data.schema.js';
import type { StructuredResumeData, CoverLetter } from '@bedrock/shared';
import { FREE_RESUME_SYSTEM_PROMPT } from '../prompts/free-resume-persona.js';
import { CoverLetterSchema } from './strategist-agent.js';
import type { FreeEvidence } from '../free/gather-evidence.js';

// =============================================================================
// OUTPUT TYPES
// =============================================================================

/** Combined resume + cover letter emitted by the free writer. */
export interface FreeResumeOutput {
    readonly resume: StructuredResumeData;
    readonly coverLetter: CoverLetter;
}

/** Input envelope for the free resume writer. */
export interface FreeWriterInput {
    readonly jdSignal: JdSignal;
    readonly evidence: FreeEvidence;
    readonly targetRole: string;
    readonly targetCompany: string;
}

/** Public contract for the free resume writer. */
export interface FreeWriter {
    invoke(input: FreeWriterInput, ctx: BasePipelineContext): Promise<FreeResumeOutput>;
}

// =============================================================================
// GRADER RESULT
// =============================================================================

export interface GradeResult {
    readonly pass: boolean;
    readonly failures: string[];
}

// =============================================================================
// ZOD VALIDATION SCHEMAS
// =============================================================================

const FreeResumeOutputSchema = z.object({
    resume:      StructuredResumeDataSchema,
    coverLetter: CoverLetterSchema,
});

// =============================================================================
// TOOL DEFINITION — emit_free_resume
// =============================================================================

/**
 * Forced tool schema that makes the model return a structured payload rather
 * than free-text.  The inputSchema mirrors StructuredResumeDataSchema + the
 * cover-letter shape from strategist-agent.ts.
 */
const FREE_RESUME_TOOL: AgentConfig['tool'] = {
    name:        'emit_free_resume',
    description: 'Emit the tailored resume and cover letter as a structured JSON object.',
    inputSchema: {
        type: 'object',
        required: ['resume', 'coverLetter'],
        properties: {
            resume: {
                type: 'object',
                required: ['profile', 'summary', 'experience', 'skills', 'education', 'certifications', 'projects', 'keyAchievements'],
                properties: {
                    profile: {
                        type: 'object',
                        required: ['name', 'title', 'email', 'location'],
                        properties: {
                            name:     { type: 'string' },
                            title:    { type: 'string' },
                            email:    { type: 'string' },
                            location: { type: 'string' },
                            linkedin: { type: 'string' },
                            github:   { type: 'string' },
                            website:  { type: 'string' },
                        },
                    },
                    summary:     { type: 'string' },
                    experience: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['company', 'title', 'period', 'highlights'],
                            properties: {
                                company:    { type: 'string' },
                                title:      { type: 'string' },
                                period:     { type: 'string' },
                                highlights: { type: 'array', items: { type: 'string' } },
                            },
                        },
                    },
                    skills: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['category', 'skills'],
                            properties: {
                                category: { type: 'string' },
                                skills:   { type: 'array', items: { type: 'string' } },
                            },
                        },
                    },
                    education: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['degree', 'institution', 'period'],
                            properties: {
                                degree:      { type: 'string' },
                                institution: { type: 'string' },
                                period:      { type: 'string' },
                            },
                        },
                    },
                    certifications: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['name', 'year', 'issuer'],
                            properties: {
                                name:   { type: 'string' },
                                year:   { type: 'string' },
                                issuer: { type: 'string' },
                            },
                        },
                    },
                    projects: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['name', 'description'],
                            properties: {
                                name:        { type: 'string' },
                                description: { type: 'string' },
                                github:      { type: 'string' },
                            },
                        },
                    },
                    keyAchievements: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['achievement'],
                            properties: {
                                achievement: { type: 'string' },
                            },
                        },
                    },
                    sectionOrder: { type: 'array', items: { type: 'string' } },
                },
            },
            coverLetter: {
                type: 'object',
                required: ['greeting', 'paragraphs', 'signoff'],
                properties: {
                    greeting:   { type: 'string' },
                    paragraphs: { type: 'array', items: { type: 'string' } },
                    signoff: {
                        type: 'object',
                        required: ['name', 'email', 'linkedin', 'github'],
                        properties: {
                            name:     { type: 'string' },
                            email:    { type: 'string' },
                            linkedin: { type: 'string' },
                            github:   { type: 'string' },
                        },
                    },
                },
            },
        },
    },
};

// =============================================================================
// PARSE FUNCTION
// =============================================================================

/**
 * Parse and validate the JSON string emitted by the tool call.
 *
 * @param text - Raw JSON string from the tool input
 * @returns Validated FreeResumeOutput
 * @throws Error when JSON is malformed or schema validation fails
 */
export function parseFreeResumeResponse(text: string): FreeResumeOutput {
    const parsed = parseJsonResponse<unknown>(text, 'free-resume-writer');
    const validated = FreeResumeOutputSchema.safeParse(parsed);
    if (!validated.success) {
        throw new Error(
            `free-resume-writer: schema validation failed: ${validated.error.message}`,
        );
    }
    return validated.data as FreeResumeOutput;
}

// =============================================================================
// GRADER HELPERS
// =============================================================================

/** Small set of English stopwords that cannot open an impact bullet. */
const STOPWORDS = new Set([
    'the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'our', 'i',
    'we', 'it', 'its', 'their', 'was', 'were', 'is', 'are', 'has', 'had',
    'have', 'been', 'be', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'to',
    'with', 'and', 'or', 'but', 'not', 'from', 'all', 'also', 'then',
]);

/** Build a lowercased corpus string from all evidence fields. */
function buildEvidenceCorpus(evidence: FreeEvidence): string {
    return [
        evidence.kbPassages.join(' '),
        evidence.projectEvidence,
        evidence.extractedTech,
        evidence.careerFacts,
        evidence.educationFacts,
    ].join(' ').toLowerCase();
}

/** Extract all experience company names from the resume. */
function collectEmployers(output: FreeResumeOutput): string[] {
    return output.resume.experience.map((e: { company: string }) => e.company);
}

/** Collect every bullet string from all experience entries. */
function collectAllHighlights(output: FreeResumeOutput): string[] {
    return output.resume.experience.flatMap((e: { highlights: string[] }) => e.highlights);
}

/** Return true when the employer name appears in the career facts (case-insensitive). */
function isKnownEmployer(company: string, careerFacts: string): boolean {
    return careerFacts.toLowerCase().includes(company.toLowerCase());
}

/** Return true when the number token appears anywhere in the evidence corpus. */
function isMetricGrounded(token: string, corpus: string): boolean {
    return corpus.includes(token.toLowerCase());
}

/** Return true when the first word of a bullet is an alphabetic action verb. */
function startsWithActionVerb(bullet: string): boolean {
    const firstWord = bullet.trim().split(/\s+/)[0] ?? '';
    if (!/^[A-Za-z]+$/.test(firstWord)) return false;
    return !STOPWORDS.has(firstWord.toLowerCase());
}

/** Extract numeric tokens from a string (e.g. "93%", "4000", "1.3M"). */
function extractNumberTokens(text: string): string[] {
    return (text.match(/\b\d[\d,.]*(?:[kmb]|[KMB])?\b|\b\d[\d,.]*%/gi) ?? []);
}

// =============================================================================
// GRADER
// =============================================================================

/**
 * Collect all text strings that are subject to metric-grounding checks:
 * summary, experience highlights, keyAchievements, and project descriptions.
 */
function collectGradedText(out: FreeResumeOutput): string[] {
    const achievements = out.resume.keyAchievements.map(
        (a: { achievement: string }) => a.achievement,
    );
    const projectDescs = out.resume.projects.map(
        (p: { description: string }) => p.description,
    );
    return [out.resume.summary, ...collectAllHighlights(out), ...achievements, ...projectDescs];
}

/**
 * Deterministic anti-fabrication grader.
 *
 * Checks:
 *   1. Each experience company must appear in evidence.careerFacts.
 *   2. Every numeric token in highlights/summary must appear in the evidence corpus.
 *   3. Every highlight must open with an alphabetic action verb.
 *
 * Returns { pass: true, failures: [] } when all checks pass.
 *
 * @param out      - The FreeResumeOutput to grade
 * @param evidence - The FreeEvidence used to produce the output
 */
export function gradeFreeResume(
    out: FreeResumeOutput,
    evidence: FreeEvidence,
): GradeResult {
    const corpus    = buildEvidenceCorpus(evidence);
    const failures: string[] = [];

    // 1. Employer grounding
    for (const company of collectEmployers(out)) {
        if (!isKnownEmployer(company, evidence.careerFacts)) {
            failures.push(`Fabricated employer: "${company}" not found in career facts.`);
        }
    }

    // 2. Metric grounding — summary, bullets, achievements, projects
    const allText = collectGradedText(out);
    for (const text of allText) {
        for (const token of extractNumberTokens(text)) {
            if (!isMetricGrounded(token, corpus)) {
                failures.push(`Fabricated metric "${token}" in: "${text}".`);
            }
        }
    }

    // 3. Action-verb format
    for (const bullet of collectAllHighlights(out)) {
        if (!startsWithActionVerb(bullet)) {
            failures.push(`Missing action verb on bullet: "${bullet}".`);
        }
    }

    return { pass: failures.length === 0, failures };
}

// =============================================================================
// AGENT USER MESSAGE BUILDER
// =============================================================================

function buildUserMessage(input: FreeWriterInput): string {
    const { jdSignal, evidence, targetRole, targetCompany } = input;
    return [
        `<target_role>${targetRole}</target_role>`,
        `<target_company>${targetCompany}</target_company>`,
        `<company_problem>${jdSignal.companyProblem}</company_problem>`,
        `<required_skills>${jdSignal.requiredSkills.join(', ')}</required_skills>`,
        '<evidence>',
        `<kb_passages>\n${evidence.kbPassages.join('\n\n')}\n</kb_passages>`,
        `<project_evidence>${evidence.projectEvidence}</project_evidence>`,
        `<extracted_tech>${evidence.extractedTech}</extracted_tech>`,
        `<career_facts>${evidence.careerFacts}</career_facts>`,
        `<education_facts>${evidence.educationFacts}</education_facts>`,
        '</evidence>',
    ].join('\n');
}

// =============================================================================
// AGENT IMPLEMENTATION
// =============================================================================

const MODEL_ID = process.env['STRATEGIST_MODEL'] ?? 'eu.anthropic.claude-sonnet-4-6';

const FREE_RESUME_CONFIG: AgentConfig = {
    agentName:      'free-resume-writer',
    modelId:        MODEL_ID,
    maxTokens:      16384,
    thinkingBudget: 0,
    systemPrompt:   [{ text: FREE_RESUME_SYSTEM_PROMPT }],
    pipeline:       'job-strategist',
    tool:           FREE_RESUME_TOOL,
};

/**
 * Bedrock-backed free resume writer.
 *
 * Invokes Sonnet with the forced emit_free_resume tool, parses and
 * validates the response, then returns the typed FreeResumeOutput.
 */
export const bedrockFreeResumeWriter: FreeWriter = {
    async invoke(input: FreeWriterInput, ctx: BasePipelineContext): Promise<FreeResumeOutput> {
        const result = await runAgent<FreeResumeOutput>({
            config:          FREE_RESUME_CONFIG,
            userMessage:     buildUserMessage(input),
            pipelineContext: ctx,
            parseResponse:   parseFreeResumeResponse,
        });
        return result.data;
    },
};
