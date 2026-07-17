/** @format */
import type { TechTransferGroup } from '@bedrock/shared';
import { assessmentsToMatching, type SkillAssessment } from '../research-assessment.js';

const a = (over: Partial<SkillAssessment> & Pick<SkillAssessment, 'skill' | 'verdict'>): SkillAssessment => ({ ...over });

const group = (members: string[], transferBasis: string | null = null): TechTransferGroup => ({
    members,
    transferClass: transferBasis ? 'infra-as-code' : null,
    transferTier: transferBasis ? 'full' : null,
    transferBasis,
});

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

    describe('transferVia downgrade guard', () => {
        const terraformGroup = group(['terraform', 'aws_cdk', 'cloudformation'], 'Declarative infrastructure-as-code');

        it('verdict verified WITH transferVia is downgraded into partialMatches, never verifiedMatches, with matchBasis/transferVia/transferBasis set — and a non-empty transferableFoundation seeded from the sibling + sourceCitation', () => {
            const out = assessmentsToMatching(
                [a({ skill: 'aws_cdk', verdict: 'verified', sourceCitation: 'terraform modules', transferVia: 'terraform' })],
                ['aws_cdk'],
                [terraformGroup],
            );
            expect(out.verifiedMatches).toEqual([]);
            expect(out.partialMatches).toEqual([{
                skill: 'aws_cdk',
                gapDescription: '',
                transferableFoundation: 'Transferable from terraform: terraform modules',
                framingSuggestion: '',
                evidenceFiles: [],
                matchBasis: 'transferable',
                transferVia: 'terraform',
                transferBasis: 'Declarative infrastructure-as-code',
            }]);
            expect(out.partialMatches[0].transferableFoundation.length).toBeGreaterThan(0);
        });

        it('verdict partial WITH transferVia carries matchBasis/transferVia/transferBasis', () => {
            const out = assessmentsToMatching(
                [a({
                    skill: 'cloudformation', verdict: 'partial', transferVia: 'terraform',
                    gapDescription: 'no direct CFN evidence', transferableFoundation: 'IaC fundamentals',
                    framingSuggestion: 'frame as IaC-transferable', evidenceFiles: ['x.tf'],
                })],
                ['cloudformation'],
                [terraformGroup],
            );
            expect(out.partialMatches).toEqual([{
                skill: 'cloudformation',
                gapDescription: 'no direct CFN evidence',
                transferableFoundation: 'IaC fundamentals',
                framingSuggestion: 'frame as IaC-transferable',
                evidenceFiles: ['x.tf'],
                matchBasis: 'transferable',
                transferVia: 'terraform',
                transferBasis: 'Declarative infrastructure-as-code',
            }]);
        });

        it('resolves transferBasis case-insensitively from the group containing BOTH the skill and the via-sibling', () => {
            const out = assessmentsToMatching(
                [a({ skill: 'AWS_CDK', verdict: 'partial', transferVia: 'TERRAFORM' })],
                ['AWS_CDK'],
                [terraformGroup],
            );
            expect(out.partialMatches[0]).toMatchObject({ transferBasis: 'Declarative infrastructure-as-code' });
        });

        it('downgrades with transferBasis undefined when no group contains both the skill and the sibling', () => {
            const out = assessmentsToMatching(
                [a({ skill: 'aws_cdk', verdict: 'verified', transferVia: 'some_unrelated_tool' })],
                ['aws_cdk'],
                [terraformGroup],
            );
            expect(out.verifiedMatches).toEqual([]);
            expect(out.partialMatches).toHaveLength(1);
            expect(out.partialMatches[0]).toMatchObject({ matchBasis: 'transferable', transferVia: 'some_unrelated_tool' });
            expect(out.partialMatches[0].transferBasis).toBeUndefined();
        });

        it('downgrades even when no transferGroups are supplied (default [])', () => {
            const out = assessmentsToMatching([a({ skill: 'aws_cdk', verdict: 'verified', transferVia: 'terraform' })], ['aws_cdk']);
            expect(out.verifiedMatches).toEqual([]);
            expect(out.partialMatches[0]).toMatchObject({ matchBasis: 'transferable', transferVia: 'terraform' });
        });

        it('no transferVia — behaviour is byte-identical to today (no matchBasis/transferVia/transferBasis keys)', () => {
            const out = assessmentsToMatching(
                [a({ skill: 'Python', verdict: 'verified', sourceCitation: 'pipeline', depth: 'expert', recency: '2025', evidenceFiles: ['x.py'] })],
                ['Python'],
                [terraformGroup],
            );
            expect(out.verifiedMatches).toEqual([{ skill: 'Python', sourceCitation: 'pipeline', depth: 'expert', recency: '2025', evidenceFiles: ['x.py'] }]);
            expect('matchBasis' in out.verifiedMatches[0]).toBe(false);
        });
    });
})
