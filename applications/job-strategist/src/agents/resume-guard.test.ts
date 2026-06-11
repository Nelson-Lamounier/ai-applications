/** @format */
jest.mock('@bedrock/shared', () => ({ runAgent: jest.fn(), log: () => undefined }));
import { runAgent } from '@bedrock/shared';
import { guardResume } from './resume-guard.js';
import { validateResume } from './resume-guard.js';
import type { StructuredResumeData } from '@bedrock/shared';

const mockRun = runAgent as jest.Mock;

const base = (over: Partial<StructuredResumeData> = {}): StructuredResumeData => ({
    profile: { name: 'Nelson', title: 'Technical Support Engineer · Cloud & AI Operations', email: 'e', location: 'Dublin' },
    summary: 'Support engineer who ships production AI. 5 years across support and operations.',
    experience: [{ company: 'AWS', title: 'Technical Customer Service Associate', period: '2022 - Present', highlights: ['Removed 10-20 hrs/week toil via automation'] }],
    skills: [{ category: 'Support & Troubleshooting', skills: ['root-cause analysis', 'SLA'] }, { category: 'Cloud', skills: ['AWS'] }],
    education: [{ degree: 'Higher Diploma in Computing', institution: 'DBS', period: '2022-2024' }],
    certifications: [], projects: [], keyAchievements: [],
    sectionOrder: ['summary', 'experience', 'projects', 'education', 'skills', 'certifications'],
    ...over,
} as StructuredResumeData);

const ctx = { targetRole: 'AI Support Engineer', leadIdentity: 'Support engineer who builds production AI', verifiedEducation: ['Higher Diploma in Computing'], archetypeSkillLead: 'Support & Troubleshooting' };
const codes = (r: StructuredResumeData) => validateResume(r, ctx).map((v) => v.code);

describe('validateResume', () => {
    it('clean resume → no violations', () => { expect(codes(base())).toEqual([]); });
    it('headline_is_title — title is a verbatim employment title / no positioning separator', () => {
        expect(codes(base({ profile: { name: 'N', title: 'Technical Customer Service Associate', email: 'e', location: 'D' } }))).toContain('headline_is_title');
    });
    it('summary_wrong_cluster — first sentence lacks the leadIdentity head noun', () => {
        expect(codes(base({ summary: 'Cloud infrastructure engineer with 3+ years triaging AWS escalations.' }))).toContain('summary_wrong_cluster');
    });
    it('summary_names_gap — raw years-gap / self-deprecation', () => {
        expect(codes(base({ summary: 'Support engineer whose 3 years falls short of the 8-year requirement.' }))).toContain('summary_names_gap');
    });
    it('education_mismatch — a degree not in verifiedEducation', () => {
        expect(codes(base({ education: [{ degree: 'BA in Digital Marketing', institution: 'DBS', period: '2016-2020' }] }))).toContain('education_mismatch');
    });
    it('skills_lead_mismatch — first skill group is not the archetype lead', () => {
        expect(codes(base({ skills: [{ category: 'Cloud', skills: ['AWS'] }, { category: 'Support & Troubleshooting', skills: ['SLA'] }] }))).toContain('skills_lead_mismatch');
    });
});

describe('guardResume', () => {
    beforeEach(() => { mockRun.mockReset(); });

    it('clean resume → unchanged, no rewrite call', async () => {
        const r = base();
        const res = await guardResume(r, ctx);
        expect(res.resume).toBe(r);
        expect(res.violations).toEqual([]);
        expect(mockRun).not.toHaveBeenCalled();
    });
    it('violations → calls rewrite, returns fixed + original violations', async () => {
        const fixed = base();
        mockRun.mockResolvedValue({ data: fixed });
        const bad = base({ summary: 'Cloud infrastructure engineer with 3 years that falls short of the 8-year bar.' });
        const res = await guardResume(bad, ctx);
        expect(res.resume).toBe(fixed);
        expect(res.violations.map((v) => v.code)).toEqual(expect.arrayContaining(['summary_wrong_cluster', 'summary_names_gap']));
    });
    it('rewrite throws → returns ORIGINAL (fail-open)', async () => {
        mockRun.mockRejectedValue(new Error('down'));
        const bad = base({ summary: 'Cloud infrastructure engineer, 3 years, falls short.' });
        const res = await guardResume(bad, ctx);
        expect(res.resume).toBe(bad);
    });
});
