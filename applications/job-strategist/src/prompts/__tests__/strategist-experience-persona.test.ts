/** @format */
import { describe, it, expect } from '@jest/globals';
import { STRATEGIST_EXPERIENCE_SYSTEM_PROMPT } from '../strategist-experience.js';

const joined = STRATEGIST_EXPERIENCE_SYSTEM_PROMPT.map((block) =>
    'text' in block ? block.text : ''
).join('\n');

describe('strategist-experience-persona -- provenance contract + profile-voice rules', () => {
    it('carries the hard provenance contract (line-id sourcing, immutable company/title/period)', () => {
        expect(joined).toContain('PROVENANCE CONTRACT');
    });

    it('frames each role as a single JD-tailored arc, not a task list', () => {
        expect(joined).toContain('PROFILE VOICE');
    });

    it('caps every bullet at 32 words', () => {
        expect(joined).toContain('32 words');
    });

    it('states the bullet contract as a hard, standalone rule', () => {
        expect(joined).toContain('BULLET CONTRACT');
    });

    it('carries the zero-anchor honesty rule -- weave only what a cited line genuinely supports, else report a gap', () => {
        expect(joined).toContain('TARGET HONESTY');
        expect(joined).toContain('grounded by');
        expect(joined).toContain('gap');
    });

    it('instructs the model to emit only via the emit_experience tool', () => {
        expect(joined).toContain('emit_experience');
    });
});
