/**
 * @format
 * Strategist Agent — buildStrategistMessage unit tests.
 *
 * Covers the achievement & impact evidence injection added in the
 * cover-letter impact optimisation spec.
 */

import type { buildStrategistMessage as BuildStrategistMessageFn } from './strategist-agent.js';
import type { StrategistResearchResult, StrategistPipelineContext } from '@bedrock/shared';

let buildStrategistMessage: typeof BuildStrategistMessageFn;

beforeAll(async () => {
    ({ buildStrategistMessage } = await import('./strategist-agent.js'));
});

/** Minimal valid StrategistResearchResult — only required fields populated. */
const MIN_RESEARCH: StrategistResearchResult = {
    targetRole: 'Senior Software Engineer',
    targetCompany: 'Acme Corp',
    seniority: 'Senior',
    domain: 'Platform Engineering',
    companyProblem: '',
    dimensionMix: { customerFacing: 0, technical: 100, aiMl: 0, supportOps: 0, monitoring: 0 },
    hardRequirements: [],
    softRequirements: [],
    implicitRequirements: [],
    technologyInventory: { languages: [], frameworks: [], infrastructure: [], tools: [], methodologies: [] },
    experienceSignals: {
        yearsExpected: '3-5',
        domainExperience: '',
        leadershipExpectation: '',
        scaleIndicators: '',
    },
    verifiedMatches: [],
    partialMatches: [],
    gaps: [],
    overallFitRating: 'STRONG FIT',
    fitSummary: 'Good fit.',
    resumeData: null,
    kbContext: '',
    resumeConstraints: '',
    skillEvidenceLedger: [],
};

/** Minimal pipeline context — cast to avoid populating all required fields. */
const CTX = {
    userId: 'u-test',
    applicationId: 'app-test',
    jobDescription: 'Build reliable systems.',
    interviewStage: 'applied',
    includeCoverLetter: true,
} as unknown as StrategistPipelineContext;

describe('buildStrategistMessage — achievement evidence injection', () => {
    it('injects achievement & impact evidence into the strategist message', () => {
        const msg = buildStrategistMessage(
            MIN_RESEARCH,
            CTX,
            '',    // projectEvidence
            '',    // educationFacts
            '',    // experienceFacts
            '',    // roleEvidence
            '',    // yearsGapFraming
            '',    // codeStackContext
            'Decision impact (decision -> consequence):\n- X -> Y',
        );
        expect(msg).toContain('Decision impact');
        expect(msg).toContain('X -> Y');
    });

    it('omits the achievement section when achievementEvidence is empty', () => {
        const msg = buildStrategistMessage(MIN_RESEARCH, CTX, '', '', '', '', '', '', '');
        expect(msg).not.toContain('Achievement & Impact Evidence');
    });

    it('includes the section header when achievementEvidence is provided', () => {
        const msg = buildStrategistMessage(
            MIN_RESEARCH,
            CTX,
            '', '', '', '', '', '',
            'Achievements:\n- Reduced latency by 40%',
        );
        expect(msg).toContain('Achievement & Impact Evidence');
        expect(msg).toContain('Reduced latency by 40%');
    });
});
