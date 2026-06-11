/** @format */
import { z } from 'zod';
import { runAgent, log } from '@bedrock/shared';
import type { AgentConfig, BasePipelineContext } from '@bedrock/shared';
import type { StructuredResumeData } from '@bedrock/shared';

export interface ResumeViolation { code: string; detail: string; }
export interface ResumeGuardCtx {
    targetRole: string;
    leadIdentity: string;
    verifiedEducation: string[];
    archetypeSkillLead: string;
}

const GAP_RE = /falls?\s+short|\b\d{1,2}\s*years?\b[^.]{0,40}\b(?:short|threshold|bar|requirement|fall)|do(?:es)?\s*not\s+yet\s+have/i;

/**
 * Generic stop-words that appear in many identities and are not differentiating
 * (e.g. "engineer", "builds", "years", "with", "who").
 */
const GENERIC_TOKENS = new Set(['engineer', 'builds', 'build', 'years', 'with', 'from', 'that', 'this', 'have', 'been', 'into', 'your', 'their', 'where', 'what', 'will', 'more', 'over', 'about', 'some', 'when', 'than', 'like']);

/**
 * Returns the distinctive lead tokens from the identity string — words that
 * identify the archetype cluster (e.g. "support", "production") — by taking
 * the first token that is not in GENERIC_TOKENS.
 */
function leadClusterTokens(leadIdentity: string): string[] {
    const all = leadIdentity.toLowerCase().split(/[^a-z]+/).filter((t) => t.length > 3);
    return all.filter((t) => !GENERIC_TOKENS.has(t));
}

export function validateResume(resume: StructuredResumeData, ctx: ResumeGuardCtx): ResumeViolation[] {
    const out: ResumeViolation[] = [];
    const title = resume.profile.title.trim();

    const hasSeparator = /[·—|]/.test(title);
    const employmentTitles = new Set(resume.experience.map((e) => e.title.toLowerCase().trim()));
    if (title && (!hasSeparator || employmentTitles.has(title.toLowerCase()))) {
        out.push({ code: 'headline_is_title', detail: `profile.title "${title}" reads as a job-title claim, not a positioning headline.` });
    }

    const summary = resume.summary.trim();
    const firstSentence = summary.split(/(?<=[.!?])\s/)[0]?.toLowerCase() ?? '';
    const tokens = leadClusterTokens(ctx.leadIdentity);
    if (summary && tokens.length > 0 && !tokens.some((t) => firstSentence.includes(t))) {
        out.push({ code: 'summary_wrong_cluster', detail: 'Summary opener does not lead with the archetype lead-identity differentiator.' });
    }

    if (GAP_RE.test(summary)) {
        out.push({ code: 'summary_names_gap', detail: 'Summary names/concedes the experience gap.' });
    }

    const verifiedLower = new Set(ctx.verifiedEducation.map((v) => v.toLowerCase()));
    for (const ed of resume.education) {
        const deg = ed.degree.toLowerCase();
        if (deg && !Array.from(verifiedLower).some((v) => v.includes(deg) || deg.includes(v))) {
            out.push({ code: 'education_mismatch', detail: `Education "${ed.degree}" not in the verified facts.` });
            break;
        }
    }

    if (ctx.archetypeSkillLead) {
        const firstCat = (resume.skills[0]?.category ?? '').toLowerCase();
        if (firstCat && firstCat !== ctx.archetypeSkillLead.toLowerCase()) {
            out.push({ code: 'skills_lead_mismatch', detail: `First skill group "${resume.skills[0]?.category}" is not the archetype lead "${ctx.archetypeSkillLead}".` });
        }
    }

    return out;
}

// =============================================================================
// HAIKU REWRITE + GUARD ORCHESTRATOR
// =============================================================================

const MODEL_ID = process.env['RESUME_REWRITE_MODEL'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

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

const CertificationSchema = z.object({}).passthrough();
const ProjectSchema = z.object({}).passthrough();
const AchievementSchema = z.object({}).passthrough();

const RewriteSchema = z.object({
    profile: ProfileSchema,
    summary: z.string(),
    experience: z.array(ExperienceSchema),
    skills: z.array(SkillCategorySchema),
    education: z.array(EducationSchema),
    certifications: z.array(CertificationSchema),
    projects: z.array(ProjectSchema),
    keyAchievements: z.array(AchievementSchema),
    sectionOrder: z.array(z.string()).optional(),
});

const TOOL = {
    name: 'emit_resume',
    description: 'Return the corrected resume as structured JSON (plain text strings, NO markdown).',
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
    pipelineId: 'resume-guard',
    environment: process.env['DEPLOY_ENV'] ?? 'dev',
    cumulativeTokens: { input: 0, output: 0, thinking: 0 },
    cumulativeCostUsd: 0,
};

/** Haiku rewrite that fixes ONLY the flagged issues. FAIL-OPEN: returns the input on error. */
export async function rewriteResume(
    resume: StructuredResumeData,
    violations: ResumeViolation[],
    ctx: ResumeGuardCtx,
): Promise<StructuredResumeData> {
    const system = [
        'You repair a tailored resume, fixing ONLY the listed issues by REORDERING and REWORDING for prominence. Call emit_resume with the full resume JSON.',
        `NEVER fabricate, NEVER change a number or date, NEVER rename a degree — the verified degree names are: ${ctx.verifiedEducation.join('; ')}.`,
        `Make the summary's FIRST sentence lead with this identity differentiator: "${ctx.leadIdentity}" — never an infrastructure-first opener; never name or concede any experience gap.`,
        `Put the "${ctx.archetypeSkillLead}" skill group FIRST (if present); within each group, JD-matched terms first.`,
        'Within each experience role, lead with the strongest number-led bullet.',
        'Preserve every fact, all education names verbatim, and the profile identity. Output plain-text strings, no markdown.',
    ].join('\n');

    const config: AgentConfig = {
        agentName: 'resume-rewrite',
        modelId: MODEL_ID,
        maxTokens: 8000,
        thinkingBudget: 0,
        systemPrompt: [{ text: system }],
        pipeline: 'job-strategist',
        tool: { name: TOOL.name, description: TOOL.description, inputSchema: TOOL.input_schema as Record<string, unknown> },
    };

    const userMessage = `<issues>${violations.map((v) => v.code).join(', ')}</issues>\n<resume>${JSON.stringify(resume)}</resume>`;

    try {
        const result = await runAgent<StructuredResumeData>({
            config, userMessage, pipelineContext: CTX,
            parseResponse: (s) => {
                const parsed = RewriteSchema.safeParse(JSON.parse(s));
                if (!parsed.success) throw new Error(`resume-rewrite: ${parsed.error.message}`);
                return parsed.data as unknown as StructuredResumeData;
            },
        });
        return result.data;
    } catch (e) {
        log('WARN', 'resume rewrite failed — keeping original', { error: e instanceof Error ? e.message : String(e) });
        return resume;
    }
}

/** Validate → rewrite on violation → return. Never throws. */
export async function guardResume(
    resume: StructuredResumeData,
    ctx: ResumeGuardCtx,
): Promise<{ resume: StructuredResumeData; violations: ResumeViolation[] }> {
    const violations = validateResume(resume, ctx);
    if (violations.length === 0) return { resume, violations };
    const fixed = await rewriteResume(resume, violations, ctx);
    return { resume: fixed, violations };
}
