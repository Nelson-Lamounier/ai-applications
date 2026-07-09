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

describe('strategist-persona v11 — v6-restored body (writer-duration bisect closed: the 4096 thinking budget was the cause, not wording)', () => {
	it('carries no GROUNDED METRICS reference and no OUTPUT BUDGET (both measured to balloon writer output)', () => {
		expect(joined).not.toMatch(/GROUNDED\s+METRICS/);
		expect(joined).not.toMatch(/OUTPUT BUDGET/);
	});

	it('keeps the v6 numeric examples; persona-example number leakage is handled deterministically by stripInstructionMetrics, not by prompt wording', () => {
		expect(joined).toMatch(/30-second deploys vs 8-minute manual/);
		expect(joined).not.toMatch(/numbers?\s+in\s+these\s+instructions\s+are\s+not\s+evidence/i);
	});
});

describe('strategist-persona v12 — summary calibration (from the ResMed Associate-JD review of run 77e325ea)', () => {
	it('S1 aligns to the JD role class and bans employer-name openings ("AWS … engineer" while employed at AWS reads as a title held there)', () => {
		expect(joined).toMatch(/ALIGNED TO THE JD'S OWN ROLE CLASS/);
		expect(joined).toMatch(/NEVER OPEN with an employer's name/);
	});

	it('caps rigor at ONE sentence per summary and gives associate/junior roles a forward-fit close (the live S3 slot was a second rigor close)', () => {
		expect(joined).toMatch(/AT MOST ONE rigor\/gating sentence/);
		expect(joined).toMatch(/grounded forward-fit close/);
	});

	it('calibrates tone to the JD level (depth + hunger for associate roles, ownership for senior) and names equivalence bridges explicitly (CDK -> CloudFormation)', () => {
		expect(joined).toMatch(/SENIORITY TONE/);
		expect(joined).toMatch(/EQUIVALENCE BRIDGES/);
		expect(joined).toMatch(/CDK \(CloudFormation\)/);
	});
});

describe('strategist-persona S3 <-> message-section cross-reference (v11)', () => {
	it('S3 names the "### Profile Intelligence" section — and the message builder exposes a header starting with that exact name (run 77e325ea shipped no S3 angle because the persona referenced a section the message never labelled)', async () => {
		const { PROFILE_INTELLIGENCE_HEADER } = await import('../agents/strategist-agent.js');
		expect(joined).toContain('"### Profile Intelligence" section');
		expect(PROFILE_INTELLIGENCE_HEADER.startsWith('### Profile Intelligence')).toBe(true);
		expect(joined).toMatch(/UNDERSOLD strengths/);
	});
});
