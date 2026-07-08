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

    it('never carries a grounded-metrics section — feeding the ledger to the writer tripled its extended thinking (13.9K -> 37-56K output tokens, measured 2026-07-08); metrics enter via the post-writer Haiku weave', () => {
        const msg = buildStrategistMessage(MIN_RESEARCH, CTX, '', '', '', '', '', '', '');
        expect(msg).not.toContain('GROUNDED METRICS');
    });
});

describe('extractGapMitigations — phase 3 defences become structured data', () => {
	const XML = [
		'<phase_3_strategy>',
		'  <gap_mitigation>',
		'    <mitigation><gap>Ansible</gap><honest_framing>No Ansible experience; config management achieved via AWS CDK TypeScript and SSM Automation documents</honest_framing><bridge_narrative>Declarative infrastructure automation daily, different tool</bridge_narrative><proactive_action>Work through an Ansible playbook conversion of one CDK stack</proactive_action><go_no_go>go</go_no_go></mitigation>',
		'    <mitigation><gap>HPC / simulation</gap><honest_framing><![CDATA[No HPC scheduler experience; all compute is cloud-native]]></honest_framing><go_no_go>conditional</go_no_go></mitigation>',
		'  </gap_mitigation>',
		'</phase_3_strategy>',
	].join('\n');

	it('extracts every mitigation with its framing, bridge, action and verdict', async () => {
		const { extractGapMitigations } = await import('./strategist-agent.js');
		const out = extractGapMitigations(XML);
		expect(out).toHaveLength(2);
		expect(out[0]).toEqual({
			gap: 'Ansible',
			honestFraming: 'No Ansible experience; config management achieved via AWS CDK TypeScript and SSM Automation documents',
			bridgeNarrative: 'Declarative infrastructure automation daily, different tool',
			proactiveAction: 'Work through an Ansible playbook conversion of one CDK stack',
			goNoGo: 'go',
		});
		// CDATA + missing optional fields tolerated.
		expect(out[1].gap).toBe('HPC / simulation');
		expect(out[1].honestFraming).toContain('cloud-native');
		expect(out[1].goNoGo).toBe('conditional');
	});

	it('returns [] when the section is absent', async () => {
		const { extractGapMitigations } = await import('./strategist-agent.js');
		expect(extractGapMitigations('<phase_1_jd_analysis>x</phase_1_jd_analysis>')).toEqual([]);
	});
});
