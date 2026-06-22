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
import { capHighlights } from './experience-cap.js';
import { jdAtsKeywords } from '../ats/jd-keywords-union.js';
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
                                highlights: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5 },
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
    const data = validated.data as FreeResumeOutput;
    // Deterministic per-role bullet cap — independent of whether the model honoured maxItems.
    return { ...data, resume: { ...data.resume, experience: capHighlights(data.resume.experience) } };
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
        evidence.commitPrEvidence,
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

/**
 * Return true when the number token is an exact member of the corpus number-token set.
 *
 * Builds a Set<string> from the corpus's numeric tokens so that "4" is only
 * grounded when "4" appears as a standalone token — not as a digit-substring of
 * a PR number like "42".  This closes the substring-collision false-negative
 * that allowed fabricated small integers to pass whenever their digits were
 * embedded in a larger number in the evidence.
 */
function buildCorpusNumberTokenSet(corpus: string): Set<string> {
    return new Set(extractNumberTokens(corpus).map((t) => t.toLowerCase()));
}

/** Return true when the number token is an exact member of the corpus token set. */
function isMetricGrounded(token: string, corpusTokens: Set<string>): boolean {
    return corpusTokens.has(token.toLowerCase());
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

/** Role/seniority cue that must lead the summary when positioning evidence exists. */
const SENIORITY_CUE = /\b(senior|staff|lead|principal|engineer|architect|specialist)\b/i;

/**
 * Return a positioning failure when positioning evidence exists but the
 * summary's first sentence carries no role/seniority cue. Empty array otherwise.
 */
function gradePositioning(out: FreeResumeOutput, evidence: FreeEvidence): string[] {
    if (evidence.profileIntelligence.trim().length === 0) return [];
    const firstSentence = (out.resume.summary.split(/[.!?]/)[0] ?? '').trim();
    if (SENIORITY_CUE.test(firstSentence)) return [];
    return ['summary does not open with a positioning line (role/seniority) despite positioning evidence'];
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
    const corpus         = buildEvidenceCorpus(evidence);
    const corpusTokens   = buildCorpusNumberTokenSet(corpus);
    const failures: string[] = [];

    // 1. Employer grounding
    for (const company of collectEmployers(out)) {
        if (!isKnownEmployer(company, evidence.careerFacts)) {
            failures.push(`Fabricated employer: "${company}" not found in career facts.`);
        }
    }

    // 2. Metric grounding — summary, bullets, achievements, projects
    //    Uses token-exact Set membership so "4" is only grounded when "4"
    //    appears as a standalone token, not as a substring of "42".
    const allText = collectGradedText(out);
    for (const text of allText) {
        for (const token of extractNumberTokens(text)) {
            if (!isMetricGrounded(token, corpusTokens)) {
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

    // 4. Per-role bullet cap check
    for (const e of out.resume.experience) {
        if (e.highlights.length > 5) {
            failures.push(`experience role "${e.company}" has more than 5 highlights (${e.highlights.length}) — cap to the 5 most JD-relevant`);
        }
    }

    // 5. Positioning lead — only when positioning evidence exists
    failures.push(...gradePositioning(out, evidence));

    return { pass: failures.length === 0, failures };
}

// =============================================================================
// AGENT USER MESSAGE BUILDER
// =============================================================================

function buildUserMessage(input: FreeWriterInput): string {
    const { jdSignal, evidence, targetRole, targetCompany } = input;
    const mustHave = jdSignal.hardRequirements.map((r) => r.skill).filter((s) => s.length > 0);
    const atsKeywords = jdAtsKeywords(jdSignal);
    return [
        `<target_role>${targetRole}</target_role>`,
        `<target_company>${targetCompany}</target_company>`,
        `<company_problem>${jdSignal.companyProblem}</company_problem>`,
        `<required_skills>${jdSignal.requiredSkills.join(', ')}</required_skills>`,
        mustHave.length ? `<must_have_skills>${mustHave.join(', ')}</must_have_skills>` : '',
        jdSignal.tools.length ? `<jd_tools>${jdSignal.tools.join(', ')}</jd_tools>` : '',
        jdSignal.concepts.length ? `<jd_concepts>${jdSignal.concepts.join(', ')}</jd_concepts>` : '',
        atsKeywords.length ? `<ats_keywords>${atsKeywords.join(', ')}</ats_keywords>` : '',
        '<evidence>',
        `<kb_passages>\n${evidence.kbPassages.join('\n\n')}\n</kb_passages>`,
        `<project_evidence>${evidence.projectEvidence}</project_evidence>`,
        `<extracted_tech>${evidence.extractedTech}</extracted_tech>`,
        `<career_facts>${evidence.careerFacts}</career_facts>`,
        `<education_facts>${evidence.educationFacts}</education_facts>`,
        evidence.commitPrEvidence ? `<commit_pr_evidence>\n${evidence.commitPrEvidence}\n</commit_pr_evidence>` : '',
        evidence.achievementEvidence ? `<achievements_and_impact>\n${evidence.achievementEvidence}\n</achievements_and_impact>` : '',
        evidence.profileIntelligence ? `<positioning_signal>\n${evidence.profileIntelligence}\n</positioning_signal>` : '',
        '</evidence>',
    ].filter((line) => line !== '').join('\n');
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
