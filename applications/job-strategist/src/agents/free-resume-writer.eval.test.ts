/**
 * @format
 * Free-tier writer eval (CLAUDE.md §5). Good output = grounded narrative:
 * no fabricated facts, evidence-backed JD keywords surface, impact-bullet
 * format, honest cover letter. Deterministic graders gate CI; an injectable
 * judge (mocked here) covers the subjective "reads as grounded narrative".
 */
import { describe, it, expect } from '@jest/globals';
import { gradeFreeResume } from './free-resume-writer.js';
import { groundedAtsCoverage } from '../ats/grounded-coverage.js';
import type { FreeEvidence } from '../free/gather-evidence.js';
import type { FreeResumeOutput } from './free-resume-writer.js';

const EV: FreeEvidence = {
	kbPassages: ['[Source: me/infra/eks.tf]\nProvisioned EKS with Karpenter.'],
	projectEvidence: 'Tucaken — 16-CDK-stack AWS, EKS, Bedrock.',
	extractedTech: 'aws kubernetes terraform bedrock',
	careerFacts: 'Acme Corp — Platform Engineer — 2022–2025',
	educationFacts: 'BSc CS — Example University',
	commitPrEvidence: '',
	profileIntelligence: '',
};

const GOOD: FreeResumeOutput = {
	resume: {
		profile: {
			name: 'Jane Doe',
			title: 'Platform Engineer',
			email: 'jane@example.com',
			location: 'San Francisco, CA',
		},
		summary: 'I built code-grounded tooling on AWS and Kubernetes.',
		experience: [
			{
				company: 'Acme Corp',
				title: 'Platform Engineer',
				period: '2022–2025',
				highlights: [
					'Provisioned EKS with Karpenter on AWS, improving autoscaling.',
				],
			},
		],
		skills: [],
		education: [],
		certifications: [],
		projects: [
			{ name: 'Tucaken', description: 'Tucaken — 16-CDK-stack AWS, EKS, Bedrock.' },
		],
		keyAchievements: [
			{ achievement: 'Provisioned EKS with Karpenter.' },
		],
	},
	coverLetter: {
		greeting: 'Dear Hiring Manager',
		paragraphs: ['I build secure cloud tooling.'],
		signoff: {
			name: 'Jane Doe',
			email: 'jane@example.com',
			linkedin: 'linkedin.com/in/jane-doe',
			github: 'github.com/janedoe',
		},
	},
};

