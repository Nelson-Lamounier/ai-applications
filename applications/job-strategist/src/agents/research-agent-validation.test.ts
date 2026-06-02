/**
 * @format
 * Strategist Research Agent — schema validation safety-net tests.
 */

// research-agent.ts throws at module load if RESEARCH_MODEL is unset (CDK
// contract). Set it before the dynamic import.
import type { validateResearchResult as ValidateResearchResultFn } from './research-agent.js';

process.env['RESEARCH_MODEL'] = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

let validateResearchResult: typeof ValidateResearchResultFn;

beforeAll(async () => {
    ({ validateResearchResult } = await import('./research-agent.js'));
});

const VALID = {
    targetRole: 'Senior SRE',
    targetCompany: 'Acme',
    seniority: 'senior',
    domain: 'cloud-infrastructure',
    hardRequirements: [{ skill: 'Kubernetes', context: '5y prod', disqualifying: true }],
    softRequirements: [{ skill: 'Mentoring', context: 'team lead' }],
    implicitRequirements: ['on-call'],
    technologyInventory: {
        languages: ['Go'], frameworks: ['CDK'], infrastructure: ['AWS'],
        tools: ['ArgoCD'], methodologies: ['GitOps'],
    },
    experienceSignals: {
        yearsExpected: '5+', domainExperience: 'cloud-native',
        leadershipExpectation: 'team lead', scaleIndicators: '100k+',
    },
    verifiedMatches: [{ skill: 'K8s', sourceCitation: 'self-healing', depth: 'expert', recency: '2026' }],
    partialMatches: [{ skill: 'TF', gapDescription: 'uses CDK', transferableFoundation: 'IaC', framingSuggestion: 'frame CDK' }],
    gaps: [{ skill: 'Go', gapType: 'hard', impactSeverity: 'minor', disqualifyingAssessment: 'not blocking' }],
    overallFitRating: 'STRONG FIT',
    fitSummary: 'Strong alignment.',
};

const INJECTED = { resumeData: null, kbContext: 'ctx', resumeConstraints: 'rules' };

describe('validateResearchResult', () => {
    it('returns a typed result merged with injected (non-model) fields', () => {
        const r = validateResearchResult(VALID, INJECTED);
        expect(r.targetRole).toBe('Senior SRE');
        expect(r.verifiedMatches).toHaveLength(1);
        expect(r.kbContext).toBe('ctx');
        expect(r.resumeConstraints).toBe('rules');
        expect(r.resumeData).toBeNull();
    });

    it('throws fast when a required model field is missing', () => {
        const { fitSummary: _fitSummary, ...broken } = VALID;
        expect(() => validateResearchResult(broken, INJECTED)).toThrow(/schema validation/i);
    });

    it('throws fast when the model injects an unknown field', () => {
        expect(() => validateResearchResult({ ...VALID, injected: 'nope' }, INJECTED))
            .toThrow(/schema validation/i);
    });

    it('rejects an invalid enum (overallFitRating)', () => {
        expect(() => validateResearchResult({ ...VALID, overallFitRating: 'MAYBE' }, INJECTED))
            .toThrow(/schema validation/i);
    });
});

// =============================================================================
// pillarClassification — optional field tests (S2)
// =============================================================================

const BASE = {
    targetRole: 'SRE', targetCompany: 'Acme', seniority: 'senior', domain: 'infra',
    hardRequirements: [], softRequirements: [], implicitRequirements: [],
    technologyInventory: { languages: [], frameworks: [], infrastructure: [], tools: [], methodologies: [] },
    experienceSignals: { yearsExpected: '5', domainExperience: 'x', leadershipExpectation: 'y', scaleIndicators: 'z' },
    verifiedMatches: [], partialMatches: [], gaps: [],
    overallFitRating: 'STRONG FIT', fitSummary: 'ok',
};
const INJECTED_BASE = { resumeData: null, kbContext: '', resumeConstraints: '' };

describe('validateResearchResult — pillarClassification (optional)', () => {
    it('accepts a brief WITHOUT pillarClassification (optional)', () => {
        const r = validateResearchResult(BASE, INJECTED_BASE);
        expect(r.pillarClassification).toBeUndefined();
    });

    it('passes pillarClassification through when present', () => {
        const r = validateResearchResult({
            ...BASE,
            pillarClassification: {
                primaryPillar: 'devops-sre-platform', secondaryPillars: ['ai-engineering'],
                confidence: 0.8, jdEvidenceTokens: ['on-call rotation', 'Kubernetes'], classificationNote: 'inferred from JD',
            },
        }, INJECTED_BASE);
        expect(r.pillarClassification?.primaryPillar).toBe('devops-sre-platform');
        expect(r.pillarClassification?.secondaryPillars).toEqual(['ai-engineering']);
    });

    it('rejects an invalid primaryPillar enum', () => {
        expect(() => validateResearchResult({
            ...BASE,
            pillarClassification: { primaryPillar: 'wizardry', secondaryPillars: [], confidence: 1, jdEvidenceTokens: [], classificationNote: 'x' },
        }, INJECTED_BASE)).toThrow(/schema validation/);
    });
});
