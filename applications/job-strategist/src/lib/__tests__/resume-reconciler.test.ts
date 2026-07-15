/**
 * @format
 * reconcileResume -- validates the post-batch-1 resume against the
 * single-source TailoredResumeSchema and refuses to ship required sections
 * empty: experience/skills always fall back; projects only falls back when
 * the fallback closure itself has content (an honestly project-less
 * candidate stays empty, not padded).
 */
import { describe, it, expect } from '@jest/globals';
import { reconcileResume } from '../resume-reconciler.js';
import type { StructuredResumeData } from '@bedrock/shared';

const baseResume = (overrides: Partial<StructuredResumeData> = {}): StructuredResumeData => ({
    profile: { name: 'Nelson Lamounier', title: 'Cloud Engineer', email: 'n@example.com', location: 'Remote' },
    summary: '',
    experience: [{ company: 'Freelance', title: 'Cloud & DevOps Engineer', period: '2022 - Present', highlights: ['shipped X'] }],
    skills: [{ category: 'Cloud', skills: ['AWS'] }],
    education: [],
    certifications: [],
    projects: [{ name: 'Tucaken', description: 'a resume tailoring platform' }],
    keyAchievements: [],
    ...overrides,
});

const FALLBACK_EXPERIENCE = [{ company: 'Freelance', title: 'Cloud & DevOps Engineer', period: '2022 - Present', highlights: ['verbatim highlight'] }];
const FALLBACK_PROJECTS = [{ name: 'Tucaken', description: 'fallback description' }];
const FALLBACK_SKILLS = [{ category: 'Cloud', skills: ['AWS', 'Kubernetes'] }];

const fallbacks = (overrides: Partial<{ experience: () => StructuredResumeData['experience']; projects: () => StructuredResumeData['projects']; skills: () => StructuredResumeData['skills'] }> = {}) => ({
    experience: () => FALLBACK_EXPERIENCE,
    projects: () => FALLBACK_PROJECTS,
    skills: () => FALLBACK_SKILLS,
    ...overrides,
});

describe('reconcileResume', () => {
    it('(a) passes an intact resume through unchanged with repaired: []', () => {
        const resume = baseResume();
        const { resume: out, repaired } = reconcileResume({ resume, sectionOrder: undefined, fallbacks: fallbacks() });
        expect(out).toEqual(resume);
        expect(repaired).toEqual([]);
    });

    it('(b) fills empty experience from the fallback and flags it', () => {
        const resume = baseResume({ experience: [] });
        const { resume: out, repaired } = reconcileResume({ resume, sectionOrder: undefined, fallbacks: fallbacks() });
        expect(out.experience).toEqual(FALLBACK_EXPERIENCE);
        expect(repaired).toEqual(['experience']);
    });

    it('(c) fills empty projects when the fallback has content', () => {
        const resume = baseResume({ projects: [] });
        const { resume: out, repaired } = reconcileResume({ resume, sectionOrder: undefined, fallbacks: fallbacks() });
        expect(out.projects).toEqual(FALLBACK_PROJECTS);
        expect(repaired).toEqual(['projects']);
    });

    it('(c) leaves empty projects as [] -- NOT flagged -- when the fallback is also empty (legit no-projects candidate)', () => {
        const resume = baseResume({ projects: [] });
        const { resume: out, repaired } = reconcileResume({
            resume, sectionOrder: undefined,
            fallbacks: fallbacks({ projects: () => [] }),
        });
        expect(out.projects).toEqual([]);
        expect(repaired).toEqual([]);
    });

    it('(d) fills empty skills from the fallback and flags it', () => {
        const resume = baseResume({ skills: [] });
        const { resume: out, repaired } = reconcileResume({ resume, sectionOrder: undefined, fallbacks: fallbacks() });
        expect(out.skills).toEqual(FALLBACK_SKILLS);
        expect(repaired).toEqual(['skills']);
    });

    it('(e) applies sectionOrder when provided', () => {
        const resume = baseResume();
        const { resume: out } = reconcileResume({ resume, sectionOrder: ['summary', 'experience', 'skills'], fallbacks: fallbacks() });
        expect(out.sectionOrder).toEqual(['summary', 'experience', 'skills']);
    });

    it('(e) leaves sectionOrder untouched when undefined', () => {
        const resume = baseResume({ sectionOrder: ['experience', 'projects'] });
        const { resume: out } = reconcileResume({ resume, sectionOrder: undefined, fallbacks: fallbacks() });
        expect(out.sectionOrder).toEqual(['experience', 'projects']);
    });

    it('(f) throws on a schema-invalid resume (experience entry missing period)', () => {
        const resume = baseResume({
            experience: [{ company: 'Freelance', title: 'Cloud & DevOps Engineer', highlights: [] } as unknown as StructuredResumeData['experience'][number]],
        });
        expect(() => reconcileResume({ resume, sectionOrder: undefined, fallbacks: fallbacks() })).toThrow();
    });

    it('(g) throws when a FALLBACK returns a malformed entry (output re-validated, review finding)', () => {
        const resume = baseResume({ experience: [] });
        const badFallbacks = {
            ...fallbacks(),
            experience: () => [{ company: 'X', title: 'Y' } as unknown as StructuredResumeData['experience'][number]], // missing period+highlights
        };
        expect(() => reconcileResume({ resume, sectionOrder: undefined, fallbacks: badFallbacks })).toThrow();
    });

    it('summary stays as-is (Phase 3 agent fills batch 2, reconciler never touches it)', () => {
        const resume = baseResume({ summary: '' });
        const { resume: out } = reconcileResume({ resume, sectionOrder: undefined, fallbacks: fallbacks() });
        expect(out.summary).toBe('');
    });

    it('experience empty + projects empty(fallback empty) + skills empty -> only bounded, applicable tokens are flagged', () => {
        const resume = baseResume({ experience: [], projects: [], skills: [] });
        const { repaired } = reconcileResume({
            resume, sectionOrder: undefined,
            fallbacks: fallbacks({ projects: () => [] }),
        });
        expect(repaired).toEqual(['experience', 'skills']);
    });
});
