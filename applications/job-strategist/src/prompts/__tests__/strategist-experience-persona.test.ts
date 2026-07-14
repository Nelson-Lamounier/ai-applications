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

    it('instructs the model to emit only via the emit_experience tool', () => {
        expect(joined).toContain('emit_experience');
    });
});
