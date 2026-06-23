/** @format */
import type { FileEnrichUnit } from './groupChunksByFile.js';
import type { SkillAssignment } from './assignSkillsToChunks.js';
import { surfaceMatch } from './assignSkillsToChunks.js';

/** Cosine similarity of two equal-length vectors. 0 on empty/mismatched/zero-norm. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
    if (a.length === 0 || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i += 1) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Parse a pgvector text value ("[0.1,0.2]") to numbers; null/empty/garbage -> null. */
export function parseVector(raw: unknown): number[] | null {
    if (raw == null) return null;
    if (Array.isArray(raw)) return raw as number[];
    if (typeof raw === 'string') {
        const t = raw.trim();
        if (!t) return null;
        try {
            const v: unknown = JSON.parse(t);
            return Array.isArray(v) ? (v as number[]) : null;
        } catch {
            return null;
        }
    }
    return null;
}

export interface EmbeddingEvidenceOpts {
    /** Canonical skill name -> its skill_ontology embedding. */
    readonly skillVectors: ReadonlyMap<string, readonly number[]>;
    /** chunkIndex -> the chunk's document_embeddings vector (per unit). */
    readonly chunkVectors: ReadonlyMap<number, readonly number[]>;
    /** Cosine cutoff; >= keeps the skill. */
    readonly threshold: number;
}

/**
 * Fan a file unit's skills back to its chunks with a semantic lane: a chunk keeps
 * a skill when it surface-matches OR the skill's vector is within `threshold`
 * cosine of the chunk's vector. Pure + synchronous — all vectors pre-computed by
 * the caller. A skill/chunk with no vector simply has no embedding evidence
 * (surface-match still applies). Recovers the recall surface-match-only drops.
 */
export function assignSkillsByEmbedding(
    unit: FileEnrichUnit,
    unitSkills: readonly string[],
    opts: EmbeddingEvidenceOpts,
): SkillAssignment[] {
    const { skillVectors, chunkVectors, threshold } = opts;
    return unit.chunks.map((c) => {
        const cv = chunkVectors.get(c.chunkIndex);
        return {
            chunkIndex: c.chunkIndex,
            skills: unitSkills.filter((s) => {
                if (surfaceMatch(c.content, s)) return true;
                if (!cv) return false;
                const sv = skillVectors.get(s);
                if (!sv) return false;
                return cosineSimilarity(sv, cv) >= threshold;
            }),
        };
    });
}
