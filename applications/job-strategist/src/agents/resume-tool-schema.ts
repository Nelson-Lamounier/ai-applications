/**
 * @format
 * Shared resume structured-output schema for the `emit_resume` Haiku rewrite
 * tool used by BOTH the resume guard (resume-guard.ts) and the
 * keyword-surfacing rewrite (surface-keywords.ts).
 *
 * Section shapes DERIVE from the canonical bases in schemas/resume-sections.ts
 * (the single source of truth) — tolerant variants here: `.passthrough()` so a
 * model-added key survives, `.partial()` where the net must accept sparse
 * output rather than void a paid invocation. The hand-written Bedrock JSON
 * `input_schema` below is pinned to the same bases by the drift test.
 * `buildEmitResumeTool` lets each caller supply its own tool description while
 * reusing the identical input schema.
 */

import { z } from 'zod';
import {
    ProfileBaseSchema,
    ExperienceBaseSchema,
    SkillCategoryBaseSchema,
    EducationBaseSchema,
    CertificationBaseSchema,
    ProjectBaseSchema,
    AchievementBaseSchema,
    SECTION_SHAPE_KEYS,
} from '../schemas/resume-sections.js';

export { SECTION_SHAPE_KEYS };

export const ProfileSchema = ProfileBaseSchema.passthrough();

export const ExperienceSchema = ExperienceBaseSchema.passthrough();

export const SkillCategorySchema = SkillCategoryBaseSchema.extend({
    // Haiku rewrite passes occasionally emit the skill list as ONE
    // comma-joined string ("CDK, Docker, Kubernetes") — that shape failure
    // made the resume-expand pass fail-open and left a run under-filled.
    // Coerce deterministically instead of rejecting a paid invocation.
    skills: z.preprocess(
        (v) => (typeof v === 'string' ? v.split(',').map((t) => t.trim()).filter(Boolean) : v),
        z.array(z.string()),
    ),
}).passthrough();

export const EducationSchema = EducationBaseSchema.passthrough();

/** Full resume Zod schema — the runtime safety-net for the Haiku emit_resume output. */
export const ResumeRewriteSchema = z.object({
    profile: ProfileSchema,
    summary: z.string(),
    experience: z.array(ExperienceSchema),
    skills: z.array(SkillCategorySchema),
    education: z.array(EducationSchema),
    // Tolerant: sparse model output must not void a paid invocation (consumers
    // safeParse + fail-open), but the keys are DECLARED so nothing is stripped.
    certifications: z.array(CertificationBaseSchema.partial().passthrough()),
    projects: z.array(ProjectBaseSchema.partial().passthrough()),
    // keyAchievements items MUST carry the achievement string — the
    // number-provenance guard scrubs it, and an unshaped item let the
    // resume-expand model emit `{title}`-only entries (run 850b81d0).
    keyAchievements: z.array(AchievementBaseSchema.passthrough()),
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
                website: { type: 'string' },
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
        certifications: {
            type: 'array',
            items: {
                type: 'object',
                properties: { name: { type: 'string' }, year: { type: 'string' }, issuer: { type: 'string' } },
            },
        },
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
