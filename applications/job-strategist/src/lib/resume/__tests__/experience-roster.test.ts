/**
 * @format
 * Roster reconciliation — the resume's experience roster must map 1:1 onto the
 * candidate's career-history entries. Run 30fe4f66 (2026-07-08) split the single
 * "Freelance | Cloud & DevOps Engineer" career role into TWO entries ("Freelance"
 * + an invented company label "Solo-built production SaaS platform (Tucaken)"),
 * shipping the same job twice on one resume.
 */
import { reconcileExperienceRoster } from '../experience-roster.js';
import type { StructuredResumeData } from '@bedrock/shared';

const CAREER = [
    { title: 'Cloud & DevOps Engineer', company: 'Freelance', period: '2022 - Present (Part-time)', highlights: [] },
    { title: 'Technical Customer Service Associate', company: 'Amazon Web Services (AWS)', period: '2022 - Present', highlights: [] },
    { title: 'Quality Assurance Analyst', company: 'Meta via Accenture', period: '2021 - 2022', highlights: [] },
];

const entry = (company: string, title: string, period: string, highlights: string[]) =>
    ({ company, title, period, highlights });

const resume = (experience: unknown[]): StructuredResumeData =>
    ({ summary: 's', experience, skills: [], education: [], certifications: [], projects: [], keyAchievements: [] }) as unknown as StructuredResumeData;

describe('reconcileExperienceRoster', () => {
    it('merges two entries that anchor to the same career role (the 30fe4f66 split)', () => {
        const r = resume([
            entry('Solo-built production SaaS platform (Tucaken)', 'Cloud & DevOps Engineer', '2022 – Present (Part-time)', ['A1', 'A2', 'A3']),
            entry('Amazon Web Services (AWS)', 'Technical Customer Service Associate', '2022 – Present', ['aws']),
            entry('Freelance', 'Cloud & DevOps Engineer', '2022 – Present (Part-time)', ['B1', 'B2']),
        ]);
        const { resume: out, violations } = reconcileExperienceRoster(r, CAREER);
        expect(out.experience).toHaveLength(2);
        const merged = out.experience.find((e) => e.title === 'Cloud & DevOps Engineer')!;
        expect(merged.highlights).toEqual(['A1', 'A2', 'A3', 'B1', 'B2']);
        expect(violations).toContain('experience_roster_duplicate_merged');
    });

    it('caps merged highlights at 5', () => {
        const r = resume([
            entry('Freelance', 'Cloud & DevOps Engineer', '2022 - Present (Part-time)', ['A1', 'A2', 'A3', 'A4', 'A5']),
            entry('Tucaken', 'Cloud & DevOps Engineer', '2022 - Present (Part-time)', ['B1', 'B2']),
        ]);
        const { resume: out } = reconcileExperienceRoster(r, CAREER);
        expect(out.experience[0]!.highlights).toEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
    });

    it('keeps a descriptive label on a SELF-EMPLOYMENT role — that branding is tailoring surface the user wants ("Solo-built production SaaS platform (Tucaken)" says more than "Freelance")', () => {
        const r = resume([
            entry('Solo-built production SaaS platform (Tucaken)', 'Cloud & DevOps Engineer', '2022 – Present (Part-time)', ['A1']),
        ]);
        const { resume: out, violations } = reconcileExperienceRoster(r, CAREER);
        expect(out.experience[0]!.company).toBe('Solo-built production SaaS platform (Tucaken)');
        expect(violations).toEqual([]);
    });

    it('still restores a REAL employer name verbatim — company names of actual employers are facts', () => {
        const r = resume([
            entry('AWS Enterprise Support Division', 'Technical Customer Service Associate', '2022 – Present', ['aws']),
        ]);
        const { resume: out, violations } = reconcileExperienceRoster(r, CAREER);
        expect(out.experience[0]!.company).toBe('Amazon Web Services (AWS)');
        expect(violations).toContain('experience_company_restored');
    });

    it('a merged self-employment duplicate keeps the descriptive label of the first entry', () => {
        const r = resume([
            entry('Solo-built production SaaS platform (Tucaken)', 'Cloud & DevOps Engineer', '2022 – Present (Part-time)', ['A1', 'A2']),
            entry('Freelance', 'Cloud & DevOps Engineer', '2022 – Present (Part-time)', ['B1']),
        ]);
        const { resume: out, violations } = reconcileExperienceRoster(r, CAREER);
        expect(out.experience).toHaveLength(1);
        expect(out.experience[0]!.company).toBe('Solo-built production SaaS platform (Tucaken)');
        expect(out.experience[0]!.highlights).toEqual(['A1', 'A2', 'B1']);
        expect(violations).toEqual(['experience_roster_duplicate_merged']);
    });

    it('leaves a faithful roster untouched (same object, no violations)', () => {
        const r = resume([
            entry('Freelance', 'Cloud & DevOps Engineer', '2022 – Present (Part-time)', ['A1']),
            entry('Amazon Web Services (AWS)', 'Technical Customer Service Associate', '2022 – Present', ['aws']),
        ]);
        const { resume: out, violations } = reconcileExperienceRoster(r, CAREER);
        expect(out).toBe(r);
        expect(violations).toEqual([]);
    });

    it('keeps an entry it cannot anchor (never silently drops a job)', () => {
        const r = resume([
            entry('Some Other Corp', 'Data Analyst', '2015 - 2017', ['X']),
        ]);
        const { resume: out, violations } = reconcileExperienceRoster(r, CAREER);
        expect(out.experience).toHaveLength(1);
        expect(out.experience[0]!.company).toBe('Some Other Corp');
        expect(violations).toEqual([]);
    });

    it('is a no-op with empty career history', () => {
        const r = resume([entry('Freelance', 'Cloud & DevOps Engineer', 'p', ['A'])]);
        const { resume: out } = reconcileExperienceRoster(r, []);
        expect(out).toBe(r);
    });
});
