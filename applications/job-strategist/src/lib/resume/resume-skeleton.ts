/**
 * @format
 * Deterministic resume skeleton -- the resume assembly steps that never need
 * an LLM. Profile, education, and certifications are copied verbatim from
 * verified sources (career-history, candidate contact); experience is
 * reduced to a roster (company/title/period) with highlights left for a
 * later agent to fill; every agent-owned section starts empty so the
 * reconciler (resume-reconciler.ts) can tell "not filled yet" from
 * "genuinely empty".
 */
import type { StructuredResumeData } from '@bedrock/shared';
import type { CareerEntry, EducationEntry, CertificationEntry } from '../../agents/evidence/career-history.js';

export interface SkeletonContact {
    readonly name: string;
    readonly email: string;
    readonly linkedin?: string;
    readonly github?: string;
    readonly title?: string;
    readonly location?: string;
}

export interface SkeletonInputs {
    readonly careerEntries: readonly CareerEntry[];
    readonly education: readonly EducationEntry[];
    readonly certifications: readonly CertificationEntry[];
    readonly contact: SkeletonContact;
}

/** Roster skeleton: company/title/period verbatim from career history, highlights filled later. */
function buildExperienceRoster(entries: readonly CareerEntry[]): StructuredResumeData['experience'] {
    return entries.map((e) => ({ company: e.company, title: e.title, period: e.period, highlights: [] }));
}

/** Education entries map field-for-field onto ResumeEducation -- no renaming. */
function buildEducation(entries: readonly EducationEntry[]): StructuredResumeData['education'] {
    return entries.map((e) => ({ degree: e.degree, institution: e.institution, period: e.period }));
}

/** Certification entries map verbatim; only the field NAME differs (date -> year), never the value. */
function buildCertifications(entries: readonly CertificationEntry[]): StructuredResumeData['certifications'] {
    return entries.map((c) => ({ name: c.name, issuer: c.issuer, year: c.date }));
}

/** Profile copied verbatim from the candidate's real contact details; never invented. */
function buildProfile(contact: SkeletonContact): StructuredResumeData['profile'] {
    const profile: { name: string; title: string; email: string; location: string; linkedin?: string; github?: string } = {
        name: contact.name,
        title: contact.title ?? '',
        email: contact.email,
        location: contact.location ?? '',
    };
    if (contact.linkedin) profile.linkedin = contact.linkedin;
    if (contact.github) profile.github = contact.github;
    return profile;
}

/**
 * Build the deterministic pre-agent resume skeleton. Every agent-owned
 * section (summary/skills/projects/keyAchievements) starts empty and
 * sectionOrder is left undefined -- the analysis phase decides that later.
 */
export function buildSkeletonResume(i: SkeletonInputs): StructuredResumeData {
    return {
        profile: buildProfile(i.contact),
        summary: '',
        experience: buildExperienceRoster(i.careerEntries),
        skills: [],
        education: buildEducation(i.education),
        certifications: buildCertifications(i.certifications),
        projects: [],
        keyAchievements: [],
        sectionOrder: undefined,
    };
}
