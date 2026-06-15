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
 * This closes it: when the years bar is disqualifying, (1) DEMOTE any verified/
 * partial match that claims a years-of-experience requirement (else the Skill
 * Evidence Ledger shows "8+ years — VERIFIED" citing ~2 years, contradicting the
 * gap), (2) force a single hard gap entry for it, and (3) cap the fit rating to
 * REACH (a disqualifying hard-bar miss cannot read better than REACH). Pure +
 * idempotent; a no-op when there's no disqualifying years gap.
 */
import type { SkillGap, FitRating, VerifiedMatch, PartialMatch } from '@bedrock/shared';

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
 * A skill phrase that claims a years-of-experience requirement, e.g.
 * "8+ years user operations", "5 years of relevant experience". Used to demote
 * any verified/partial match the matcher created for the years bar — the
 * candidate misses it, so it cannot stand as verified next to the hard gap.
 * Requires a NUMBER adjacent to "year(s)" so plain skills ("Python") never match.
 */
function claimsYearsRequirement(skill: string): boolean {
    return /\b\d{1,2}\s*\+?\s*years?\b/i.test(skill);
}

export function applyYearsGapReconcile<
    M extends {
        gaps: SkillGap[];
        overallFitRating: FitRating;
        verifiedMatches: VerifiedMatch[];
        partialMatches: PartialMatch[];
    },
>(
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
    return {
        matching: {
            ...matching,
            // Demote any years-experience claim the matcher verified/partial'd — the
            // candidate misses the bar, so it must not show as met (ledger contradiction).
            verifiedMatches: matching.verifiedMatches.filter((v) => !claimsYearsRequirement(v.skill)),
            partialMatches:  matching.partialMatches.filter((p) => !claimsYearsRequirement(p.skill)),
            // Replace any prior years gap with the deterministic one.
            gaps: [...matching.gaps.filter((g) => !isYearsGap(g)), gap],
            // A disqualifying hard-bar miss cannot read better than REACH.
            overallFitRating: 'REACH',
        },
        applied: true,
    };
}
