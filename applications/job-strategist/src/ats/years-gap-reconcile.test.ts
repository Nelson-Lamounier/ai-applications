/** @format */
import { applyYearsGapReconcile, type YearsGapSignal } from './years-gap-reconcile.js';
import type { SkillGap, FitRating } from '@bedrock/shared';

const base = (over: Partial<{ gaps: SkillGap[]; overallFitRating: FitRating }> = {}) => ({
    verifiedMatches: [],
    partialMatches: [],
    gaps: [] as SkillGap[],
    overallFitRating: 'STRONG FIT' as FitRating,
    ...over,
});

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

    it('leaves an already-honest rating (STRETCH / REACH) unchanged', () => {
        expect(applyYearsGapReconcile(base({ overallFitRating: 'STRETCH' }), disqualifying).matching.overallFitRating).toBe('STRETCH');
        expect(applyYearsGapReconcile(base({ overallFitRating: 'REACH' }), disqualifying).matching.overallFitRating).toBe('REACH');
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
