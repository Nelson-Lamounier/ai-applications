/** @format */
jest.mock('@bedrock/shared', () => ({
    ...jest.requireActual('@bedrock/shared'),
    runAgent: jest.fn(),
    log: () => undefined,
}));
import { runAgent } from '@bedrock/shared';
import type { StructuredResumeData, SkillEvidenceEntry } from '@bedrock/shared';
import { surfaceKeywords } from './surface-keywords.js';

const mockRun = runAgent as jest.Mock;

const baseResume = (): StructuredResumeData => ({
    profile: { name: 'Nelson', title: 'Platform Engineer', email: 'n@x.com', location: 'Dublin' },
    summary: 'I build production platforms.',
    experience: [{ company: 'Acme', title: 'Engineer', period: '2020-2024', highlights: ['Built CI/CD'] }],
    skills: [{ category: 'Cloud', skills: ['AWS'] }],
    education: [{ degree: 'BSc Computing', institution: 'TU Dublin', period: '2018-2022' }],
    certifications: [],
    projects: [],
    keyAchievements: [],
});

const entry = (tool: string, extra: Partial<SkillEvidenceEntry> = {}): SkillEvidenceEntry => ({
    tool,
    status: 'verified',
    evidenceFiles: extra.evidenceFiles ?? ['kb/a.md'],
    evidence: extra.evidence ?? 'Used in project X',
    transferableBridge: extra.transferableBridge ?? '',
});

describe('surfaceKeywords', () => {
    beforeEach(() => { mockRun.mockReset(); });

    it('empty missing → returns input unchanged, no runAgent call', async () => {
        const resume = baseResume();
        const out = await surfaceKeywords(resume, []);
        expect(out).toBe(resume);
        expect(mockRun).not.toHaveBeenCalled();
    });

    it('missing entries → calls runAgent and returns the rewritten resume', async () => {
        const resume = baseResume();
        const rewritten: StructuredResumeData = {
            ...resume,
            skills: [{ category: 'Cloud', skills: ['AWS', 'Terraform'] }],
        };
        mockRun.mockResolvedValue({ data: rewritten });
        const out = await surfaceKeywords(resume, [entry('Terraform')]);
        expect(mockRun).toHaveBeenCalledTimes(1);
        expect(out).toStrictEqual(rewritten);
    });

    it('runAgent throws → fail-open, returns the input resume unchanged', async () => {
        const resume = baseResume();
        mockRun.mockRejectedValue(new Error('bedrock down'));
        const out = await surfaceKeywords(resume, [entry('Terraform')]);
        expect(out).toBe(resume);
    });

    it('forwards redFlags + groundingFacts into the user message and the XYZ system prompt', async () => {
        const resume = baseResume();
        mockRun.mockResolvedValue({ data: resume });
        await surfaceKeywords(resume, [entry('Terraform')], {
            redFlags: ['names an 8-month employment gap'],
            groundingFacts: 'Cut deploy time from 30m to 5m on the Acme platform.',
        });
        expect(mockRun).toHaveBeenCalledTimes(1);
        const call = mockRun.mock.calls[0][0];
        expect(call.userMessage).toContain('names an 8-month employment gap');
        expect(call.userMessage).toContain('Cut deploy time from 30m to 5m');
        const sys = call.config.systemPrompt[0].text as string;
        expect(sys).toMatch(/Accomplished X/i);
        expect(sys).toMatch(/NEVER invent a number/i);
    });

    it('opts omitted → back-compat, still calls runAgent', async () => {
        const resume = baseResume();
        mockRun.mockResolvedValue({ data: resume });
        await surfaceKeywords(resume, [entry('Terraform')]);
        expect(mockRun).toHaveBeenCalledTimes(1);
    });
});
