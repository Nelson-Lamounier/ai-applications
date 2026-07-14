/** @format */
import { describe, it, expect } from '@jest/globals';
import { STRATEGIST_PROJECTS_SYSTEM_PROMPT } from '../strategist-projects.js';

const joined = STRATEGIST_PROJECTS_SYSTEM_PROMPT.map((block) =>
    'text' in block ? block.text : ''
).join('\n');

describe('strategist-projects-persona -- two-lane quote-only contract', () => {
    it('carries the hard quote-only contract (curated bulletId vs composed text+sources)', () => {
        expect(joined).toContain('QUOTE-ONLY CONTRACT');
    });

    it('frames the pool as a two-lane pool (curated bullets vs repo-current facts)', () => {
        expect(joined).toContain('TWO-LANE');
    });

    it('caps the description at 40 words', () => {
        expect(joined).toContain('40 words');
    });

    it('instructs the model to emit only via the emit_projects tool', () => {
        expect(joined).toContain('emit_projects');
    });
});
