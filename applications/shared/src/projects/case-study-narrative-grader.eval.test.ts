/**
 * @format
 * Narrative-phase eval (CLAUDE.md §5). Defines "good output" for the refined
 * case-study prompt: one combined story, work+collaboration as the spine,
 * tech demoted to a grounding aid, confident voice. Deterministic graders run
 * in CI (no Bedrock); the combined-overview judge is driven here by a mock.
 */
import { describe, it, expect } from '@jest/globals';
import {
    gradeWorkLeadsNarrative,
    gradeTechNotSpine,
    gradeConfidentVoice,
    runNarrativeGraders,
    judgeCombinedOverview,
} from './case-study-narrative-grader.js';
import type { CaseStudy } from './case-study-types.js';

const sig = (over: Partial<CaseStudy['highlights'][number]['sourceSignals']> = {}) => ({
    commits: [], pulls: [], files: [], ungroundedClaims: [], grounding: 'GROUNDED' as const, ...over,
});
const commitSig = sig({ commits: [{ repoFullName: 'me/app', sha: 'abc1234', authoredAt: 'x', message: 'm' }] });

// A "good" case study: work-led rows, product-led pitch, confident voice.
const GOOD: CaseStudy = {
    tagline: 'A coaching tool that prepares engineers for interviews',
    pitch: 'I built a coaching tool that helps engineers rehearse interviews.\n\nI designed the grounding pipeline so every claim ties to a commit.',
    stack: [],
    decisions: [{ title: 'Chose RDS', context: 'c', decision: 'd', consequences: 'q', confidence: 'high', sourceSignals: commitSig }],
    highlights: [{ title: 'Shipped the coach', description: 'I built the coaching flow end to end.', sourceSignals: commitSig }],
    challenges: [{ problem: 'Grounding was hard', solution: 'I added a verifier.', sourceSignals: commitSig }],
    depthMarkers: { hasTests: true, testCoverageSignal: 'light', hasCi: true, ciMaturity: 'basic', documentationDensity: 'readme_only', hasDeploymentEvidence: false, deploymentUrl: null, refactorCount: 0 },
    architecture: { diagramFormat: 'mermaid', diagramSource: 'graph LR', nodes: [], edges: [] },
    resumeBullets: [{ angle: 'backend', bullets: ['Built X'] }],
};

describe('case-study narrative eval — good fixture', () => {
    it('passes every deterministic grader', () => {
        expect(runNarrativeGraders({ caseStudy: GOOD }).pass).toBe(true);
    });
});

describe('case-study narrative eval — one bad fixture per grader', () => {
    it('gradeWorkLeadsNarrative fails when a highlight cites no commit or pull', () => {
        const bad = { ...GOOD, highlights: [{ ...GOOD.highlights[0], sourceSignals: sig({ files: [{ repoFullName: 'me/app', path: 'a.ts' }] }) }] };
        expect(gradeWorkLeadsNarrative({ caseStudy: bad }).pass).toBe(false);
    });

    it('gradeTechNotSpine fails when a highlight title is tech-dominated', () => {
        const bad = { ...GOOD, highlights: [{ ...GOOD.highlights[0], title: 'Kubernetes EKS Terraform Helm ArgoCD pipeline' }] };
        expect(gradeTechNotSpine({ caseStudy: bad }).pass).toBe(false);
    });

    it('gradeConfidentVoice fails on hedged phrasing', () => {
        const bad = { ...GOOD, pitch: 'We built a tool that appears to help engineers.' };
        expect(gradeConfidentVoice({ caseStudy: bad }).pass).toBe(false);
    });

    it('gradeConfidentVoice fails on a hedged challenge', () => {
        const bad = { ...GOOD, challenges: [{ ...GOOD.challenges[0], solution: 'I attempted to fix it but it appears to work.' }] };
        expect(gradeConfidentVoice({ caseStudy: bad }).pass).toBe(false);
    });
});

describe('case-study narrative eval — combined-overview judge (mocked)', () => {
    it('passes when the judge scores at/above threshold', async () => {
        const judge = { invoke: async () => ({ score: 0.9, reasoning: 'one combined story' }) };
        const res = await judgeCombinedOverview(GOOD, judge, 0.7);
        expect(res.pass).toBe(true);
        expect(res.score).toBe(0.9);
    });

    it('fails when the judge scores below threshold (reads as fragments)', async () => {
        const judge = { invoke: async () => ({ score: 0.4, reasoning: 'per-repo fragments' }) };
        const res = await judgeCombinedOverview(GOOD, judge, 0.7);
        expect(res.pass).toBe(false);
        expect(res.failures[0]).toMatch(/fragment/i);
    });
});
