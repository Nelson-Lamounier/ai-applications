/** @format */
jest.mock('@bedrock/shared', () => ({
    ...jest.requireActual('@bedrock/shared'),
    runAgent: jest.fn(),
    log: () => undefined,
}));
import { runAgent } from '@bedrock/shared';
import type { StructuredResumeData } from '@bedrock/shared';
import { rewriteResume } from '../rewrite.js';
import type { ResumeGuardCtx, ResumeViolation } from '../types.js';

const mockRun = runAgent as jest.Mock;

const baseResume = (): StructuredResumeData => ({
    profile: { name: 'Nelson', title: 'Platform Engineer', email: 'n@x.com', location: 'Dublin' },
    summary: 'I build production platforms.',
    experience: [{ company: 'Acme', title: 'Engineer', period: '2020-2024', highlights: ['Built CI/CD'] }],
    skills: [{ category: 'Cloud', skills: ['AWS'] }],
    education: [{ degree: 'BSc Computing', institution: 'TU Dublin', period: '2018-2022' }],
    certifications: [],
    projects: [{ name: 'Tucaken', description: 'Tucaken is a career platform.', highlights: ['Built the matcher.'] }],
    keyAchievements: [],
});

const baseCtx = (over: Partial<ResumeGuardCtx> = {}): ResumeGuardCtx => ({
    targetRole: 'Platform Engineer',
    leadIdentity: 'Cloud & AI systems engineer',
    verifiedEducation: ['BSc Computing'],
    archetypeSkillLead: 'Cloud',
    ...over,
});

describe('rewriteResume -- project_restates_bullets / project_pitch_missing advisory retirement (Task 2)', () => {
    beforeEach(() => { mockRun.mockReset(); });

    it('never instructs a project-description rewrite recipe, with project pitches on the ctx', async () => {
        mockRun.mockResolvedValue({ data: baseResume() });
        const ctx = baseCtx({ projectPitches: [{ name: 'Tucaken', pitch: 'Tucaken is a career platform helping engineers land jobs faster.' }] });
        const violations: ResumeViolation[] = [{ code: 'project_restates_bullets', detail: 'x' }];

        await rewriteResume(baseResume(), violations, ctx);

        const call = mockRun.mock.calls[0]![0] as { config: { systemPrompt: Array<{ text: string }> } };
        const system = call.config.systemPrompt.map((b) => b.text).join('\n');
        expect(system).not.toMatch(/three beats/i);
        expect(system).not.toMatch(/differentiator not already an experience bullet/i);
        expect(system).not.toContain('Tucaken is a career platform helping engineers land jobs faster.');
    });

    it('never instructs a project-description rewrite recipe, without project pitches on the ctx', async () => {
        mockRun.mockResolvedValue({ data: baseResume() });
        const ctx = baseCtx();
        const violations: ResumeViolation[] = [{ code: 'project_pitch_missing', detail: 'x' }];

        await rewriteResume(baseResume(), violations, ctx);

        const call = mockRun.mock.calls[0]![0] as { config: { systemPrompt: Array<{ text: string }> } };
        const system = call.config.systemPrompt.map((b) => b.text).join('\n');
        expect(system).not.toMatch(/rewrite the flagged project description/i);
        expect(system).not.toMatch(/one JD-relevant differentiator \+ one fresh metric/i);
    });

    it('still forwards project_restates_bullets/project_pitch_missing codes in the user message (advisory: detected + recorded, not repaired)', async () => {
        mockRun.mockResolvedValue({ data: baseResume() });
        const violations: ResumeViolation[] = [
            { code: 'project_restates_bullets', detail: 'x' },
            { code: 'project_pitch_missing', detail: 'y' },
        ];

        await rewriteResume(baseResume(), violations, baseCtx());

        const call = mockRun.mock.calls[0]![0] as { userMessage: string };
        expect(call.userMessage).toContain('project_restates_bullets');
        expect(call.userMessage).toContain('project_pitch_missing');
    });

    it('other repair instructions (experience_bullet_jd_echo) are unaffected by the retirement', async () => {
        mockRun.mockResolvedValue({ data: baseResume() });
        await rewriteResume(baseResume(), [{ code: 'experience_bullet_jd_echo', detail: 'x' }], baseCtx());

        const call = mockRun.mock.calls[0]![0] as { config: { systemPrompt: Array<{ text: string }> } };
        const system = call.config.systemPrompt.map((b) => b.text).join('\n');
        expect(system).toMatch(/experience_bullet_jd_echo/);
    });

    it('runAgent throws -> fail-open, returns the input resume unchanged', async () => {
        mockRun.mockRejectedValue(new Error('bedrock down'));
        const resume = baseResume();
        const out = await rewriteResume(resume, [{ code: 'project_restates_bullets', detail: 'x' }], baseCtx());
        expect(out).toBe(resume);
    });
});
