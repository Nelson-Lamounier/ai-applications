/**
 * @format
 * Strategist Agent — buildStrategistMessage unit tests.
 *
 * Covers the achievement & impact evidence injection added in the
 * cover-letter impact optimisation spec.
 */

import type { buildStrategistMessage as BuildStrategistMessageFn } from '../strategist-agent.js';
import type { StrategistResearchResult, StrategistPipelineContext } from '@bedrock/shared';

let buildStrategistMessage: typeof BuildStrategistMessageFn;
let PROFILE_INTELLIGENCE_HEADER: string;

beforeAll(async () => {
    ({ buildStrategistMessage, PROFILE_INTELLIGENCE_HEADER } = await import('../strategist-agent.js'));
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
        const msg = buildStrategistMessage(MIN_RESEARCH, CTX, '', '', '', '', '', '');
        expect(msg).not.toContain('Achievement & Impact Evidence');
    });

    it('includes the section header when achievementEvidence is provided', () => {
        const msg = buildStrategistMessage(
            MIN_RESEARCH,
            CTX,
            '', '', '', '', '',
            'Achievements:\n- Reduced latency by 40%',
        );
        expect(msg).toContain('Achievement & Impact Evidence');
        expect(msg).toContain('Reduced latency by 40%');
    });

    it('never carries a grounded-metrics section — feeding the ledger to the writer tripled its extended thinking (13.9K -> 37-56K output tokens, measured 2026-07-08); metrics enter via the post-writer Haiku weave', () => {
        const msg = buildStrategistMessage(MIN_RESEARCH, CTX, '', '', '', '', '', '');
        expect(msg).not.toContain('GROUNDED METRICS');
    });
});

describe('buildStrategistMessage — profile intelligence section (the summary S3 source)', () => {
    const PROFILE = 'CANDIDATE PROFILE INTELLIGENCE — derived from GitHub.\nCode-demonstrated direction:\n- Platform & Infrastructure: senior';

    // Task 8: the writer message no longer carries a project case-studies
    // section at all (buildProjectEvidence was removed -- projects are now
    // composed by the dedicated projects agent from its own payload, not
    // injected into the writer's prompt). The regression this test originally
    // guarded (run 77e325ea: the profile block sat inside the case-studies
    // wrapper and the summary's S3 angle had no section to draw from) is now
    // structurally impossible -- there is no case-studies wrapper left for the
    // profile block to be buried inside.
    it('injects the profile block under its OWN labelled section; the case-studies wrapper it used to guard against no longer exists', () => {
        const msg = buildStrategistMessage(MIN_RESEARCH, CTX, '', '', '', '', '', '', PROFILE);
        expect(msg).toContain(PROFILE_INTELLIGENCE_HEADER);
        expect(msg).toContain('--- BEGIN PROFILE INTELLIGENCE ---');
        expect(msg).toContain('Platform & Infrastructure: senior');
        expect(msg).not.toContain('PROJECT CASE STUDIES');
    });

    it('omits the section entirely when no profile intelligence exists (fail-open users)', () => {
        const msg = buildStrategistMessage(MIN_RESEARCH, CTX, '', '', '', '', '', '');
        expect(msg).not.toContain('Profile Intelligence');
    });
});

describe('buildStrategistMessage — candidate contact section (per-user identity, any tenant)', () => {
    it('injects the contact block under its labelled section (the persona signoff placeholders reference it by name)', () => {
        const msg = buildStrategistMessage(MIN_RESEARCH, CTX, '', '', '', '', '', '', undefined,
            'name: Grace Hopper\nemail: grace@navy.example');
        expect(msg).toContain('### Candidate Contact');
        expect(msg).toContain('name: Grace Hopper');
    });

    it('omits the section when no contact exists — the persona instructs empty fields, never invention', () => {
        const msg = buildStrategistMessage(MIN_RESEARCH, CTX, '', '', '', '', '', '');
        expect(msg).not.toContain('Candidate Contact');
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
		const { extractGapMitigations } = await import('../strategist-agent.js');
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
		const { extractGapMitigations } = await import('../strategist-agent.js');
		expect(extractGapMitigations('<phase_1_jd_analysis>x</phase_1_jd_analysis>')).toEqual([]);
	});
});
