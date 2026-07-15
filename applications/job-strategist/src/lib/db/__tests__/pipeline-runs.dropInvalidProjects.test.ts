/** @format */
import { dropInvalidProjects } from '../pipeline-runs.js';
import { StructuredResumeDataSchema } from '../../../schemas/resume-data.schema.js';

const validProject = { name: 'Tucaken', description: 'A resume-tailoring platform.', github: 'x/y' };

function resumeWith(projects: unknown[]): Record<string, unknown> {
    return {
        profile: { name: 'Nelson', title: 'Engineer', email: 'n@example.com', location: 'Dublin' },
        projects,
    };
}

describe('dropInvalidProjects', () => {
    it('drops a project whose description is undefined and keeps the valid one', () => {
        const raw = resumeWith([validProject, { name: 'Orphan' }]);
        const { resume, droppedProjects } = dropInvalidProjects(raw);
        expect(droppedProjects).toBe(1);
        expect((resume as { projects: unknown[] }).projects).toEqual([validProject]);
    });

    it('drops a project whose description is empty / whitespace', () => {
        const raw = resumeWith([validProject, { name: 'Blank', description: '   ' }]);
        const { resume, droppedProjects } = dropInvalidProjects(raw);
        expect(droppedProjects).toBe(1);
        expect((resume as { projects: unknown[] }).projects).toEqual([validProject]);
    });

    it('makes an otherwise-valid resume pass the persistence schema after dropping', () => {
        const raw = resumeWith([validProject, { name: 'Orphan' }]);
        // The raw resume FAILS validation (the reason the re-persist was dropped)...
        expect(StructuredResumeDataSchema.safeParse(raw).success).toBe(false);
        // ...but after dropping the malformed project, it passes.
        const { resume } = dropInvalidProjects(raw);
        expect(StructuredResumeDataSchema.safeParse(resume).success).toBe(true);
    });

    it('returns the input unchanged when every project is valid', () => {
        const raw = resumeWith([validProject]);
        const { resume, droppedProjects } = dropInvalidProjects(raw);
        expect(droppedProjects).toBe(0);
        expect(resume).toBe(raw);
    });

    it('is a no-op when projects is missing or not an array', () => {
        const noProjects = { profile: {} };
        expect(dropInvalidProjects(noProjects)).toEqual({ resume: noProjects, droppedProjects: 0 });
        expect(dropInvalidProjects(null)).toEqual({ resume: null, droppedProjects: 0 });
        const notArray = { projects: 'nope' };
        expect(dropInvalidProjects(notArray)).toEqual({ resume: notArray, droppedProjects: 0 });
    });
});

describe('StructuredResumeDataSchema — persist gate keeps projects[].highlights', () => {
    it('does NOT strip highlights on parse (the final DB-write gate)', () => {
        const raw = resumeWith([{ ...validProject, highlights: ['Provisioned EKS with Karpenter', 'Built React 19 SPA'] }]);
        const parsed = StructuredResumeDataSchema.parse(raw);
        expect(parsed.projects[0]).toHaveProperty('highlights', ['Provisioned EKS with Karpenter', 'Built React 19 SPA']);
    });
});
