/**
 * @format
 * Unit tests for the free-tier resume writer agent.
 *
 * Covers:
 *   - parseFreeResumeResponse — JSON → FreeResumeOutput with validation
 *   - gradeFreeResume — deterministic anti-fabrication grader
 */
import { describe, it, expect } from '@jest/globals';
import { gradeFreeResume, parseFreeResumeResponse } from '../free-resume-writer.js';
import type { FreeEvidence } from '../../../free/gather-evidence.js';
import type { FreeResumeOutput } from '../free-resume-writer.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const evidence: FreeEvidence = {
    kbPassages: [
        '[Source: me/infra/eks.tf]\nProvisioned an EKS cluster with Karpenter autoscaling.',
    ],
    projectEvidence: 'Tucaken — SaaS for code-grounded resumes; 16-CDK-stack AWS, EKS, Bedrock.',
    extractedTech: 'aws, kubernetes, terraform, bedrock',
    careerFacts: 'Acme Corp — Platform Engineer — 2022–2025',
    educationFacts: 'BSc Computer Science — Example University',
    commitPrEvidence: '',
    profileIntelligence: '',
    achievementEvidence: '',
};

const good: FreeResumeOutput = {
    resume: {
        profile: {
            name: 'X',
            title: 'Platform Engineer',
            email: 'x@example.com',
            location: 'London, UK',
        },
        summary: 'I built grounded resume tooling.',
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
                { name: 'Tucaken', description: 'SaaS for code-grounded resumes; 16-CDK-stack AWS, EKS, Bedrock.' },
            ],
        keyAchievements: [
                { achievement: 'Provisioned an EKS cluster with Karpenter autoscaling.' },
            ],
    },
    coverLetter: {
        greeting: 'Dear Hiring Manager',
        paragraphs: ['I build code-grounded tooling.'],
        signoff: { name: 'X', email: '', linkedin: '', github: '' },
    },
};

// ---------------------------------------------------------------------------
// parseFreeResumeResponse
// ---------------------------------------------------------------------------

describe('parseFreeResumeResponse', () => {
    it('parses + validates a {resume, coverLetter} tool payload', () => {
        const out = parseFreeResumeResponse(JSON.stringify(good));
        expect(out.coverLetter.greeting).toBe('Dear Hiring Manager');
    });

    it('returns the resume summary field intact', () => {
        const out = parseFreeResumeResponse(JSON.stringify(good));
        expect(out.resume.summary).toBe('I built grounded resume tooling.');
    });

    it('throws on missing coverLetter', () => {
        const payload = { resume: good.resume };
        expect(() => parseFreeResumeResponse(JSON.stringify(payload))).toThrow();
    });

    it('throws on invalid JSON', () => {
        expect(() => parseFreeResumeResponse('not json')).toThrow();
    });

    it('throws on missing resume', () => {
        const payload = { coverLetter: good.coverLetter };
        expect(() => parseFreeResumeResponse(JSON.stringify(payload))).toThrow();
    });

    it('parseFreeResumeResponse caps each experience role to 5 highlights', () => {
        const eight = Array.from({ length: 8 }, (_, i) => `Bullet ${i + 1} starts with a verb.`);
        const input: FreeResumeOutput = { ...good, resume: { ...good.resume, experience: [{ company: 'Freelance', title: 'Eng', period: '2018-Now', highlights: eight }] } };
        const out = parseFreeResumeResponse(JSON.stringify(input));
        expect(out.resume.experience[0].highlights).toHaveLength(5);
        expect(out.resume.experience[0].highlights).toEqual(eight.slice(0, 5));
    });
});

// ---------------------------------------------------------------------------
// gradeFreeResume
// ---------------------------------------------------------------------------

