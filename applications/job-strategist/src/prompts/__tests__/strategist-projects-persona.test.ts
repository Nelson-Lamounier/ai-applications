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

    it('prefers composing from Operations evidence when present and the JD targets are operations-flavoured, citing fact ids', () => {
        expect(joined).toContain('Operations evidence');
        expect(joined.toUpperCase()).toContain('OPERATED');
    });
});

describe('strategist-projects-persona -- composed-bullet narrative contract (Component 2)', () => {
    it('states the four-beat contract: WHAT -> CONCEPT -> WHY -> RESULT/VALUE', () => {
        expect(joined).toContain('COMPOSED-BULLET NARRATIVE CONTRACT');
        expect(joined).toContain('WHAT');
        expect(joined).toContain('CONCEPT in public');
        expect(joined).toContain('WHY it mattered');
        expect(joined).toContain('RESULT/VALUE');
    });

    it('bans internal identifiers and bare acronyms, requiring an acronym\'s concept on first use', () => {
        const flat = joined.replace(/\s+/g, ' ');
        expect(flat).toContain('never write an internal identifier');
        expect(flat).toContain('introduce an acronym WITH its concept on first use');
    });

    it('requires exact figures or "more than N" -- never a bare "N+"', () => {
        const flat = joined.replace(/\s+/g, ' ');
        expect(flat).toContain('never a bare "N+" or "Nk+"');
    });

    it('states the jargon-preference rule: compose clean over a jargony curated quote when pool evidence supports the same fact', () => {
        const flat = joined.replace(/\s+/g, ' ');
        expect(flat).toContain('Jargon-preference rule');
        expect(flat).toContain('COMPOSE the clean version instead of selecting the jargony quote');
    });
});
