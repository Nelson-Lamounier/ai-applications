/**
 * @format
 * Canonical resume section shapes — the SINGLE SOURCE OF TRUTH for every
 * runtime schema that touches `StructuredResumeData`.
 *
 * Three validation layers used to declare these shapes independently:
 *   1. the writer's TailoredResumeSchema (strategist-agent.ts),
 *   2. the Haiku emit_resume net (resume-tool-schema.ts),
 *   3. the persist gate (resume-data.schema.ts).
 * They drifted: `projects[].highlights` was added to the shared TS type and the
 * writer schema (#461) but not to the other two — and because a plain
 * z.object() STRIPS undeclared keys, every project bullet was silently deleted
 * first by the Haiku re-emit round-trip and then again on the DB write. A
 * multi-day hunt for a one-key omission.
 *
 * Rule going forward: a resume field is born HERE. Each layer derives its
 * variant from these bases (`.extend` for the persist gate's non-empty
 * constraints, `.passthrough()`/`.partial()` for the tolerant Haiku net) so a
 * new field propagates everywhere in one edit. The hand-written Bedrock JSON
 * `input_schema` cannot derive from Zod directly, so the drift test
 * (resume-schema-drift.test.ts) pins its per-section keys to these shapes.
 *
 * @see shared/src/strategist-types.ts — the compile-time twin; the drift test
 *      asserts assignability so type and runtime shape cannot diverge again.
 */

import { z } from 'zod';

/** Profile / contact block. */
export const ProfileBaseSchema = z.object({
    name:     z.string(),
    title:    z.string(),
    email:    z.string(),
    location: z.string(),
    linkedin: z.string().optional(),
    github:   z.string().optional(),
    website:  z.string().optional(),
});

/** One employment entry — highlights are the experience bullets. */
export const ExperienceBaseSchema = z.object({
    company:    z.string(),
    title:      z.string(),
    period:     z.string(),
    highlights: z.array(z.string()),
});

/** One skills category. */
export const SkillCategoryBaseSchema = z.object({
    category: z.string(),
    skills:   z.array(z.string()),
});

/** One education entry. */
export const EducationBaseSchema = z.object({
    degree:      z.string(),
    institution: z.string(),
    period:      z.string(),
});

/** One certification entry. */
export const CertificationBaseSchema = z.object({
    name:   z.string(),
    year:   z.string(),
    issuer: z.string(),
});

/**
 * One project entry. `highlights` are the JD-aligned technical bullets
 * (selected from project_resume_bullets); optional for cached/legacy resumes,
 * but EVERY layer must declare it — omitting it here is how the bullets were
 * silently stripped.
 */
export const ProjectBaseSchema = z.object({
    name:        z.string(),
    description: z.string(),
    highlights:  z.array(z.string()).optional(),
    github:      z.string().optional(),
});

/** One key-achievement entry. */
export const AchievementBaseSchema = z.object({
    achievement: z.string(),
});

/** Shape keys per section — pins the hand-written Bedrock JSON input_schema. */
export const SECTION_SHAPE_KEYS = {
    profile:        Object.keys(ProfileBaseSchema.shape),
    experience:     Object.keys(ExperienceBaseSchema.shape),
    skills:         Object.keys(SkillCategoryBaseSchema.shape),
    education:      Object.keys(EducationBaseSchema.shape),
    certifications: Object.keys(CertificationBaseSchema.shape),
    projects:       Object.keys(ProjectBaseSchema.shape),
    keyAchievements: Object.keys(AchievementBaseSchema.shape),
} as const;
