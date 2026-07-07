import { describe, it, expect } from '@jest/globals';
import { STRATEGIST_PERSONA_SYSTEM_PROMPT } from './strategist-persona.js';

const joined = STRATEGIST_PERSONA_SYSTEM_PROMPT.map((block) =>
    'text' in block ? block.text : ''
).join('\n');

describe('strategist-persona cover-letter JSON schema rules', () => {
    it('contains the JSON paragraphs key (structured output marker)', () => {
        expect(joined).toContain('"paragraphs"');
    });

    it('instructs using verbatim Target Role (not archetype lead identity)', () => {
        expect(joined).toContain('Target Role');
    });

    it('contains an omission instruction (never apologise for / OMIT gaps)', () => {
        // Accept either wording variant
        const hasOmit = joined.includes('OMIT gaps') || joined.includes('apologise for');
        expect(hasOmit).toBe(true);
    });

    it('contains the positioning headline rule', () => {
        expect(joined.toLowerCase()).toContain('positioning headline');
    });

    it('instructs NEVER markdown inside the cover letter CDATA', () => {
        const hasNoMarkdown =
            joined.includes('NEVER markdown') || joined.includes('never markdown');
        expect(hasNoMarkdown).toBe(true);
    });

    it('headline rule forbids a job-title noun in profile.title', () => {
        const lower = joined.toLowerCase();
        expect(lower).toContain('must not contain a job-title noun');
        expect(lower).toContain('capability/domain headline');
    });

    it('summary opener anchors identity with a defensible role family, never the target JD title', () => {
        const lower = joined.toLowerCase();
        expect(lower).toContain('anchors identity then capability');
        expect(lower).toContain('never self-label with the');
    });

    it('preserves the fixed sign-off identity', () => {
        expect(joined).toContain('Nelson Lamounier');
        expect(joined).toContain('lamounierleao@outlook.com');
        expect(joined).toContain('linkedin.com/in/nelson-lamounier-leao');
        expect(joined).toContain('github.com/Nelson-Lamounier');
    });
});

describe('strategist-persona output budget — REVERTED, do not reintroduce', () => {
	it('carries no OUTPUT BUDGET block (measured live run a8ffad34: the in-template comment DOUBLED writer output to 51,930 tokens and timed the pipeline out)', () => {
		expect(joined).not.toMatch(/OUTPUT BUDGET/);
	});
});

describe('strategist-persona employment fidelity mandate', () => {
	it('forbids inferring role content from employer name or industry', () => {
		expect(joined).toMatch(/EMPLOYMENT FIDELITY/);
		expect(joined).toMatch(/NEVER inventing/);
		expect(joined).toMatch(/employer's name or industry/);
	});
});
