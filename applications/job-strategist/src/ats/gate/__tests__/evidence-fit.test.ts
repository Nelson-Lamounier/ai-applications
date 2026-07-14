/** @format */
import { describe, it, expect } from '@jest/globals';
import { evidenceFitScore } from '../evidence-fit.js';

const alias = new Map<string, string>([
	['k8s', 'kubernetes'],
	['kubernetes', 'kubernetes'],
	['aws', 'aws'],
	['ts', 'typescript'],
	['typescript', 'typescript'],
]);

const jd = {
	requiredSkills: ['Kubernetes', 'TypeScript'],
	tools: ['AWS'],
	preferredSkills: ['GraphQL'],
	concepts: ['Observability'],
};

describe('evidenceFitScore', () => {
	it('scores required coverage against the user evidence corpus (synonym-aware: k8s ≡ Kubernetes, ts ≡ TypeScript)', () => {
		// Evidence mentions k8s + ts + aws → all 3 required covered; graphql/observability missing.
		const evidence = 'Built a k8s platform on aws using ts microservices.';
		const r = evidenceFitScore(jd, evidence, alias);

		expect(r.requiredCovered.sort()).toEqual(['AWS', 'Kubernetes', 'TypeScript']);
		expect(r.requiredMissing).toEqual([]);
		expect(r.requiredFit).toBeCloseTo(1);

		expect(r.preferredCovered).toEqual([]);
		expect(r.preferredMissing.sort()).toEqual(['GraphQL', 'Observability']);
		expect(r.preferredFit).toBeCloseTo(0);

		// overall = required 0.7 + preferred 0.3 = 1*0.7 + 0*0.3 = 0.7
		expect(r.overallFit).toBeCloseTo(0.7);
	});

	it('measures the candidate, not the resume — missing evidence yields honest gaps', () => {
		const evidence = 'Wrote some Python scripts.'; // none of the JD terms present
		const r = evidenceFitScore(jd, evidence, alias);
		expect(r.requiredCovered).toEqual([]);
		expect(r.requiredMissing.sort()).toEqual(['AWS', 'Kubernetes', 'TypeScript']);
		expect(r.requiredFit).toBeCloseTo(0);
		expect(r.overallFit).toBeCloseTo(0);
	});

	it('dedupes the required universe across requiredSkills ∪ tools', () => {
		const dupJd = { requiredSkills: ['AWS'], tools: ['aws'], preferredSkills: [], concepts: [] };
		const r = evidenceFitScore(dupJd, 'Deployed on AWS.', alias);
		// Both canonicalise to "aws" → single covered entry, rate 1 (not 2 separate hits).
		expect(r.requiredCovered.length).toBe(1);
		expect(r.requiredFit).toBeCloseTo(1);
	});

	it('covers a multi-word keyword only when every significant token is in the evidence', () => {
		const mwJd = { requiredSkills: ['CI/CD pipelines'], tools: [], preferredSkills: [], concepts: [] };
		const hit = evidenceFitScore(mwJd, 'Owned the CI CD pipelines for the org.', new Map());
		expect(hit.requiredCovered).toEqual(['CI/CD pipelines']);

		const miss = evidenceFitScore(mwJd, 'Owned the CI for the org.', new Map());
		expect(miss.requiredMissing).toEqual(['CI/CD pipelines']);
	});

	it('weights overall by only the non-empty groups (no preferred → overall == required)', () => {
		const noPref = { requiredSkills: ['AWS'], tools: [], preferredSkills: [], concepts: [] };
		const r = evidenceFitScore(noPref, 'We use AWS.', alias);
		expect(r.preferredFit).toBeCloseTo(1); // empty universe is vacuously satisfied
		expect(r.overallFit).toBeCloseTo(1); // but contributes no weight, so overall tracks required
	});

	it('is empty-safe (no JD signal → overall 1, nothing missing)', () => {
		const r = evidenceFitScore({ requiredSkills: [], tools: [], preferredSkills: [], concepts: [] }, 'anything', new Map());
		expect(r.requiredMissing).toEqual([]);
		expect(r.preferredMissing).toEqual([]);
		expect(r.overallFit).toBeCloseTo(1);
	});
});
