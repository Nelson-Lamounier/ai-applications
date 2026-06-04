/** @format */
import { resolveCoachBranch, assembleCoachSystemPrompt, stageUsesSkillTransfer } from './stages/index.js';

function text(blocks: { text?: string }[]): string {
    return blocks.map(b => b.text ?? '').join('\n');
}

describe('resolveCoachBranch', () => {
    it('maps canonical stages to branches', () => {
        expect(resolveCoachBranch('phone-screen')).toBe('phone-screen');
        expect(resolveCoachBranch('technical-1')).toBe('technical');
        expect(resolveCoachBranch('technical-2')).toBe('technical');
        expect(resolveCoachBranch('system-design')).toBe('system-design');
        expect(resolveCoachBranch('behavioural')).toBe('behavioural');
        expect(resolveCoachBranch('final-round')).toBe('general');
        expect(resolveCoachBranch('applied')).toBe('general');
    });
});

describe('stageUsesSkillTransfer', () => {
    it('is true for project-anchored stages (technical, system-design)', () => {
        expect(stageUsesSkillTransfer('technical-1')).toBe(true);
        expect(stageUsesSkillTransfer('technical-2')).toBe(true);
        expect(stageUsesSkillTransfer('system-design')).toBe(true);
    });
    it('is false for non-anchored stages', () => {
        expect(stageUsesSkillTransfer('phone-screen')).toBe(false);
        expect(stageUsesSkillTransfer('behavioural')).toBe(false);
        expect(stageUsesSkillTransfer('final-round')).toBe(false);
    });
});

describe('assembleCoachSystemPrompt', () => {
    it('always includes the base and a cache point', () => {
        const blocks = assembleCoachSystemPrompt('technical-1') as { text?: string; cachePoint?: unknown }[];
        expect(text(blocks)).toContain('TRUTHFULNESS MANDATE');
        expect(blocks.some(b => b.cachePoint)).toBe(true);
    });
    it('technical includes the skill-transfer delta and not phone-screen fields', () => {
        const t = text(assembleCoachSystemPrompt('technical-1') as { text?: string }[]);
        expect(t).toContain('SKILL TRANSFER');
        expect(t).not.toContain('careerArcSummary');
    });
    it('system-design includes an architecture delta + skill-transfer, not phone-screen fields', () => {
        const t = text(assembleCoachSystemPrompt('system-design') as { text?: string }[]);
        expect(t).toContain('SYSTEM DESIGN INTERVIEW');
        expect(t).toContain('SKILL TRANSFER');
        expect(t).not.toContain('careerArcSummary');
    });
    it('phone-screen includes the phone delta fields', () => {
        const t = text(assembleCoachSystemPrompt('phone-screen') as { text?: string }[]);
        expect(t).toContain('careerArcSummary');
        expect(t).toContain('compScript');
    });
    it('general stage (final-round) appends no stage delta beyond base', () => {
        const t = text(assembleCoachSystemPrompt('final-round') as { text?: string }[]);
        expect(t).toContain('TRUTHFULNESS MANDATE');
        expect(t).not.toContain('SKILL TRANSFER');
    });
    it('places the cache point after the base, before any stage delta', () => {
        const blocks = assembleCoachSystemPrompt('phone-screen') as { text?: string; cachePoint?: unknown }[];
        const cacheIdx = blocks.findIndex(b => b.cachePoint);
        const baseIdx = blocks.findIndex(b => (b.text ?? '').includes('TRUTHFULNESS MANDATE'));
        expect(baseIdx).toBeLessThan(cacheIdx);
    });
});
