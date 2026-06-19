/**
 * @format
 * Semantic skill-overlap scoring for the enrichment evals (the fix for the
 * exact-string metric that scored surface-form variance as a miss). Two skills
 * "match" when their embeddings are within a cosine threshold — so "iac with
 * cdk" ≈ "infrastructure as code with cdk" counts, where exact-string scored 0.
 *
 * The corpus is ~2.2% canonical (16,482 raw phrasings / 209 canonicals), so
 * exact overlap measured phrasing noise, not skill agreement. This measures
 * agreement. The `sim` function (cosine over injected embeddings) is passed in,
 * so the metric is pure + unit-testable without a model.
 */

/** Skills keyed by chunk id. */
export type SkillsByChunk = ReadonlyMap<string, readonly string[]>;

/** Cosine similarity between two skill phrases (0..1). Injected (embeddings live in the caller). */
export type SkillSim = (a: string, b: string) => number;

export interface SemanticEvalResult {
    readonly chunks: number;
    /** Macro-avg per-chunk recall: baseline skills with a semantic match in candidate. */
    readonly recall: number;
    /** Macro-avg per-chunk precision: candidate skills with a semantic match in baseline. */
    readonly precision: number;
    /** Cosine threshold used. */
    readonly threshold: number;
}

/** Does `needle` have a match (sim ≥ threshold) anywhere in `hay`? Exact string is sim=1. */
function hasMatch(needle: string, hay: readonly string[], sim: SkillSim, threshold: number): boolean {
    for (const h of hay) {
        if (h === needle) return true;
        if (sim(needle, h) >= threshold) return true;
    }
    return false;
}

/**
 * Macro-averaged semantic recall + precision of `candidate` vs `baseline`.
 * A chunk with no baseline skills contributes recall=1; an empty candidate
 * contributes precision=1 (nothing wrong added). Symmetric to the exact-string
 * scorer it replaces, but matching is semantic.
 */
export function computeSemanticEvalMetrics(
    baseline: SkillsByChunk,
    candidate: SkillsByChunk,
    sim: SkillSim,
    threshold: number,
): SemanticEvalResult {
    let recallSum = 0;
    let precisionSum = 0;

    for (const [key, baseSkills] of baseline) {
        const cand = candidate.get(key) ?? [];
        const baseMatched = baseSkills.filter((s) => hasMatch(s, cand, sim, threshold)).length;
        const candMatched = cand.filter((s) => hasMatch(s, baseSkills, sim, threshold)).length;
        recallSum    += baseSkills.length === 0 ? 1 : baseMatched / baseSkills.length;
        precisionSum += cand.length === 0 ? 1 : candMatched / cand.length;
    }

    const n = baseline.size || 1;
    return { chunks: baseline.size, recall: recallSum / n, precision: precisionSum / n, threshold };
}
