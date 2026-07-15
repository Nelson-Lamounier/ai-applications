/**
 * @format
 * Tailored resume schema.
 *
 * Relocated from agents/writer/strategist-agent.ts ahead of the writer's
 * deletion (Phase 5 PR-B) -- this schema is a load-bearing survivor pinned by
 * schemas/resume-schema-drift.test.ts.
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
} from './resume-sections.js';

/**
 * Safety-net schema for the embedded tailored-resume JSON. Strategist keeps
 * extended thinking, so forced tool_use is unavailable and this Zod schema is the
 * constrained-decoding substitute: it validates that every REQUIRED field is
 * present and well-typed, failing fast on truly malformed output.
 *
 * It deliberately does NOT use `.strict()`. Extra/unknown keys are STRIPPED, not
 * rejected. Rejecting unknown keys turned any additive drift (a new persona field
 * such as `sectionOrder`, or a model emitting one extra key) into a FATAL failure
 * AFTER the ~6-min Sonnet writer call — wasting the whole expensive generation and
 * (with Job retries) re-spending it. Stripping keeps the run successful on additive
 * drift while still failing on missing/wrong-type required data.
 */
// Section shapes derive from schemas/resume-sections.ts — the single source of
// truth. Re-declaring them inline is how projects[].highlights drifted out of
// the sibling schemas and got silently stripped downstream. Exported so the
// schema drift test can pin every layer to the same shapes.
export const TailoredResumeSchema = z.object({
    profile: ProfileBaseSchema,
    summary: z.string(),
    experience: z.array(ExperienceBaseSchema),
    skills: z.array(SkillCategoryBaseSchema),
    education: z.array(EducationBaseSchema),
    certifications: z.array(CertificationBaseSchema),
    // projects[].highlights: JD-aligned technical bullets selected from the
    // PROJECT RESUME BULLETS block. Optional in the base (cached/legacy writer
    // output still validates); the persona requires it going forward.
    projects: z.array(ProjectBaseSchema),
    keyAchievements: z.array(AchievementBaseSchema),
    // Section render order (archetype/restructure decision). Kept (not stripped)
    // because the UI consumes it; other unknown keys are dropped harmlessly.
    sectionOrder: z.array(z.string()).optional(),
});
