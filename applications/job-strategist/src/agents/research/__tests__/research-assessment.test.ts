/** @format */
import { assessmentsToMatching, type SkillAssessment } from '../research-assessment.js';

const a = (over: Partial<SkillAssessment> & Pick<SkillAssessment, 'skill' | 'verdict'>): SkillAssessment => ({ ...over });

describe('assessmentsToMatching', () => {
    it('routes each verdict into the matching bucket with fields preserved', () => {
        const out = assessmentsToMatching([
            a({ skill: 'Python', verdict: 'verified', sourceCitation: 'pipeline', depth: 'expert', recency: '2025', evidenceFiles: ['x.py'] }),
            a({ skill: 'GraphQL', verdict: 'partial', gapDescription: 'REST only', transferableFoundation: 'API design', framingSuggestion: 'frame it', evidenceFiles: ['r.ts'] }),
            a({ skill: 'Rust', verdict: 'gap', gapType: 'hard', impactSeverity: 'significant', disqualifyingAssessment: 'no Rust' }),
        ], ['Python', 'GraphQL', 'Rust']);

        expect(out.verifiedMatches).toEqual([{ skill: 'Python', sourceCitation: 'pipeline', depth: 'expert', recency: '2025', evidenceFiles: ['x.py'] }]);
        expect(out.partialMatches).toEqual([{ skill: 'GraphQL', gapDescription: 'REST only', transferableFoundation: 'API design', framingSuggestion: 'frame it', evidenceFiles: ['r.ts'] }]);
        expect(out.gaps).toEqual([{ skill: 'Rust', gapType: 'hard', impactSeverity: 'significant', disqualifyingAssessment: 'no Rust' }]);
    });

    it('fills sane defaults for sparse verified/partial/gap entries', () => {
        const out = assessmentsToMatching([
            a({ skill: 'A', verdict: 'verified' }),
            a({ skill: 'B', verdict: 'partial' }),
            a({ skill: 'C', verdict: 'gap' }),
        ]);
        expect(out.verifiedMatches[0]).toMatchObject({ depth: 'working', recency: '', sourceCitation: '', evidenceFiles: [] });
        expect(out.partialMatches[0]).toMatchObject({ gapDescription: '', transferableFoundation: '', framingSuggestion: '', evidenceFiles: [] });
        expect(out.gaps[0]).toMatchObject({ gapType: 'soft', impactSeverity: 'minor', disqualifyingAssessment: '' });
    });

    it('covers every canonical skill — an unassessed JD skill becomes a soft gap', () => {
        const out = assessmentsToMatching(
            [a({ skill: 'Python', verdict: 'verified', sourceCitation: 'p' })],
            ['Python', 'Kubernetes', 'Terraform'],
        );
        expect(out.verifiedMatches.map((v) => v.skill)).toEqual(['Python']);
        expect(out.gaps.map((g) => g.skill).sort()).toEqual(['Kubernetes', 'Terraform']);
        expect(out.gaps.every((g) => g.gapType === 'soft' && /not assessed/i.test(g.disqualifyingAssessment))).toBe(true);
    });

    it('total buckets cover the full canonical list exactly once', () => {
        const jdSkills = ['Python', 'GraphQL', 'Rust', 'AWS'];
        const out = assessmentsToMatching([
            a({ skill: 'Python', verdict: 'verified' }),
            a({ skill: 'GraphQL', verdict: 'partial' }),
            a({ skill: 'Rust', verdict: 'gap' }),
        ], jdSkills);
        const all = [...out.verifiedMatches, ...out.partialMatches, ...out.gaps].map((e) => e.skill).sort();
        expect(all).toEqual([...jdSkills].sort());
    });

    it('an unrecognised verdict is treated as an honest gap', () => {
        const out = assessmentsToMatching([a({ skill: 'X', verdict: 'maybe' as never })]);
        expect(out.gaps.map((g) => g.skill)).toEqual(['X']);
    });

    it('skips blank skills and ignores empty input', () => {
        expect(assessmentsToMatching([])).toEqual({ verifiedMatches: [], partialMatches: [], gaps: [] });
        const out = assessmentsToMatching([a({ skill: '  ', verdict: 'verified' })], []);
        expect(out).toEqual({ verifiedMatches: [], partialMatches: [], gaps: [] });
    });
})
