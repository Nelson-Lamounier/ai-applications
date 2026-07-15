/**
 * @format
 * Deterministic resume reconciliation -- runs after the agent batches have
 * filled in the skeleton (resume-skeleton.ts). Validates structural shape
 * against the single-source TailoredResumeSchema (throws on malformed
 * output) and REFUSES to ship required sections empty: experience and
 * skills always fall back to their deterministic closures; projects only
 * falls back when the fallback itself has content, so an honestly
 * project-less candidate is never padded with invented projects.
 */
import type { StructuredResumeData } from '@bedrock/shared';
import { TailoredResumeSchema } from '../../schemas/tailored-resume.schema.js';

export type RepairedSection = 'experience' | 'projects' | 'skills';

export interface ReconcileInputs {
    readonly resume: StructuredResumeData;
    readonly sectionOrder: string[] | undefined;
    readonly fallbacks: {
        readonly experience: () => StructuredResumeData['experience'];
        readonly projects: () => StructuredResumeData['projects'];
        readonly skills: () => StructuredResumeData['skills'];
    };
}

export interface ReconcileResult {
    readonly resume: StructuredResumeData;
    readonly repaired: RepairedSection[];
}

/** Experience and skills are always required -- an empty section is a bug, never a legitimate state. */
function repairExperience(
    experience: StructuredResumeData['experience'],
    fallback: () => StructuredResumeData['experience'],
    repaired: RepairedSection[],
): StructuredResumeData['experience'] {
    if (experience.length > 0) return experience;
    repaired.push('experience');
    return fallback();
}

/** Projects may be legitimately empty (candidate has none) -- only refuse-empty when the fallback has content. */
function repairProjects(
    projects: StructuredResumeData['projects'],
    fallback: () => StructuredResumeData['projects'],
    repaired: RepairedSection[],
): StructuredResumeData['projects'] {
    if (projects.length > 0) return projects;
    const filled = fallback();
    if (filled.length === 0) return projects;
    repaired.push('projects');
    return filled;
}

function repairSkills(
    skills: StructuredResumeData['skills'],
    fallback: () => StructuredResumeData['skills'],
    repaired: RepairedSection[],
): StructuredResumeData['skills'] {
    if (skills.length > 0) return skills;
    repaired.push('skills');
    return fallback();
}

/**
 * Validate the post-batch resume and refuse-empty required sections.
 * Throws (ZodError) on structurally invalid input -- a missing required
 * field is a bug upstream, not something to silently coerce.
 */
export function reconcileResume(i: ReconcileInputs): ReconcileResult {
    const parsed = TailoredResumeSchema.parse(i.resume);
    const repaired: RepairedSection[] = [];

    const experience = repairExperience(parsed.experience, i.fallbacks.experience, repaired);
    const projects = repairProjects(parsed.projects, i.fallbacks.projects, repaired);
    const skills = repairSkills(parsed.skills, i.fallbacks.skills, repaired);

    // Re-validate the ASSEMBLED result: the fallback closures are caller-owned,
    // so a malformed fallback must throw here rather than ship an invalid
    // resume (review finding: validating only the input left the output
    // unguarded on the repair path).
    const resume: StructuredResumeData = TailoredResumeSchema.parse({
        ...parsed,
        experience,
        projects,
        skills,
        sectionOrder: i.sectionOrder !== undefined ? i.sectionOrder : parsed.sectionOrder,
    }) as StructuredResumeData;

    return { resume, repaired };
}
