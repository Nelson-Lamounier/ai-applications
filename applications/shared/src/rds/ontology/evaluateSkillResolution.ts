/** @format */

/**
 * Skill-resolution eval (CLAUDE.md rule 5 — per-phase eval before scaling).
 *
 * Scores how well the embedding nearest-canonical resolver (PhraseSkillResolver
 * + SkillEmbeddingResolver) maps free-text skill phrases to canonicals, given a
 * labelled set. The labels come for free from the alias table: each
 * alias -> canonical pair is a known POSITIVE (should resolve to that
 * canonical); phrases deliberately far from every canonical are NEGATIVES
 * (should stay raw). Running this across similarity thresholds produces the
 * precision/recall curve that sets the production threshold — pure + offline so
 * it is trivially unit-tested and re-run on every ontology/threshold change.
 */

/** One labelled phrase + what the resolver actually returned at a threshold. */
export interface ResolutionOutcome {
    readonly phrase: string;
    /** The correct canonical, or null when the phrase should NOT match any. */
    readonly expected: string | null;
    /** What the resolver returned (canonical or null). */
    readonly resolved: string | null;
}

export interface ResolutionScore {
    /** Count of should-match cases (expected != null). */
    readonly positives: number;
    /** Count of should-NOT-match cases (expected == null). */
    readonly negatives: number;
    /** Of positives, fraction resolved to the EXACT expected canonical. */
    readonly recall: number;
    /** Of all non-null resolutions, fraction that match their expected canonical. */
    readonly precision: number;
    /** Of negatives, fraction wrongly resolved to some canonical (false merges). */
    readonly falseMergeRate: number;
}

/**
 * Pure scoring of resolution outcomes. No division-by-zero: an empty cohort
 * scores 0 for its rate rather than NaN, so threshold sweeps over sparse data
 * stay comparable.
 */
export function scoreSkillResolution(outcomes: readonly ResolutionOutcome[]): ResolutionScore {
    const positives = outcomes.filter((x) => x.expected !== null);
    const negatives = outcomes.filter((x) => x.expected === null);
    const resolvedNonNull = outcomes.filter((x) => x.resolved !== null);

    const recallHits    = positives.filter((x) => x.resolved === x.expected).length;
    const precisionHits = resolvedNonNull.filter((x) => x.resolved === x.expected).length;
    const falseMerges   = negatives.filter((x) => x.resolved !== null).length;

    return {
        positives: positives.length,
        negatives: negatives.length,
        recall:         positives.length      > 0 ? recallHits / positives.length      : 0,
        precision:      resolvedNonNull.length > 0 ? precisionHits / resolvedNonNull.length : 0,
        falseMergeRate: negatives.length       > 0 ? falseMerges / negatives.length     : 0,
    };
}
