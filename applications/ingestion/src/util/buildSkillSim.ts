/**
 * @format
 * Build a semantic similarity function over skill phrases for the eval (the
 * embedding side of the metric fix). Embeds every distinct skill ONCE via Titan
 * (memoised) and returns cosine(a, b) — so two phrasings of the same capability
 * score ~1 where exact-string scored 0.
 */
import type { SkillSim, SkillsByChunk } from './semanticEvalMetrics.js';

interface Embedder { embed(text: string): Promise<number[]> }

function cosine(a: readonly number[], b: readonly number[]): number {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
}

/** Embed all distinct skills across the maps once; return a cosine sim function. */
export async function buildSkillSim(maps: readonly SkillsByChunk[], titan: Embedder): Promise<SkillSim> {
    const distinct = new Set<string>();
    for (const map of maps) for (const skills of map.values()) for (const s of skills) distinct.add(s);

    const vecs = new Map<string, number[]>();
    for (const s of distinct) {
        try { vecs.set(s, await titan.embed(s)); } catch { /* skip — sim falls back to 0 (exact-only) */ }
    }

    return (a: string, b: string): number => {
        const va = vecs.get(a);
        const vb = vecs.get(b);
        return va && vb ? cosine(va, vb) : 0;
    };
}
