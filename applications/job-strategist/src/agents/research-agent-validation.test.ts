/**
 * @format
 * Strategist Research Agent — schema validation safety-net tests.
 */

// research-agent.ts throws at module load if RESEARCH_MODEL is unset (CDK
// contract). Set it before the dynamic import.
process.env['RESEARCH_MODEL'] = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

let validateResearchResult: typeof import('./research-agent.js')['validateResearchResult'];

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
        const { fitSummary, ...broken } = VALID;
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