describe('gradeFreeResume', () => {
    it('passes when bullets are evidence-grounded and action-verb led', () => {
        const result = gradeFreeResume(good, evidence);
        expect(result.pass).toBe(true);
        expect(result.failures).toHaveLength(0);
    });

    it('fails on a fabricated employer not in the career facts', () => {
        const bad: FreeResumeOutput = {
            ...good,
            resume: {
                ...good.resume,
                experience: [
                    {
                        company: 'Google',
                        title: 'SRE',
                        period: '2020–2022',
                        highlights: ['Built reliable systems.'],
                    },
                ],
            },
        };
        const result = gradeFreeResume(bad, evidence);
        expect(result.pass).toBe(false);
        expect(result.failures.some((f) => f.toLowerCase().includes('employer'))).toBe(true);
    });

    it('fails on a fabricated metric absent from evidence', () => {
        const bad: FreeResumeOutput = {
            ...good,
            resume: {
                ...good.resume,
                experience: [
                    {
                        company: 'Acme Corp',
                        title: 'Platform Engineer',
                        period: '2022–2025',
                        highlights: ['Cut costs by 93% across 4000 servers.'],
                    },
                ],
            },
        };
        const result = gradeFreeResume(bad, evidence);
        expect(result.pass).toBe(false);
        expect(result.failures.some((f) => f.toLowerCase().includes('metric'))).toBe(true);
    });

    it('fails on a bullet that does not start with an action verb', () => {
        const bad: FreeResumeOutput = {
            ...good,
            resume: {
                ...good.resume,
                experience: [
                    {
                        company: 'Acme Corp',
                        title: 'Platform Engineer',
                        period: '2022–2025',
                        highlights: ['The EKS cluster was provisioned using Karpenter.'],
                    },
                ],
            },
        };
        const result = gradeFreeResume(bad, evidence);
        expect(result.pass).toBe(false);
        expect(result.failures.some((f) => f.toLowerCase().includes('action verb'))).toBe(true);
    });

    it('passes with multiple grounded experience entries', () => {
        const multi: FreeResumeOutput = {
            ...good,
            resume: {
                ...good.resume,
                experience: [
                    {
                        company: 'Acme Corp',
                        title: 'Platform Engineer',
                        period: '2022–2025',
                        highlights: [
                            'Provisioned EKS with Karpenter autoscaling on AWS.',
                            'Deployed Terraform infrastructure for Kubernetes workloads.',
                        ],
                    },
                ],
            },
        };
        expect(gradeFreeResume(multi, evidence).pass).toBe(true);
    });

    it('fails on a fabricated metric in keyAchievements', () => {
        const bad: FreeResumeOutput = {
            ...good,
            resume: {
                ...good.resume,
                keyAchievements: [
                    { achievement: 'Managed a team of 50 engineers globally.' },
                ],
            },
        };
        const result = gradeFreeResume(bad, evidence);
        expect(result.pass).toBe(false);
        expect(result.failures.some((f) => f.toLowerCase().includes('metric'))).toBe(true);
    });

    it('fails on a suffixed magnitude metric (1.3M) absent from evidence', () => {
        const bad: FreeResumeOutput = {
            ...good,
            resume: {
                ...good.resume,
                experience: [
                    {
                        company: 'Acme Corp',
                        title: 'Platform Engineer',
                        period: '2022–2025',
                        highlights: ['Served 1.3M requests per day via EKS.'],
                    },
                ],
            },
        };
        const result = gradeFreeResume(bad, evidence);
        expect(result.pass).toBe(false);
        expect(result.failures.some((f) => f.includes('1.3'))).toBe(true);
    });

    it('flags a summary with no positioning lead when positioning evidence exists', () => {
        const ev = { ...evidence, profileIntelligence: 'Positioning signal: Platform & Kubernetes Engineering: senior' };
        const bad = { ...good, resume: { ...good.resume, summary: 'I did some things at a company.' } };
        expect(gradeFreeResume(bad, ev).failures.some((f) => /positioning/i.test(f))).toBe(true);
    });

    it('passes when the summary opens with a positioning line', () => {
        const ev = { ...evidence, profileIntelligence: 'Positioning signal: Platform & Kubernetes Engineering: senior' };
        const goodPositioned = { ...good, resume: { ...good.resume, summary: 'Senior Platform & Kubernetes engineer who ships grounded tooling.' } };
        expect(gradeFreeResume(goodPositioned, ev).pass).toBe(true);
    });

    it('does not run the positioning check when no positioning evidence is present', () => {
        const bad = { ...good, resume: { ...good.resume, summary: 'I did some things at a company.' } };
        expect(gradeFreeResume(bad, evidence).failures.some((f) => /positioning/i.test(f))).toBe(false);
    });

    // -------------------------------------------------------------------------
    // Substring collision — PR numbers in commitPrEvidence (token-exact fix)
    // -------------------------------------------------------------------------

    it('rejects a metric whose digits are a substring of a PR number but not a standalone token', () => {
        // Evidence only contains "#42" — "42" is grounded, but "4" is NOT a standalone token.
        const ev: FreeEvidence = {
            ...evidence,
            commitPrEvidence: 'Hardened the GitHub adapter with size caps (PR #42).',
        };
        const bad: FreeResumeOutput = {
            ...good,
            resume: {
                ...good.resume,
                experience: [
                    {
                        company: 'Acme Corp',
                        title: 'Platform Engineer',
                        period: '2022–2025',
                        // "4" is a substring of "42" in the corpus, but NOT a standalone number.
                        highlights: ['Improved throughput by 4%.'],
                    },
                ],
            },
        };
        const result = gradeFreeResume(bad, ev);
        expect(result.pass).toBe(false);
        expect(result.failures.some((f) => /metric/i.test(f) && f.includes('4'))).toBe(true);
    });

    it('passes a metric that exactly matches a standalone number token from commitPrEvidence', () => {
        const ev: FreeEvidence = {
            ...evidence,
            commitPrEvidence: 'Hardened the GitHub adapter with size caps (PR #42).',
        };
        const withGrounded: FreeResumeOutput = {
            ...good,
            resume: {
                ...good.resume,
                experience: [
                    {
                        company: 'Acme Corp',
                        title: 'Platform Engineer',
                        period: '2022–2025',
                        // "42" IS a standalone number token in the corpus — must pass.
                        highlights: ['Merged 42 pull requests to the adapter.'],
                    },
                ],
            },
        };
        const result = gradeFreeResume(withGrounded, ev);
        expect(result.pass).toBe(true);
        expect(result.failures).toHaveLength(0);
    });

    it('returns all failures when multiple violations exist', () => {
        const bad: FreeResumeOutput = {
            ...good,
            resume: {
                ...good.resume,
                experience: [
                    {
                        company: 'Google',                   // fabricated employer
                        title: 'SRE',
                        period: '2020–2022',
                        highlights: ['The system handled 50000 requests.'], // non-verb + fabricated metric
                    },
                ],
            },
        };
        const result = gradeFreeResume(bad, evidence);
        expect(result.pass).toBe(false);
        expect(result.failures.length).toBeGreaterThan(1);
    });

    it('gradeFreeResume flags a role with more than 5 highlights', () => {
        const six = Array.from({ length: 6 }, (_, i) => `Did thing ${i + 1}.`);
        const bad = { ...good, resume: { ...good.resume, experience: [{ company: 'Freelance', title: 'Eng', period: 'p', highlights: six }] } } as never;
        expect(gradeFreeResume(bad, evidence).failures.some((f) => /more than 5|exceeds 5|bullet/i.test(f))).toBe(true);
    });

    it('gradeFreeResume flags a fabricated metric in the cover letter', () => {
        // 73 is NOT in the evidence corpus (only 16, 2022, 2025 appear as number tokens)
        const bad = { ...good, coverLetter: { ...good.coverLetter, paragraphs: ['I cut latency by 73% across the platform.'] } } as never;
        expect(gradeFreeResume(bad, evidence).failures.some((f) => /cover letter/i.test(f) && /73/.test(f))).toBe(true);
    });

    it('treats numbers grounded only in achievementEvidence as grounded (not fabricated)', () => {
        const ev = { ...evidence, achievementEvidence: 'Decision impact: lifted skills overlap from 2.2% to full operation; recovered 1,964 chunks.' };
        const out = { ...good, resume: { ...good.resume, summary: 'Lifted skills-overlap coverage from 2.2% and recovered 1,964 chunks.' } } as never;
        const failures = gradeFreeResume(out, ev).failures;
        expect(failures.some((f) => /"2\.2"|"1964"|"1,964"/.test(f))).toBe(false);
    });
});
