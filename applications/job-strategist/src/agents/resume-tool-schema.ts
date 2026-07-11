/**
 * @format
 * Shared resume structured-output schema — the single source of truth for the
 * `emit_resume` Haiku rewrite tool used by BOTH the resume guard
 * (resume-guard.ts) and the keyword-surfacing rewrite (surface-keywords.ts).
 *
 * Keeping the Zod safety-net and the Bedrock tool input schema here means the two
 * rewrite paths can never drift, and there is exactly one place to evolve the
 * resume shape. `buildEmitResumeTool` lets each caller supply its own tool
 * description while reusing the identical input schema.
 */

import { z } from 'zod';

export const ProfileSchema = z.object({
    name: z.string(),
    title: z.string(),
    email: z.string(),
    location: z.string(),
    linkedin: z.string().optional(),
    github: z.string().optional(),
}).passthrough();

export const ExperienceSchema = z.object({
    company: z.string(),
    title: z.string(),
    period: z.string(),
    highlights: z.array(z.string()),
}).passthrough();

export const SkillCategorySchema = z.object({
    category: z.string(),
    // Haiku rewrite passes occasionally emit the skill list as ONE
    // comma-joined string ("CDK, Docker, Kubernetes") — that shape failure
    // made the resume-expand pass fail-open and left a run under-filled.
    // Coerce deterministically instead of rejecting a paid invocation.
    skills: z.preprocess(
        (v) => (typeof v === 'string' ? v.split(',').map((t) => t.trim()).filter(Boolean) : v),
        z.array(z.string()),
    ),
}).passthrough();

export const EducationSchema = z.object({
    degree: z.string(),
    institution: z.string(),
    period: z.string(),
}).passthrough();

/** Full resume Zod schema — the runtime safety-net for the Haiku emit_resume output. */
export const ResumeRewriteSchema = z.object({
    profile: ProfileSchema,
    summary: z.string(),
    experience: z.array(ExperienceSchema),
    skills: z.array(SkillCategorySchema),
    education: z.array(EducationSchema),
    certifications: z.array(z.object({}).passthrough()),
    projects: z.array(z.object({}).passthrough()),
    // keyAchievements items MUST carry the achievement string — the
    // number-provenance guard scrubs it, and an unshaped item let the
    // resume-expand model emit `{title}`-only entries (run 850b81d0).
    keyAchievements: z.array(z.object({ achievement: z.string() }).passthrough()),
    sectionOrder: z.array(z.string()).optional(),
});

/** The Bedrock tool `input_schema` for `emit_resume` (plain-text strings, no markdown). */
export const RESUME_EMIT_INPUT_SCHEMA = {
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
        // Shape projects so re-emit passes (surface-metrics/keywords, condense)
        // PRESERVE the technical bullets. With an unshaped `{type:'object'}` the
        // Haiku model dropped projects[].highlights on every re-emit, blanking
        // the Projects section even after relocation/fill populated it.
        projects: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string' }, description: { type: 'string' }, github: { type: 'string' },
                    highlights: { type: 'array', items: { type: 'string' } },
                },
                required: ['name', 'description'],
            },
        },
        keyAchievements: {
            type: 'array',
            items: {
                type: 'object',
                properties: { achievement: { type: 'string' } },
                required: ['achievement'],
            },
        },
        sectionOrder: { type: 'array', items: { type: 'string' } },
    },
    required: ['profile', 'summary', 'experience', 'skills', 'education', 'certifications', 'projects', 'keyAchievements'],
    additionalProperties: false,
} as const;

/** Build an `emit_resume` tool with a caller-specific description over the shared input schema. */
export function buildEmitResumeTool(description: string) {
    return { name: 'emit_resume', description, input_schema: RESUME_EMIT_INPUT_SCHEMA } as const;
}
