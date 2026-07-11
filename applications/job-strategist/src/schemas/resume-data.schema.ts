/**
 * @format
 * Resume Data Schema — Zod Runtime Validation (Option A: Full)
 *
 * The PERSIST GATE for `StructuredResumeData`: persistTailoredResume writes
 * `JSON.stringify(validated.data)`, and a plain z.object() strips undeclared
 * keys — so this schema decides what actually reaches the DB.
 *
 * Every section derives from the canonical base shapes in resume-sections.ts
 * (single source of truth), tightened here with non-empty / email constraints.
 * Deriving (rather than re-declaring) is what prevents the
 * projects[].highlights class of bug: a field added to the base propagates
 * here automatically instead of being silently deleted on the DB write.
 *
 * @see resume-sections.ts — canonical shapes + the drift-test contract
 * @see shared/src/strategist-types.ts StructuredResumeData
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

// =============================================================================
// NESTED SCHEMAS — base shapes tightened for persistence
// =============================================================================

/** Profile/contact information from the resume */
export const ResumeProfileSchema = ProfileBaseSchema.extend({
    name: z.string().min(1),
    title: z.string().min(1),
    email: z.string().email(),
    location: z.string().min(1),
});

/** A single professional experience entry */
export const ResumeExperienceSchema = ExperienceBaseSchema.extend({
    company: z.string().min(1),
    title: z.string().min(1),
    period: z.string().min(1),
});

/** A skill category with grouped skills */
export const ResumeSkillCategorySchema = SkillCategoryBaseSchema.extend({
    category: z.string().min(1),
});

/** Education entry */
export const ResumeEducationSchema = EducationBaseSchema.extend({
    degree: z.string().min(1),
    institution: z.string().min(1),
    period: z.string().min(1),
});

/** Certification entry */
export const ResumeCertificationSchema = CertificationBaseSchema.extend({
    name: z.string().min(1),
    year: z.string().min(1),
    issuer: z.string().min(1),
});

/**
 * Project entry — inherits `highlights` from the base. The field whose
 * omission HERE (while the type and writer schema had it) silently deleted
 * every project bullet on the DB write.
 */
export const ResumeProjectSchema = ProjectBaseSchema.extend({
    name: z.string().min(1),
    description: z.string().min(1),
});

/** Key achievement entry */
export const ResumeAchievementSchema = AchievementBaseSchema.extend({
    achievement: z.string().min(1),
});

// =============================================================================
// STRUCTURED RESUME DATA
// =============================================================================

/**
 * Full schema for the structured resume data stored in DynamoDB.
 *
 * Validates every field of the `StructuredResumeData` interface.
 * Uses `.default([])` for array fields to handle legacy records
 * that may not have all sections populated.
 */
export const StructuredResumeDataSchema = z.object({
    profile: ResumeProfileSchema,
    summary: z.string().default(''),
    experience: z.array(ResumeExperienceSchema).default([]),
    skills: z.array(ResumeSkillCategorySchema).default([]),
    education: z.array(ResumeEducationSchema).default([]),
    certifications: z.array(ResumeCertificationSchema).default([]),
    projects: z.array(ResumeProjectSchema).default([]),
    keyAchievements: z.array(ResumeAchievementSchema).default([]),
    /**
     * Render order of resume sections, reflecting the strategist's archetype /
     * restructure decision. Keys match the UI builder section keys
     * (summary|experience|projects|education|skills|certifications). Empty by
     * default — the UI falls back to its canonical order when not provided.
     */
    sectionOrder: z.array(z.string()).default([]),
});

/** Validated StructuredResumeData — inferred from schema */
export type ValidatedResumeData = z.infer<typeof StructuredResumeDataSchema>;
