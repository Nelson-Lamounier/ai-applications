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

const VALID_DSA_CALIBRATION = {
    likelyTopics: [
        {
            canonicalName: 'arrays-strings',
            displayName: 'Arrays & Strings',
            confidence: 0.85,
            rationale: 'JD requires in-place array manipulation problems',
            jdEvidenceQuote: 'solve complex array manipulation problems',
        },
    ],
    honestyNote: 'These topics are inferred from JD language and signals — not confirmed interview format. Verify with recruiter.',
};

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

    it('validates and passes through dsaTopicCalibration when present', () => {
        const r = validateResearchResult({ ...VALID, dsaTopicCalibration: VALID_DSA_CALIBRATION }, INJECTED);
        expect(r.dsaTopicCalibration).toBeDefined();
        expect(r.dsaTopicCalibration!.likelyTopics).toHaveLength(1);
        expect(r.dsaTopicCalibration!.likelyTopics[0]!.canonicalName).toBe('arrays-strings');
        expect(r.dsaTopicCalibration!.likelyTopics[0]!.confidence).toBe(0.85);
        expect(r.dsaTopicCalibration!.honestyNote).toMatch(/inferred/i);
    });

    it('validates without dsaTopicCalibration (field is optional)', () => {
        const r = validateResearchResult(VALID, INJECTED);
        expect(r.dsaTopicCalibration).toBeUndefined();
    });

    it('rejects dsaTopicCalibration with a missing required topic sub-field', () => {
        const broken = {
            ...VALID,
            dsaTopicCalibration: {
                likelyTopics: [{ canonicalName: 'arrays-strings', displayName: 'Arrays & Strings', confidence: 0.9, rationale: 'test' }],
                // missing jdEvidenceQuote
                honestyNote: 'note',
            },
        };
        expect(() => validateResearchResult(broken, INJECTED)).toThrow(/schema validation/i);
    });

    it('rejects dsaTopicCalibration missing honestyNote', () => {
        const broken = {
            ...VALID,
            dsaTopicCalibration: {
                likelyTopics: [],
                // missing honestyNote
            },
        };
        expect(() => validateResearchResult(broken, INJECTED)).toThrow(/schema validation/i);
    });
});
