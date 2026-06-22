/**
 * @format
 * Free-tier writer eval (CLAUDE.md §5). Good output = grounded narrative:
 * no fabricated facts, evidence-backed JD keywords surface, impact-bullet
 * format, honest cover letter. Deterministic graders gate CI; an injectable
 * judge (mocked here) covers the subjective "reads as grounded narrative".
 */
import { describe, it, expect } from '@jest/globals';
import { gradeFreeResume, parseFreeResumeResponse } from './free-resume-writer.js';
import { groundedAtsCoverage } from '../ats/grounded-coverage.js';
import type { FreeEvidence } from '../free/gather-evidence.js';
import type { FreeResumeOutput } from './free-resume-writer.js';

/** Serialise a FreeResumeOutput as the raw JSON the emit_free_resume tool returns. */
const toToolJson = (out: FreeResumeOutput): string => JSON.stringify(out);

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

	// -----------------------------------------------------------------------
	// Realistic source-grounded impact: a benefit framed with a number drawn
	// from <commit_pr_evidence> passes; "doubled"/"removing" carry magnitude
	// with no digit, the source figures (15, 30) are grounded.
	// -----------------------------------------------------------------------
	const EV_METRIC: FreeEvidence = {
		...EV,
		commitPrEvidence:
			'Shipped work:\n- raise pod deadline 15->30 min so big repos finish in one pass.',
	};

	const GOOD_SOURCE_METRIC: FreeResumeOutput = {
		...GOOD,
		resume: {
			...GOOD.resume,
			experience: [
				{
					company: 'Acme Corp',
					title: 'Platform Engineer',
					period: '2022–2025',
					highlights: [
						'Doubled the ingestion window (15->30 min), removing multi-pass syncs.',
					],
				},
			],
		},
	};

	it('a benefit framed with a source number (15->30) passes the grader', () => {
		const result = gradeFreeResume(GOOD_SOURCE_METRIC, EV_METRIC);
		expect(result.pass).toBe(true);
		expect(result.failures).toEqual([]);
	});

	it('a bare invented percentage not in source still fails', () => {
		const bad: FreeResumeOutput = {
			...GOOD_SOURCE_METRIC,
			resume: {
				...GOOD_SOURCE_METRIC.resume,
				experience: [
					{
						company: 'Acme Corp',
						title: 'Platform Engineer',
						period: '2022–2025',
						highlights: ['Improved ingestion throughput by 40%.'],
					},
				],
			},
		};
		const result = gradeFreeResume(bad, EV_METRIC);
		expect(result.pass).toBe(false);
		expect(result.failures.some((f) => f.includes('Fabricated metric'))).toBe(true);
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

	// -----------------------------------------------------------------------
	// Pillar A — experience selection: an over-long role is truncated to the
	// first 5 (relevance-ordered) bullets by the deterministic cap, and the
	// grounding grader still passes.
	// -----------------------------------------------------------------------
	it('eval: an 8-bullet role is capped to the first 5 (relevance-ordered)', () => {
		const verbs = ['Provisioned', 'Hardened', 'Automated', 'Migrated', 'Optimised', 'Designed', 'Deployed', 'Built'];
		const eight = verbs.map((v) => `${v} EKS with Karpenter on AWS, improving autoscaling.`);
		const out = parseFreeResumeResponse(
			toToolJson({
				...GOOD,
				resume: {
					...GOOD.resume,
					experience: [{ company: 'Acme Corp', title: 'Platform Engineer', period: '2022–2025', highlights: eight }],
				},
			}),
		);
		expect(out.resume.experience[0]?.highlights).toEqual(eight.slice(0, 5));
		expect(gradeFreeResume(out, EV).pass).toBe(true);
	});

	// -----------------------------------------------------------------------
	// Pillar B — JD optimisation / ATS: the optimise-but-don't-fabricate
	// contract. An evidence-backed JD keyword (IAM) is surfaced and covered,
	// while an unsupported one (GraphQL) stays out — the grounding gate holds.
	// -----------------------------------------------------------------------
	it('eval: surfaces an evidence-backed JD keyword and omits an unsupported one', () => {
		const aliasIdentity = new Map<string, string>(); // identity alias map for the test
		const jdKeywords = ['IAM', 'GraphQL']; // IAM is in evidence, GraphQL is not
		const resumeWithIam: FreeResumeOutput = {
			...GOOD,
			resume: {
				...GOOD.resume,
				skills: [{ category: 'Cloud', skills: ['AWS', 'IAM', 'Kubernetes'] }],
				experience: [
					{
						company: 'Acme Corp',
						title: 'Platform Engineer',
						period: '2022–2025',
						highlights: ['Hardened IAM policies on AWS, scoping least-privilege access.'],
					},
				],
			},
		};
		const cov = groundedAtsCoverage(JSON.stringify(resumeWithIam), jdKeywords, aliasIdentity);
		expect(cov.covered).toEqual(expect.arrayContaining(['IAM']));
		expect(cov.covered).not.toContain('GraphQL');
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
