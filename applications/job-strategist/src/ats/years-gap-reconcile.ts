/**
 * @format
 * Years-gap enforcement — deterministic.
 *
 * `buildYearsGap` computes, stably, whether the candidate clears a JD's hard
 * experience bar (relevantYears vs requiredYears → `disqualifying`). But that
 * signal was only PASSED to the strategist as a separate input — it never
 * constrained the research agent's own `overallFitRating` / `gaps`. So Haiku
 * was free to ignore it: in one run it rated "STRONG FIT" with 0 gaps and
 * "exceeds all hard requirements" while carrying `disqualifying: true`; a
 * re-run of the SAME JD correctly rated "REACH" with the gap surfaced. That
 * non-enforcement is what made the fit verdict (and the downstream résumé
 * structure) swing between runs.
 *
 * This closes it: when the years bar is disqualifying, force a single hard
 * gap entry for it AND cap the fit rating so it can never read as STRONG /
 * REASONABLE fit. Pure + idempotent; a no-op when there's no disqualifying
 * years gap.
 */
import type { SkillGap, FitRating } from '@bedrock/shared';

/** The subset of YearsGap this guard reads (kept structural to avoid an agent import cycle). */
export interface YearsGapSignal {
    readonly relevantYears: number;
    readonly requiredYears: number | null;
    readonly gapYears: number;
    readonly disqualifying: boolean;
}

export interface YearsGapReconcileOutcome<M> {
    readonly matching: M;
    /** True when a disqualifying years gap was enforced (gap inserted + rating capped). */
    readonly applied: boolean;
}

/** Match an existing experience-years gap so re-runs replace rather than duplicate it. */
function isYearsGap(g: SkillGap): boolean {
    return g.gapType === 'hard' && /\byears?\b/i.test(g.skill);
}

/**
 * A disqualifying hard-bar miss cannot honestly read as STRONG / REASONABLE
 * fit. Cap at REACH (the rating the internally-consistent run produced); a
 * rating already at STRETCH / REACH is left as the agent judged it.
 */
function capFitRating(current: FitRating): FitRating {
    return current === 'STRONG FIT' || current === 'REASONABLE FIT' ? 'REACH' : current;
}

export function applyYearsGapReconcile<M extends { gaps: SkillGap[]; overallFitRating: FitRating }>(
    matching: M,
    yearsGap: YearsGapSignal | null | undefined,
): YearsGapReconcileOutcome<M> {
    if (!yearsGap || !yearsGap.disqualifying || yearsGap.requiredYears === null) {
        return { matching, applied: false };
    }
    const skill = `${yearsGap.requiredYears}+ years of relevant experience`;
    const gap: SkillGap = {
        skill,
        gapType: 'hard',
        impactSeverity: 'significant',
        disqualifyingAssessment:
            `Candidate has ~${yearsGap.relevantYears} relevant years against a hard ` +
            `${yearsGap.requiredYears}+ year requirement (gap ~${yearsGap.gapYears}). The JD marks this bar ` +
            `as disqualifying — lead with demonstrated capability (project scope, ownership, depth) to offset it; ` +
            `do not present the candidate as meeting the stated experience minimum.`,
    };
    const gaps = matching.gaps.filter((g) => !isYearsGap(g));
    gaps.push(gap);
    return {
        matching: { ...matching, gaps, overallFitRating: capFitRating(matching.overallFitRating) },
        applied: true,
    };
}
