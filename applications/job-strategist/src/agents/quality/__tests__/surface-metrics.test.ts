/** @format */
jest.mock('@bedrock/shared', () => ({
    ...jest.requireActual('@bedrock/shared'),
    runAgent: jest.fn(),
    log: () => undefined,
}));
import { runAgent } from '@bedrock/shared';
import type { StructuredResumeData } from '@bedrock/shared';
import { surfaceMetrics } from '../surface-metrics.js';

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

const LEDGER = '### GROUNDED METRICS\n- [portfolio] Pages render in 132 ms (LCP) with a 40 ms TTFB.';

describe('surfaceMetrics', () => {
    beforeEach(() => { mockRun.mockReset(); });

    it('empty ledger → returns input unchanged, no runAgent call', async () => {
        const resume = baseResume();
        const out = await surfaceMetrics(resume, '');
        expect(out).toBe(resume);
        expect(mockRun).not.toHaveBeenCalled();
    });

    it('non-empty ledger → one bounded rewrite returning the metric-surfaced resume', async () => {
        const resume = baseResume();
        const rewritten: StructuredResumeData = {
            ...resume,
            experience: [{ ...resume.experience[0]!, highlights: ['Built CI/CD serving pages at 132 ms LCP.'] }],
        };
        mockRun.mockResolvedValue({ data: rewritten });
        const out = await surfaceMetrics(resume, LEDGER);
        expect(mockRun).toHaveBeenCalledTimes(1);
        expect(out).toStrictEqual(rewritten);
    });

    it('hands the ledger and the resume to the model verbatim', async () => {
        mockRun.mockResolvedValue({ data: baseResume() });
        await surfaceMetrics(baseResume(), LEDGER, { groundingFacts: 'career facts' });
        const call = mockRun.mock.calls[0]![0] as { userMessage: string; config: { systemPrompt: Array<{ text: string }> } };
        expect(call.userMessage).toContain('132 ms (LCP)');
        expect(call.userMessage).toContain('career facts');
        const system = call.config.systemPrompt.map((b) => b.text).join('\n');
        expect(system).toMatch(/EXACTLY as stated/i);
        expect(system).toMatch(/never\s+(?:invent|alter)/i);
    });

    it('runAgent throws → fail-open, returns the input resume unchanged', async () => {
        const resume = baseResume();
        mockRun.mockRejectedValue(new Error('bedrock down'));
        const out = await surfaceMetrics(resume, LEDGER);
        expect(out).toBe(resume);
    });
});
