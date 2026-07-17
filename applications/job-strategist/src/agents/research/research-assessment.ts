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
import type { VerifiedMatch, PartialMatch, SkillGap, SkillDepth, GapType, GapSeverity, TechTransferGroup } from '@bedrock/shared';

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
    /**
     * The evidenced sibling technology this verdict leans on, ONLY when the
     * candidate's evidence is for a transferable sibling, not the skill itself.
     * When set, `assessmentsToMatching` never buckets the skill into
     * `verifiedMatches` — it is downgraded to a transferable `PartialMatch`.
     */
    readonly transferVia?: string;
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

/**
 * Resolve the transfer-basis text for a skill<->sibling pair from the first
 * group whose membership contains BOTH (case-insensitive). Returns undefined
 * when no such group exists or the group carries no typed basis.
 */
function findTransferBasis(
    skill: string,
    transferVia: string,
    transferGroups: readonly TechTransferGroup[],
): string | undefined {
    const skillLower = skill.toLowerCase();
    const viaLower = transferVia.toLowerCase();
    for (const g of transferGroups) {
        const membersLower = new Set(g.members.map((m) => m.toLowerCase()));
        if (membersLower.has(skillLower) && membersLower.has(viaLower)) {
            return g.transferBasis ?? undefined;
        }
    }
    return undefined;
}

/**
 * Build a transferable PartialMatch — used to downgrade a 'verified' verdict
 * that carries transferVia, and to enrich a 'partial' verdict that carries it.
 */
function toTransferablePartial(a: SkillAssessment, transferGroups: readonly TechTransferGroup[]): PartialMatch {
    const transferVia = a.transferVia as string; // caller guarantees truthy
    const transferBasis = findTransferBasis(a.skill, transferVia, transferGroups);
    return {
        ...toPartial(a),
        matchBasis: 'transferable',
        transferVia,
        ...(transferBasis ? { transferBasis } : {}),
    };
}

/** A canonical JD skill the matcher never assessed — an honest, unclaimed soft gap. */
function toUnassessedGap(skill: string): SkillGap {
    return {
        skill,
        gapType: 'soft',
        impactSeverity: 'minor',
        disqualifyingAssessment: 'Not assessed by the matcher — treated as an honest gap pending evidence.',
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

type BucketedAssessment =
    | { readonly bucket: 'verified'; readonly value: VerifiedMatch }
    | { readonly bucket: 'partial'; readonly value: PartialMatch }
    | { readonly bucket: 'gap'; readonly value: SkillGap };

/**
 * Decide which of the three legacy buckets a single assessment belongs in.
 * Isolated from the aggregation loop so the transferVia downgrade guard's
 * branching stays out of `assessmentsToMatching`'s cyclomatic complexity.
 *
 * Any assessment carrying transferVia NEVER lands in 'verified' — it is
 * downgraded (verdict verified) or enriched (verdict partial) into a
 * transferable PartialMatch. No transferVia -> behaviour identical to today.
 */
function classifyAssessment(a: SkillAssessment, transferGroups: readonly TechTransferGroup[]): BucketedAssessment {
    if (a.transferVia && (a.verdict === 'verified' || a.verdict === 'partial')) {
        return { bucket: 'partial', value: toTransferablePartial(a, transferGroups) };
    }
    if (a.verdict === 'verified') return { bucket: 'verified', value: toVerified(a) };
    if (a.verdict === 'partial') return { bucket: 'partial', value: toPartial(a) };
    return { bucket: 'gap', value: toGap(a) }; // 'gap' or any unrecognised verdict -> honest gap
}

/** Bucket every assessed skill into verified/partial/gap, tracking what was covered. */
function bucketAssessments(
    assessments: readonly SkillAssessment[],
    transferGroups: readonly TechTransferGroup[],
): DerivedMatching & { assessed: Set<string> } {
    const verifiedMatches: VerifiedMatch[] = [];
    const partialMatches: PartialMatch[] = [];
    const gaps: SkillGap[] = [];
    const assessed = new Set<string>();

    for (const a of assessments) {
        if (!a.skill || a.skill.trim().length === 0) continue;
        assessed.add(a.skill.toLowerCase());
        const classified = classifyAssessment(a, transferGroups);
        if (classified.bucket === 'verified') verifiedMatches.push(classified.value);
        else if (classified.bucket === 'partial') partialMatches.push(classified.value);
        else gaps.push(classified.value);
    }

    return { verifiedMatches, partialMatches, gaps, assessed };
}

/** Coverage guarantee: a canonical JD skill the matcher didn't assess defaults to a soft gap. */
function addUnassessedGaps(jdSkills: readonly string[], assessed: Set<string>, gaps: SkillGap[]): void {
    for (const skill of jdSkills) {
        if (!skill || assessed.has(skill.toLowerCase())) continue;
        assessed.add(skill.toLowerCase());
        gaps.push(toUnassessedGap(skill));
    }
}

/**
 * Convert per-skill assessments into the legacy three-bucket matching shape.
 *
 * @param assessments    - The matcher's per-skill verdicts.
 * @param jdSkills       - The canonical JD skill list. Any skill with no assessment
 *                         (or an unrecognised verdict) becomes a soft gap so the
 *                         output covers the full list and never over-claims.
 * @param transferGroups - Tech-transfer groups used to resolve `transferBasis`
 *                         for any assessment carrying `transferVia`. Optional —
 *                         defaults to `[]` (no basis resolved, guard still applies).
 */
export function assessmentsToMatching(
    assessments: readonly SkillAssessment[],
    jdSkills: readonly string[] = [],
    transferGroups: readonly TechTransferGroup[] = [],
): DerivedMatching {
    const { verifiedMatches, partialMatches, gaps, assessed } = bucketAssessments(assessments, transferGroups);
    addUnassessedGaps(jdSkills, assessed, gaps);
    return { verifiedMatches, partialMatches, gaps };
}
