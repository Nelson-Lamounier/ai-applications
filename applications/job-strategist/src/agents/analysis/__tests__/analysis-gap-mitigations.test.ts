/**
 * @format
 * Analysis Agent — extractGapMitigations extraction.
 *
 * Relocated from `agents/writer/__tests__/strategist-agent.test.ts` (Phase 5
 * PR-B Task 8 -- the writer's deletion): `extractGapMitigations` moved to
 * `analysis-extractors.ts` in Task 3, byte-identical.
 */

import { extractGapMitigations } from '../analysis-extractors.js';

describe('extractGapMitigations — phase 3 defences become structured data', () => {
	const XML = [
		'<phase_3_strategy>',
		'  <gap_mitigation>',
		'    <mitigation><gap>Ansible</gap><honest_framing>No Ansible experience; config management achieved via AWS CDK TypeScript and SSM Automation documents</honest_framing><bridge_narrative>Declarative infrastructure automation daily, different tool</bridge_narrative><proactive_action>Work through an Ansible playbook conversion of one CDK stack</proactive_action><go_no_go>go</go_no_go></mitigation>',
		'    <mitigation><gap>HPC / simulation</gap><honest_framing><![CDATA[No HPC scheduler experience; all compute is cloud-native]]></honest_framing><go_no_go>conditional</go_no_go></mitigation>',
		'  </gap_mitigation>',
		'</phase_3_strategy>',
	].join('\n');

	it('extracts every mitigation with its framing, bridge, action and verdict', () => {
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

	it('returns [] when the section is absent', () => {
		expect(extractGapMitigations('<phase_1_jd_analysis>x</phase_1_jd_analysis>')).toEqual([]);
	});
});
