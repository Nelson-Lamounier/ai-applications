/** @format */
import type { StructuredResumeData } from '@bedrock/shared';
import { withExperienceLock, withProjectsDescriptionLock } from '../experience-lock.js';

const base = (over: Partial<StructuredResumeData> = {}): StructuredResumeData => ({
    profile:         { name: 'Nelson', title: 'Production AI Systems', email: 'e', location: 'Dublin' },
    summary:         'Ships production AI systems.',
    experience:      [{ company: 'F', title: 'Cloud & DevOps Engineer', period: '2022 - Present', highlights: ['Cut enrichment cost to near-zero via dedup caching.'] }],
    skills:          [{ category: 'AI & LLM Engineering', skills: ['AWS Bedrock'] }],
    education:       [],
    certifications:  [],
    projects:        [],
    keyAchievements: [],
    sectionOrder:    ['summary', 'experience', 'projects', 'education', 'skills', 'certifications'],
    ...over,
} as StructuredResumeData);

describe('withExperienceLock', () => {
    it('restores the pre-call Experience snapshot when a pass mutates it, and calls onRestored with the pass name', async () => {
        const resume = base();
        const mutated: StructuredResumeData = {
            ...resume,
            experience: [{ ...resume.experience[0], highlights: ['A rewrite pass reworded this bullet.'] }],
        };
        const restoredPasses: string[] = [];
        const out = await withExperienceLock(resume, 'guard', async () => mutated, (pass) => restoredPasses.push(pass));

        expect(out.experience).toEqual(resume.experience);
        expect(restoredPasses).toEqual(['guard']);
    });

    it('keeps changes the pass made to OTHER sections while restoring only Experience', async () => {
        const resume = base();
        const mutated: StructuredResumeData = {
            ...resume,
            summary:    'A rewritten, longer summary the guard produced.',
            experience: [{ ...resume.experience[0], highlights: ['Reworded experience bullet.'] }],
        };
        const restoredPasses: string[] = [];
        const out = await withExperienceLock(resume, 'length', async () => mutated, (pass) => restoredPasses.push(pass));

        expect(out.experience).toEqual(resume.experience);
        expect(out.summary).toBe('A rewritten, longer summary the guard produced.');
        expect(restoredPasses).toEqual(['length']);
    });

    it('detects a dropped role (roster violation) as a mutation and restores it', async () => {
        const resume = base({
            experience: [
                { company: 'F', title: 'Cloud & DevOps Engineer', period: '2022 - Present', highlights: ['A'] },
                { company: 'M', title: 'Support Engineer', period: '2020 - 2022', highlights: ['B'] },
            ],
        } as never);
        const droppedRole: StructuredResumeData = { ...resume, experience: [resume.experience[0]] };
        const restoredPasses: string[] = [];
        const out = await withExperienceLock(resume, 'surface_keywords', async () => droppedRole, (pass) => restoredPasses.push(pass));

        expect(out.experience).toHaveLength(2);
        expect(restoredPasses).toEqual(['surface_keywords']);
    });

    it('a non-mutating pass returns the SAME object reference and never calls onRestored', async () => {
        const resume = base();
        const untouched: StructuredResumeData = { ...resume, summary: 'A rewritten summary, experience left alone.' };
        const onRestored = jest.fn();
        const out = await withExperienceLock(resume, 'revalidate', async () => untouched, onRestored);

        expect(out).toBe(untouched);
        expect(onRestored).not.toHaveBeenCalled();
    });

    it('an identical-content but new-array-reference experience counts as unchanged (byte comparison, not reference)', async () => {
        const resume = base();
        const sameContentNewRef: StructuredResumeData = { ...resume, experience: [{ ...resume.experience[0] }] };
        const onRestored = jest.fn();
        const out = await withExperienceLock(resume, 'metric_weave', async () => sameContentNewRef, onRestored);

        expect(out).toBe(sameContentNewRef);
        expect(onRestored).not.toHaveBeenCalled();
    });

    it('propagates a throwing pass function\'s rejection -- callers keep their own fail-open .catch', async () => {
        const resume = base();
        const onRestored = jest.fn();
        await expect(withExperienceLock(resume, 'guard', async () => { throw new Error('bedrock down'); }, onRestored))
            .rejects.toThrow('bedrock down');
        expect(onRestored).not.toHaveBeenCalled();
    });
});

const withProjects = (over: Partial<StructuredResumeData> = {}): StructuredResumeData => base({
    projects: [
        { name: 'Tucaken', description: 'Tucaken is a career platform.', highlights: ['Built the matcher.'] },
        { name: 'Portfolio', description: 'Portfolio is a personal engineering showcase.', highlights: ['Deployed on EKS.'] },
    ],
    ...over,
} as Partial<StructuredResumeData>);

