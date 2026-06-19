/** @format */

/**
 * Pure near-duplicate detection over canonical skill embeddings (FR-006).
 *
 * Two distinct canonicals whose embeddings are very close are almost certainly
 * the same skill phrased two ways ("cross-functional partnership" vs
 * "collaboration"). This proposes merge/review actions; the caller (the skill
 * importer) applies them against the DB. No DB, no IO — trivially testable and
 * re-runnable on every import.
 *
 * Threshold policy (research D4): cosine >= autoMergeThreshold => auto-merge
 * (well above the 0.62 resolve threshold, so only true duplicates merge);
 * [reviewFloor, autoMergeThreshold) => human review queue; below => leave alone.
 */

export interface DedupCandidate {
    readonly id: string;
    readonly canonical: string;
    readonly embedding: readonly number[];
    /** 'curated' | 'auto_imported' | 'candidate' — curated is preferred as the keep. */
    readonly curationLevel: string;
}

export interface DedupAction {
    readonly kind: 'merge' | 'review';
    readonly keepId: string;
    readonly dropId: string;
    readonly similarity: number;
}

export interface DedupOptions {
    readonly autoMergeThreshold: number;
    readonly reviewFloor: number;
}

/** Cosine similarity; 0 when either vector is empty or zero-magnitude. */
function cosine(a: readonly number[], b: readonly number[]): number {
    if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Choose which canonical survives a merge: curated wins; else the earlier one. */
function pickKeep(a: DedupCandidate, b: DedupCandidate): { keep: DedupCandidate; drop: DedupCandidate } {
    const aCurated = a.curationLevel === 'curated';
    const bCurated = b.curationLevel === 'curated';
    if (aCurated && !bCurated) return { keep: a, drop: b };
    if (bCurated && !aCurated) return { keep: b, drop: a };
    return { keep: a, drop: b }; // stable: first in input order
}

/**
 * Returns at most one action per duplicate pair, scanning unique pairs in input
 * order. Entries without an embedding are skipped (cannot be compared).
 */
export function dedupeSkillCanonicals(
    candidates: readonly DedupCandidate[],
    opts: DedupOptions,
): DedupAction[] {
    const usable = candidates.filter((c) => c.embedding.length > 0);
    const actions: DedupAction[] = [];
    const merged = new Set<string>();

    for (let i = 0; i < usable.length; i++) {
        if (merged.has(usable[i].id)) continue;
        for (let j = i + 1; j < usable.length; j++) {
            if (merged.has(usable[j].id)) continue;
            const sim = cosine(usable[i].embedding, usable[j].embedding);
            if (sim >= opts.autoMergeThreshold) {
                const { keep, drop } = pickKeep(usable[i], usable[j]);
                actions.push({ kind: 'merge', keepId: keep.id, dropId: drop.id, similarity: sim });
                merged.add(drop.id);
            } else if (sim >= opts.reviewFloor) {
                const { keep, drop } = pickKeep(usable[i], usable[j]);
                actions.push({ kind: 'review', keepId: keep.id, dropId: drop.id, similarity: sim });
            }
        }
    }
    return actions;
}
