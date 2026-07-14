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

    it('carries NO hardcoded user identity — contact comes from the Candidate Contact section (multi-tenant: the v12-era persona shipped one user\'s literal name/email as the signoff example, which any other tenant\'s writer would have copied)', () => {
        expect(joined).not.toContain('Nelson Lamounier');
        expect(joined).not.toContain('lamounierleao@outlook.com');
        expect(joined).not.toContain('linkedin.com/in/nelson-lamounier-leao');
        expect(joined).not.toContain('github.com/Nelson-Lamounier');
        expect(joined).toContain("### Candidate Contact");
        expect(joined).toContain('NEVER invent or alter');
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

	it('persona-example number leakage is handled deterministically by stripInstructionMetrics, not by prompt wording', () => {
		expect(joined).not.toMatch(/numbers?\s+in\s+these\s+instructions\s+are\s+not\s+evidence/i);
	});
});

// Task 7 (experience agent): the writer body's "30-second deploys vs
// 8-minute manual cycles" SCOPE vs IMPACT example lived in
// content/strategist/experience.md, which composed experience bullets
// directly. That composition -- and its worked example -- moved to the
// dedicated strategist-experience agent persona (see
// content/strategist/experience-agent.md); the writer body now emits a
// roster skeleton only, so asserting the old example here would pin text
// this prompt no longer (and should no longer) carry.
describe('strategist-persona experience roster skeleton (Task 7)', () => {
	it('the writer body no longer composes experience bullets -- it emits a roster skeleton for a dedicated experience pass', () => {
		expect(joined).toMatch(/ROSTER SKELETON ONLY/);
		expect(joined).toMatch(/highlights: \[\]/);
		expect(joined).not.toMatch(/30-second deploys vs 8-minute manual/);
	});
});

// Task 8 (projects agent): the writer body's project-selection rules --
// "highlights: 3-6 technical bullets SELECTED from ... PROJECT RESUME
// BULLETS", the QUOTE-ONLY selection contract, and the EXPERIENCE-PURITY
// guardrail against inventing a "Solo <role>" job to host project bullets --
// moved to the dedicated strategist-projects agent persona (see
// content/strategist/projects-agent.md); the writer body now emits an empty
// projects[] skeleton only, so asserting the old selection text here would
// pin text this prompt no longer (and should no longer) carry.
describe('strategist-persona projects skeleton (Task 8)', () => {
	it('the writer body no longer composes project entries -- it emits an empty projects[] skeleton for a dedicated projects pass', () => {
		expect(joined).toMatch(/PROJECTS -- SKELETON ONLY/);
		expect(joined).toMatch(/"projects": \[\]/);
		expect(joined).not.toMatch(/EXPERIENCE-PURITY/);
		expect(joined).not.toMatch(/PROJECT RESUME BULLETS/);
	});
});

// v12 summary calibration + S3 <-> Profile Intelligence cross-reference
// relocated to __tests__/strategist-summary-persona.test.ts: the body no
// longer composes the summary (summary.md / STRATEGIST_SUMMARY_SYSTEM_PROMPT
// is now the sole home of these rules), so asserting them here would pin
// text this prompt no longer carries.
