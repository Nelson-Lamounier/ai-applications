/** @format */
import type { StructuredResumeData } from '@bedrock/shared';
import { withExperienceLock } from '../experience-lock.js';

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