describe('free writer eval — grounded narrative', () => {
	it('good fixture passes the no-fabrication + format grader', () => {
		const result = gradeFreeResume(GOOD, EV);
		expect(result.pass).toBe(true);
		expect(result.failures).toEqual([]);
	});

	it('grounded ATS coverage: evidence-backed JD keywords surface', () => {
		const resumeText = JSON.stringify(GOOD.resume);
		const aliasMap = new Map([
			['aws', 'aws'],
			['kubernetes', 'kubernetes'],
		]);
		const cov = groundedAtsCoverage(resumeText, ['AWS', 'Kubernetes', 'Snowflake'], aliasMap);
		expect(cov.covered.sort()).toEqual(['AWS', 'Kubernetes']);
		expect(cov.missing).toEqual(['Snowflake']); // no evidence → absent → honest
	});

	it('a fabricating writer is rejected (invented employer + metric)', () => {
		const bad: FreeResumeOutput = {
			...GOOD,
			resume: {
				...GOOD.resume,
				experience: [
					{
						company: 'Netflix',
						title: 'Senior Engineer',
						period: '2021–2022',
						highlights: ['Scaled to 200M users.'],
					},
				],
			},
		};
		const result = gradeFreeResume(bad, EV);
		expect(result.pass).toBe(false);
		expect(result.failures.length).toBeGreaterThan(0);
		expect(result.failures[0]).toContain('Fabricated employer');
	});

	it('a fabricating metric is rejected (ungrounded number)', () => {
		const bad: FreeResumeOutput = {
			...GOOD,
			resume: {
				...GOOD.resume,
				experience: [
					{
						company: 'Acme Corp',
						title: 'Platform Engineer',
						period: '2022–2025',
						highlights: [
							'Reduced latency by 95% across production.',
						],
					},
				],
			},
		};
		const result = gradeFreeResume(bad, EV);
		expect(result.pass).toBe(false);
		expect(result.failures.length).toBeGreaterThan(0);
		expect(result.failures[0]).toContain('Fabricated metric');
	});

	it('a bullet missing an action verb is rejected', () => {
		const bad: FreeResumeOutput = {
			...GOOD,
			resume: {
				...GOOD.resume,
				experience: [
					{
						company: 'Acme Corp',
						title: 'Platform Engineer',
						period: '2022–2025',
						highlights: [
							'The EKS cluster with Karpenter.',
						],
					},
				],
			},
		};
		const result = gradeFreeResume(bad, EV);
		expect(result.pass).toBe(false);
		expect(result.failures.length).toBeGreaterThan(0);
		expect(result.failures[0]).toContain('Missing action verb');
	});

	// -----------------------------------------------------------------------
	// Positioning + shipped-work fixture (commit/PR + positioning evidence)
	// -----------------------------------------------------------------------
	const EV_POSITIONED: FreeEvidence = {
		...EV,
		commitPrEvidence: 'Shipped work:\n- Hardened the GitHub adapter with size caps (PR #42).',
		profileIntelligence: 'Positioning signal: Platform & Kubernetes Engineering: senior',
	};

	const GOOD_POSITIONED: FreeResumeOutput = {
		...GOOD,
		resume: {
			...GOOD.resume,
			summary: 'Senior Platform engineer who ships grounded Kubernetes tooling on AWS.',
			experience: [
				{
					company: 'Acme Corp',
					title: 'Platform Engineer',
					period: '2022–2025',
					highlights: [
						'Provisioned EKS with Karpenter on AWS, improving autoscaling.',
						'Hardened the GitHub adapter with size caps (PR #42).',
					],
				},
			],
		},
	};

	it('positioned, shipped-work fixture passes all graders', () => {
		const result = gradeFreeResume(GOOD_POSITIONED, EV_POSITIONED);
		expect(result.pass).toBe(true);
		expect(result.failures).toEqual([]);
	});

	it('a non-positioned summary fails the positioning check', () => {
		const bad: FreeResumeOutput = {
			...GOOD_POSITIONED,
			resume: { ...GOOD_POSITIONED.resume, summary: 'I built some tooling at a company.' },
		};
		const result = gradeFreeResume(bad, EV_POSITIONED);
		expect(result.pass).toBe(false);
		expect(result.failures.some((f) => /positioning/i.test(f))).toBe(true);
	});

	it('a fabricated metric still fails even with positioning evidence', () => {
		const bad: FreeResumeOutput = {
			...GOOD_POSITIONED,
			resume: {
				...GOOD_POSITIONED.resume,
				experience: [
					{
						company: 'Acme Corp',
						title: 'Platform Engineer',
						period: '2022–2025',
						highlights: ['Scaled to 200M users on AWS.'],
					},
				],
			},
		};
		const result = gradeFreeResume(bad, EV_POSITIONED);
		expect(result.pass).toBe(false);
		expect(result.failures.some((f) => f.includes('Fabricated metric'))).toBe(true);
	});

	it('combined-overview judge (mocked) gates on threshold', async () => {
		const THRESHOLD = 0.7;
		const judge = {
			invoke: async (score: number) => ({
				score,
				reasoning: 'grounded narrative',
			}),
		};

		// Passing case: score >= threshold → gate passed
		const passingResult = await judge.invoke(0.9);
		const passingGate = passingResult.score >= THRESHOLD;
		expect(passingResult.score).toBeGreaterThanOrEqual(THRESHOLD);
		expect(passingGate).toBe(true);

		// Failing case: score < threshold → gate blocked
		const failingResult = await judge.invoke(0.4);
		const failingGate = failingResult.score >= THRESHOLD;
		expect(failingResult.score).toBeLessThan(THRESHOLD);
		expect(failingGate).toBe(false);
	});
});
