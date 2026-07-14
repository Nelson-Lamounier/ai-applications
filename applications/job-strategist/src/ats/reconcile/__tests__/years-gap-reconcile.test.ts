/** @format */
import { applyYearsGapReconcile, type YearsGapSignal } from '../years-gap-reconcile.js';
import type { SkillGap, FitRating, VerifiedMatch, PartialMatch } from '@bedrock/shared';

interface M { verifiedMatches: VerifiedMatch[]; partialMatches: PartialMatch[]; gaps: SkillGap[]; overallFitRating: FitRating }
const base = (over: Partial<M> = {}): M => ({
    verifiedMatches: [],
    partialMatches: [],
    gaps: [],
    overallFitRating: 'STRONG FIT',
    ...over,
});
const vm = (skill: string): VerifiedMatch => ({ skill, sourceCitation: 'x', depth: 'working', recency: '2025', evidenceFiles: [] } as VerifiedMatch);

const disqualifying: YearsGapSignal = { relevantYears: 5, requiredYears: 8, gapYears: 3, disqualifying: true };

describe('applyYearsGapReconcile', () => {
    it('forces a hard gap and caps STRONG FIT → REACH when the years bar is disqualifying', () => {
        const { matching, applied } = applyYearsGapReconcile(base(), disqualifying);
        expect(applied).toBe(true);
        expect(matching.overallFitRating).toBe('REACH');
        expect(matching.gaps).toHaveLength(1);
        expect(matching.gaps[0]).toMatchObject({ gapType: 'hard', impactSeverity: 'significant' });
        expect(matching.gaps[0].skill).toMatch(/8\+ years/);
        expect(matching.gaps[0].disqualifyingAssessment).toMatch(/~5 relevant years/);
    });

    it('also caps REASONABLE FIT → REACH', () => {
        const { matching } = applyYearsGapReconcile(base({ overallFitRating: 'REASONABLE FIT' }), disqualifying);
        expect(matching.overallFitRating).toBe('REACH');
    });

    it('caps EVERY rating above REACH down to REACH (STRETCH no longer slips through)', () => {
        expect(applyYearsGapReconcile(base({ overallFitRating: 'STRETCH' }), disqualifying).matching.overallFitRating).toBe('REACH');
        expect(applyYearsGapReconcile(base({ overallFitRating: 'REACH' }), disqualifying).matching.overallFitRating).toBe('REACH');
    });

    it('demotes a verified/partial match that claims the years requirement (ledger contradiction)', () => {
        const m = base({
            verifiedMatches: [vm('8+ years user operations or support engineering experience'), vm('Python')],
            partialMatches: [{ skill: '5 years of relevant experience', gapDescription: 'g', transferableFoundation: 'f', framingSuggestion: 's', evidenceFiles: [] } as PartialMatch],
        });
        const { matching } = applyYearsGapReconcile(m, disqualifying);
        // The years claims are gone from verified/partial; the real skill (Python) stays.
        expect(matching.verifiedMatches.map((v) => v.skill)).toEqual(['Python']);
        expect(matching.partialMatches).toHaveLength(0);
        // …and the hard years gap is present instead.
        expect(matching.gaps.some((g) => /8\+ years/.test(g.skill) && g.gapType === 'hard')).toBe(true);
    });

    it('is idempotent — replaces a prior years gap rather than duplicating it', () => {
        const prior = base({
            gaps: [{ skill: '8+ years experience', gapType: 'hard', impactSeverity: 'minor', disqualifyingAssessment: 'old' }],
        });
        const { matching } = applyYearsGapReconcile(prior, disqualifying);
        const yearsGaps = matching.gaps.filter((g) => /years?/i.test(g.skill));
        expect(yearsGaps).toHaveLength(1);
        expect(yearsGaps[0].impactSeverity).toBe('significant'); // the fresh deterministic one
    });

    it('preserves non-years gaps', () => {
        const prior = base({
            gaps: [{ skill: 'Kubernetes', gapType: 'soft', impactSeverity: 'minor', disqualifyingAssessment: 'x' }],
        });
        const { matching } = applyYearsGapReconcile(prior, disqualifying);
        expect(matching.gaps.some((g) => g.skill === 'Kubernetes')).toBe(true);
        expect(matching.gaps.some((g) => /8\+ years/.test(g.skill))).toBe(true);
    });

    it('is a no-op when the years gap is not disqualifying', () => {
        const m = base();
        const { matching, applied } = applyYearsGapReconcile(m, { relevantYears: 9, requiredYears: 8, gapYears: 0, disqualifying: false });
        expect(applied).toBe(false);
        expect(matching.overallFitRating).toBe('STRONG FIT');
        expect(matching.gaps).toHaveLength(0);
    });

    it('is a no-op when there is no years gap / no required years', () => {
        expect(applyYearsGapReconcile(base(), null).applied).toBe(false);
        expect(applyYearsGapReconcile(base(), { relevantYears: 5, requiredYears: null, gapYears: 0, disqualifying: true }).applied).toBe(false);
    });
});