describe('withProjectsDescriptionLock', () => {
    it('restores a mutated description while keeping the same pass\'s highlight changes', async () => {
        const resume = withProjects();
        const mutated: StructuredResumeData = {
            ...resume,
            projects: [
                { ...resume.projects[0]!, description: 'A repair pass rewrote this description.', highlights: ['Built the matcher.', 'A new highlight the pass added.'] },
                resume.projects[1]!,
            ],
        };
        const restoredPasses: string[] = [];
        const out = await withProjectsDescriptionLock(resume, 'guard', async () => mutated, (pass) => restoredPasses.push(pass));

        expect(out.projects[0]!.description).toBe(resume.projects[0]!.description);
        expect(out.projects[0]!.highlights).toEqual(['Built the matcher.', 'A new highlight the pass added.']);
        expect(out.projects[1]).toEqual(resume.projects[1]);
        expect(restoredPasses).toEqual(['guard']);
    });

    it('keeps changes the pass made to OTHER sections/fields while restoring only the changed description', async () => {
        const resume = withProjects();
        const mutated: StructuredResumeData = {
            ...resume,
            summary: 'A rewritten summary the pass produced.',
            projects: [
                { ...resume.projects[0]!, description: 'Rewritten description.' },
                resume.projects[1]!,
            ],
        };
        const restoredPasses: string[] = [];
        const out = await withProjectsDescriptionLock(resume, 'revalidate', async () => mutated, (pass) => restoredPasses.push(pass));

        expect(out.summary).toBe('A rewritten summary the pass produced.');
        expect(out.projects[0]!.description).toBe(resume.projects[0]!.description);
        expect(restoredPasses).toEqual(['revalidate']);
    });

    it('a non-mutating pass returns the SAME object reference and never calls onRestored', async () => {
        const resume = withProjects();
        const untouched: StructuredResumeData = { ...resume, summary: 'Untouched descriptions, only summary changed.' };
        const onRestored = jest.fn();
        const out = await withProjectsDescriptionLock(resume, 'length', async () => untouched, onRestored);

        expect(out).toBe(untouched);
        expect(onRestored).not.toHaveBeenCalled();
    });

    it('matches entries by NAME when a pass reorders the projects array', async () => {
        const resume = withProjects();
        const reordered: StructuredResumeData = {
            ...resume,
            projects: [
                { ...resume.projects[1]!, description: 'Reordered AND rewritten.' },
                resume.projects[0]!,
            ],
        };
        const restoredPasses: string[] = [];
        const out = await withProjectsDescriptionLock(resume, 'surface_keywords', async () => reordered, (pass) => restoredPasses.push(pass));

        expect(out.projects[0]!.name).toBe('Portfolio');
        expect(out.projects[0]!.description).toBe(resume.projects[1]!.description);
        expect(restoredPasses).toEqual(['surface_keywords']);
    });

    it('restores a description the migration REFRAME pass rewrote (proseSurfaces scans projects[].description)', async () => {
        // migration-reframe.ts's proseSurfaces explicitly includes
        // projects[].description, so the reframe call site (run-pipeline.ts)
        // composes this lock too -- a reframed description must revert to the
        // deterministic pitch stamp.
        const resume = withProjects();
        const reframed: StructuredResumeData = {
            ...resume,
            projects: [
                { ...resume.projects[0]!, description: 'Migrated from self-hosted kubeadm to managed EKS -- reframed narrative.' },
                resume.projects[1]!,
            ],
        };
        const restoredPasses: string[] = [];
        const out = await withProjectsDescriptionLock(resume, 'reframe', async () => reframed, (pass) => restoredPasses.push(pass));

        expect(out.projects[0]!.description).toBe(resume.projects[0]!.description);
        expect(restoredPasses).toEqual(['reframe']);
    });

    it('falls back to index matching when a pass renames an entry', async () => {
        const resume = withProjects();
        const renamed: StructuredResumeData = {
            ...resume,
            projects: [
                { ...resume.projects[0]!, name: 'Renamed Project', description: 'Renamed and rewritten description.' },
                resume.projects[1]!,
            ],
        };
        const restoredPasses: string[] = [];
        const out = await withProjectsDescriptionLock(resume, 'metric_weave', async () => renamed, (pass) => restoredPasses.push(pass));

        expect(out.projects[0]!.name).toBe('Renamed Project');
        expect(out.projects[0]!.description).toBe(resume.projects[0]!.description);
        expect(restoredPasses).toEqual(['metric_weave']);
    });

    it('a genuinely new entry (no before match at name or index) is left as the pass produced it', async () => {
        const resume = withProjects();
        const withNewEntry: StructuredResumeData = {
            ...resume,
            projects: [...resume.projects, { name: 'Brand New', description: 'A pass added this project.', highlights: [] }],
        };
        const onRestored = jest.fn();
        const out = await withProjectsDescriptionLock(resume, 'guard', async () => withNewEntry, onRestored);

        expect(out.projects[2]).toEqual({ name: 'Brand New', description: 'A pass added this project.', highlights: [] });
        expect(onRestored).not.toHaveBeenCalled();
    });

    it('propagates a throwing pass function\'s rejection -- callers keep their own fail-open .catch', async () => {
        const resume = withProjects();
        const onRestored = jest.fn();
        await expect(withProjectsDescriptionLock(resume, 'guard', async () => { throw new Error('bedrock down'); }, onRestored))
            .rejects.toThrow('bedrock down');
        expect(onRestored).not.toHaveBeenCalled();
    });
});
