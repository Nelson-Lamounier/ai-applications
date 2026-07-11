/**
 * @format
 * Research assessment → matching adapter (centralisation increment 2).
 *
 * The matcher no longer invents three free skill lists; it emits ONE verdict per
 * canonical JD skill (`SkillAssessment`). This adapter routes those verdicts back
 * into the legacy `verifiedMatches / partialMatches / gaps` shape so every
 * downstream consumer (the years/vendor/code guards, the skill-evidence ledger,
 * the strategist) is unchanged.
 *
 * Coverage guarantee: every canonical JD skill ends up in exactly one bucket.
 * A skill the model failed to assess defaults to a (soft) gap — honest: we never
 * claim evidence the matcher did not assert. Pure + deterministic + unit-tested.
 */
import type { VerifiedMatch, PartialMatch, SkillGap, SkillDepth, GapType, GapSeverity } from '@bedrock/shared';

export type Verdict = 'verified' | 'partial' | 'gap';

/** One per-skill verdict emitted by the matcher (model output). */
export interface SkillAssessment {
    readonly skill: string;
    readonly verdict: Verdict;
    // verified
    readonly sourceCitation?: string;
    readonly depth?: SkillDepth;
    readonly recency?: string;
    readonly evidenceFiles?: string[];
    // partial
    readonly gapDescription?: string;
    readonly transferableFoundation?: string;
    readonly framingSuggestion?: string;
    // gap
    readonly gapType?: GapType;
    readonly impactSeverity?: GapSeverity;
    readonly disqualifyingAssessment?: string;
}

export interface DerivedMatching {
    readonly verifiedMatches: VerifiedMatch[];
    readonly partialMatches: PartialMatch[];
    readonly gaps: SkillGap[];
}

const VALID_DEPTH: ReadonlySet<string> = new Set(['surface', 'working', 'expert']);
const VALID_SEVERITY: ReadonlySet<string> = new Set(['blocking', 'significant', 'minor']);

function toVerified(a: SkillAssessment): VerifiedMatch {
    return {
        skill: a.skill,
        sourceCitation: a.sourceCitation ?? '',
        depth: (a.depth && VALID_DEPTH.has(a.depth) ? a.depth : 'working') as SkillDepth,
        recency: a.recency ?? '',
        evidenceFiles: a.evidenceFiles ?? [],
    };
}

function toPartial(a: SkillAssessment): PartialMatch {
    return {
        skill: a.skill,
        gapDescription: a.gapDescription ?? '',
        transferableFoundation: a.transferableFoundation ?? '',
        framingSuggestion: a.framingSuggestion ?? '',
        evidenceFiles: a.evidenceFiles ?? [],
    };
}

function toGap(a: SkillAssessment): SkillGap {
    return {
        skill: a.skill,
        gapType: (a.gapType === 'hard' ? 'hard' : 'soft') as GapType,
        impactSeverity: (a.impactSeverity && VALID_SEVERITY.has(a.impactSeverity) ? a.impactSeverity : 'minor') as GapSeverity,
        disqualifyingAssessment: a.disqualifyingAssessment ?? '',
    };
}

/**
 * Convert per-skill assessments into the legacy three-bucket matching shape.
 *
 * @param assessments - The matcher's per-skill verdicts.
 * @param jdSkills    - The canonical JD skill list. Any skill with no assessment
 *                      (or an unrecognised verdict) becomes a soft gap so the
 *                      output covers the full list and never over-claims.
 */
export function assessmentsToMatching(
    assessments: readonly SkillAssessment[],
    jdSkills: readonly string[] = [],
): DerivedMatching {
    const verifiedMatches: VerifiedMatch[] = [];
    const partialMatches: PartialMatch[] = [];
    const gaps: SkillGap[] = [];
    const assessed = new Set<string>();

    for (const a of assessments) {
        if (!a.skill || a.skill.trim().length === 0) continue;
        assessed.add(a.skill.toLowerCase());
        if (a.verdict === 'verified') verifiedMatches.push(toVerified(a));
        else if (a.verdict === 'partial') partialMatches.push(toPartial(a));
        else gaps.push(toGap(a)); // 'gap' or any unrecognised verdict → honest gap
    }

    // Coverage: a canonical skill the matcher didn't assess defaults to a soft gap.
    for (const skill of jdSkills) {
        if (!skill || assessed.has(skill.toLowerCase())) continue;
        assessed.add(skill.toLowerCase());
        gaps.push({
            skill,
            gapType: 'soft',
            impactSeverity: 'minor',
            disqualifyingAssessment: 'Not assessed by the matcher — treated as an honest gap pending evidence.',
        });
    }

    return { verifiedMatches, partialMatches, gaps };
}
