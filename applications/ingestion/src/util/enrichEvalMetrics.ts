/**
 * @format
 * Pure scoring core for the per-file-vs-per-chunk enrichment eval (feature 002,
 * US2 — the binding merge gate). Treats the per-chunk path's skills as the
 * baseline (what we must preserve) and the per-file path's skills as the
 * candidate. Reports macro-averaged recall + precision so a cost change cannot
 * silently drop or smear skills.
 */

/** Skills keyed by `${filePath}::${chunkIndex}`. */
export type SkillsByChunk = ReadonlyMap<string, readonly string[]>;

export interface EnrichEvalResult {
    /** Chunks scored (present in the baseline). */
    readonly chunks: number;
    /** Macro-avg per-chunk recall: kept baseline skills / baseline skills. */
    readonly recall: number;
    /** Macro-avg per-chunk precision: kept baseline skills / candidate skills. */
    readonly precision: number;
    /** Candidate skills absent from the baseline (precision loss = over-tagging). */
    readonly addedSkills: number;
    /** Baseline skills missing from the candidate (recall loss). */
    readonly droppedSkills: number;
}

function overlap(a: ReadonlySet<string>, b: readonly string[]): number {
    let n = 0;
    for (const s of b) if (a.has(s)) n++;
    return n;
}

/**
 * Score candidate (per-file) against baseline (per-chunk). A chunk with no
 * baseline skills contributes recall=1; a chunk whose candidate is empty
 * contributes precision=1 (nothing wrong was added). Macro-average over the
 * baseline's chunks.
 */
export function computeEnrichEvalMetrics(baseline: SkillsByChunk, candidate: SkillsByChunk): EnrichEvalResult {
    let recallSum = 0;
    let precisionSum = 0;
    let added = 0;
    let dropped = 0;

    for (const [key, baseSkills] of baseline) {
        const baseSet = new Set(baseSkills);
        const candSkills = candidate.get(key) ?? [];
        const candSet = new Set(candSkills);

        const kept = overlap(baseSet, candSkills);             // candidate ∩ baseline
        recallSum    += baseSkills.length === 0 ? 1 : kept / baseSkills.length;
        precisionSum += candSkills.length === 0 ? 1 : kept / candSkills.length;

        for (const s of candSkills) if (!baseSet.has(s)) added++;
        for (const s of baseSkills) if (!candSet.has(s)) dropped++;
    }

    const n = baseline.size || 1;
    return {
        chunks:       baseline.size,
        recall:       recallSum / n,
        precision:    precisionSum / n,
        addedSkills:  added,
        droppedSkills: dropped,
    };
}
