/** @format */
import { dedupeSkillGaps } from '../dedupe-skill-gaps.js';
import type { SkillGap } from '@bedrock/shared';

const gap = (skill: string, over: Partial<SkillGap> = {}): SkillGap =>
	({ skill, gapType: 'hard', impactSeverity: 'significant', disqualifyingAssessment: 'no', ...over }) as SkillGap;

describe('dedupeSkillGaps — one gap per real-world skill', () => {
	it('drops a compound gap when every part is already listed (live Meta run: PHP/Hack + PHP + Hack)', () => {
		const out = dedupeSkillGaps(
			[gap('PHP/Hack'), gap('PyTorch'), gap('PHP'), gap('Hack')],
			new Map(),
		);
		expect(out.map((g) => g.skill)).toEqual(['PyTorch', 'PHP', 'Hack']);
	});

	it('merges alias duplicates onto the canonical, keeping the most severe verdict', () => {
		const aliases = new Map([['github actions', 'github_actions'], ['gha', 'github_actions']]);
		const out = dedupeSkillGaps(
			[gap('GitHub Actions', { impactSeverity: 'minor' }), gap('GHA', { impactSeverity: 'blocking', disqualifyingAssessment: 'yes - blocking' })],
			aliases,
		);
		expect(out).toHaveLength(1);
		expect(out[0].impactSeverity).toBe('blocking');
		expect(out[0].disqualifyingAssessment).toBe('yes - blocking');
	});

	it('keeps a compound when its parts are not separately listed', () => {
		const out = dedupeSkillGaps([gap('CI/CD'), gap('PyTorch')], new Map());
		expect(out.map((g) => g.skill)).toEqual(['CI/CD', 'PyTorch']);
	});

	it('reports removals via the callback', () => {
		let report: { removed: number } | null = null;
		dedupeSkillGaps([gap('PHP/Hack'), gap('PHP'), gap('Hack')], new Map(), (d) => { report = d; });
		expect(report).toEqual({ removed: 1 });
	});
});
