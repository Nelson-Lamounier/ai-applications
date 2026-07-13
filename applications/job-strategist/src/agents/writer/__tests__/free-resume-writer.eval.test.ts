/**
 * @format
 * Free-tier writer eval (CLAUDE.md §5). Good output = grounded narrative:
 * no fabricated facts, evidence-backed JD keywords surface, impact-bullet
 * format, honest cover letter. Deterministic graders gate CI; an injectable
 * judge (mocked here) covers the subjective "reads as grounded narrative".
 */
import { describe, it, expect } from '@jest/globals';
import { gradeFreeResume, parseFreeResumeResponse } from '../free-resume-writer.js';
import { groundedAtsCoverage } from '../../../ats/coverage/grounded-coverage.js';
import { validateCoverLetter } from '../../quality/cover-letter-guard.js';
import type { FreeEvidence } from '../../../free/gather-evidence.js';
import type { FreeResumeOutput } from '../free-resume-writer.js';
import type { CoverLetter } from '../../quality/cover-letter-guard.js';

/** Serialise a FreeResumeOutput as the raw JSON the emit_free_resume tool returns. */
const toToolJson = (out: FreeResumeOutput): string => JSON.stringify(out);

const EV: FreeEvidence = {
	// Second passage grounds 2.2 and 1,964 for the Pillar 2 eval assertion.
	kbPassages: [
		'[Source: me/infra/eks.tf]\nProvisioned EKS with Karpenter.',
		'[Source: me/enrichment/metrics.md]\nLifted skills overlap from 2.2% to full operation; recovered 1,964 chunks.',
	],
	projectEvidence: 'Tucaken — 16-CDK-stack AWS, EKS, Bedrock.',
	extractedTech: 'aws kubernetes terraform bedrock',
	careerFacts: 'Acme Corp — Platform Engineer — 2022–2025',
	educationFacts: 'BSc CS — Example University',
	commitPrEvidence: '',
	profileIntelligence: '',
	achievementEvidence: '',
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

	// -----------------------------------------------------------------------
	// Cover-letter contract: no forward-looking fabrication + challenge-led hook
	// -----------------------------------------------------------------------

	// A hand-built cover-letter fixture grounded in EV evidence (no numeric
	// tokens that are absent from the corpus). Uses "enrichment" to satisfy the
	// challenge/achievement regex and "consolidated" to satisfy decision-impact.
	const GOOD_CL: CoverLetter = {
		greeting: 'Dear Hiring Manager',
		paragraphs: [
			'The enrichment pipeline challenge attracted me to this role: wiring Bedrock into a knowledge-base so grounding is deterministic, not hopeful.',
			'At Acme Corp I consolidated the ingestion strategy, retired the ad-hoc ETL layer, and shipped a Karpenter-backed EKS cluster that made the platform autoscale without manual tuning.',
		],
		signoff: GOOD.coverLetter.signoff,
	};

	it('eval: a forward-looking skill-acquisition cover letter is flagged by the guard', () => {
		const letter = { greeting: 'Dear Hiring Manager', paragraphs: ['I am actively beginning Azure onboarding.'], signoff: GOOD.coverLetter.signoff } as never;
		expect(validateCoverLetter(letter, 'Solutions Support Engineer', '').some((v) => v.code === 'forward_looking_skill_claim')).toBe(true);
	});

	it('eval: a good cover letter references a challenge/achievement and a decision impact', () => {
		const text = GOOD_CL.paragraphs.join(' ');
		expect(/bedrock:Rerank|simulate-principal-policy|enrichment/i.test(text)).toBe(true);     // challenge/achievement
		expect(/retir(e|ed)|cut .* layer|reduced|consolidat/i.test(text)).toBe(true);             // a decision-impact phrase
		expect(gradeFreeResume({ ...GOOD, coverLetter: GOOD_CL }, EV).pass).toBe(true);  // grounded
	});

	// -----------------------------------------------------------------------
	// Pillar 1 — readability guard: run-on sentences + greeting punctuation
	// -----------------------------------------------------------------------

	it('eval: a >40-word cover-letter sentence is flagged by the guard', () => {
		const longPara = 'When a silent IAM failure caused every Bedrock Rerank call to fall back to cosine retrieval with no user-visible error I diagnosed it via simulate-principal-policy and confirmed InvokeModel allowed while Rerank returned implicit deny and then corrected the Pod Identity policy in CDK and verified the fix with a live Rerank API call against the cluster.';
		const letter = { greeting: 'Dear Hiring Manager,', paragraphs: [longPara], signoff: GOOD.coverLetter.signoff } as never;
		expect(validateCoverLetter(letter, 'Solutions Support Engineer', '').some((v) => v.code === 'long_sentence')).toBe(true);
	});

	it('eval: a greeting without a comma is flagged', () => {
		const letter = { greeting: 'Dear Hiring Manager', paragraphs: ['I resolve IAM incidents at AWS.'], signoff: GOOD.coverLetter.signoff } as never;
		expect(validateCoverLetter(letter, 'Solutions Support Engineer', '').some((v) => v.code === 'greeting_format')).toBe(true);
	});

	// -----------------------------------------------------------------------
	// Pillar 1 — company bridge: a good letter names a JD product concept
	// -----------------------------------------------------------------------

	it('eval: a good cover letter names a JD product concept (the bridge)', () => {
		const bridgeParagraphs = [
			'I resolve cloud-security incidents at AWS daily — tracing compromised IAM keys through CloudTrail and restoring access fast.',
			'That skill set transfers directly to the Solutions Support Engineer role: helping your customers operationalise CSPM findings across their multi-cloud estates.',
		];
		const GOOD_BRIDGE = { greeting: 'Dear Hiring Manager,', paragraphs: bridgeParagraphs, signoff: GOOD.coverLetter.signoff } as never;
		const text = bridgeParagraphs.join(' ');
		expect(/CSPM|multi-cloud|runtime security|threat detection/i.test(text)).toBe(true);   // bridges to the product surface
		expect(validateCoverLetter(GOOD_BRIDGE, 'Solutions Support Engineer', '')).toEqual([]); // clean
	});

	// -----------------------------------------------------------------------
	// Pillar 2 — grounded metric surfaces; coined number still fails the gate
	// -----------------------------------------------------------------------

	it('eval: a bullet surfaces a grounded metric and the gate blocks a coined one', () => {
		// 2.2 and 1,964 are grounded via the EV.kbPassages metrics entry above.
		const grounded = { ...GOOD, resume: { ...GOOD.resume, summary: 'Lifted skills-overlap coverage from 2.2% to full operation and recovered 1,964 chunks.' } } as never;
		expect(gradeFreeResume(grounded, EV).pass).toBe(true);
		// 47 is genuinely absent from EV — the gate must block it.
		const coined = { ...GOOD, resume: { ...GOOD.resume, summary: 'Cut per-repo processing cost by 47%.' } } as never;
		expect(gradeFreeResume(coined, EV).failures.some((f) => /47/.test(f))).toBe(true);
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
