/** @format */
import { collectJdMustHaves, buildGroundedChecker } from '../jd-keywords.js';
import type { StrategistResearchResult } from '@bedrock/shared';

const ti = (tools: string[]): Parameters<typeof collectJdMustHaves>[0] =>
	({ technologyInventory: { tools, languages: [], methodologies: [], frameworks: [], infrastructure: [] } }) as never;

describe('collectJdMustHaves — cap transparency', () => {
	it('reports dropped terms when the JD inventory exceeds the cap', () => {
		const tools = Array.from({ length: 22 }, (_, i) => `tool-${i}`);
		let dropped: string[] = [];
		const out = collectJdMustHaves(ti(tools), (d) => { dropped = d; });
		expect(out).toHaveLength(18);
		expect(dropped).toEqual(['tool-18', 'tool-19', 'tool-20', 'tool-21']);
	});

	it('does not invoke the callback under the cap', () => {
		let called = false;
		collectJdMustHaves(ti(['docker']), () => { called = true; });
		expect(called).toBe(false);
	});
});

describe('buildGroundedChecker — transfer-aware grounding', () => {
	const research = {
		verifiedMatches: [{ skill: 'Docker' }],
		partialMatches:  [{ skill: 'GitHub Actions' }],
	} as unknown as StrategistResearchResult;
	const techGroups = [['docker', 'podman'], ['github_actions', 'gitlab_ci']];
	const aliasMap = new Map([['docker', 'docker'], ['podman', 'podman'], ['github actions', 'github_actions'], ['gitlab ci', 'gitlab_ci']]);

	it('grounds direct evidence as before', () => {
		const grounded = buildGroundedChecker(research, techGroups, aliasMap);
		expect(grounded('Docker')).toBe(true);
	});

	it('grounds a term whose transfer family contains evidenced skills', () => {
		const grounded = buildGroundedChecker(research, techGroups, aliasMap);
		expect(grounded('Podman')).toBe(true);
		expect(grounded('GitLab CI')).toBe(true);
	});

	it('never grounds a term with no evidence in reach', () => {
		const grounded = buildGroundedChecker(research, techGroups, aliasMap);
		expect(grounded('PyTorch')).toBe(false);
	});
});
