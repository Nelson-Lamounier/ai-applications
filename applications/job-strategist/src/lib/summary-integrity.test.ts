/** @format */
import { lintSummary, ensureSummaryIntegrity } from './summary-integrity.js';

const BROKEN =
	'Platform builds containerised, automated infrastructure greenfield, Docker multi-service environments. ' +
	'AI-driven discovery infrastructure demands a builder who architects production-grade platforms. ' +
	'Paid experience spans cloud infrastructure and technical support across AWS, Meta, and production SaaS. ' +
	'AWS Certified DevOps Engineer – Professional.';

const GOOD =
	'Platform engineer with approximately 5 years across cloud infrastructure, technical support, and quality assurance. ' +
	'Every infrastructure change is gated by 265+ automated assertions before production. AWS Certified DevOps Engineer – Professional.';

describe('lintSummary — deterministic quality gate', () => {
	it('flags the live mangled summary on both axes', () => {
		const issues = lintSummary(BROKEN);
		const codes = issues.map((i) => i.code);
		expect(codes).toContain('summary_banned_phrase');
		expect(codes).toContain('summary_no_identity');
	});

	it('passes the writer original', () => {
		expect(lintSummary(GOOD)).toEqual([]);
	});
});

describe('ensureSummaryIntegrity — repair ladder', () => {
	const allowed = new Set([5, 265]);

	it('returns unchanged when the summary is clean', async () => {
		const out = await ensureSummaryIntegrity(GOOD, { originalSummary: GOOD, allowed, repair: async () => 'unused' });
		expect(out.summary).toBe(GOOD);
		expect(out.action).toBe('clean');
	});

	it('uses the LLM repair when it passes lint and adds no ungrounded numbers', async () => {
		const repaired = 'Platform engineer with 5 years building greenfield infrastructure. AWS Certified DevOps Engineer – Professional.';
		const out = await ensureSummaryIntegrity(BROKEN, { originalSummary: GOOD, allowed, repair: async () => repaired });
		expect(out.summary).toBe(repaired);
		expect(out.action).toBe('repaired');
	});

	it('rejects a repair that introduces ungrounded numbers and falls back to the writer original', async () => {
		const badRepair = 'Platform engineer with 12 years leading 400 teams.';
		const out = await ensureSummaryIntegrity(BROKEN, { originalSummary: GOOD, allowed, repair: async () => badRepair });
		expect(out.summary).toBe(GOOD);
		expect(out.action).toBe('original_restored');
	});

	it('prunes banned sentences (never token-strips) when no original is available and repair fails', async () => {
		const out = await ensureSummaryIntegrity(BROKEN, { originalSummary: null, allowed, repair: async () => { throw new Error('down'); } });
		expect(out.summary).not.toMatch(/demands a builder/);
		expect(out.summary).not.toMatch(/Paid experience/);
		// Surviving sentences are intact, not word-surgered.
		expect(out.summary).toContain('AWS Certified DevOps Engineer');
		expect(out.action).toBe('sentence_pruned');
	});
});
