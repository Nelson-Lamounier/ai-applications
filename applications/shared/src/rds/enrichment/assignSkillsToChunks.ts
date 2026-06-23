/** @format */
import type { FileEnrichUnit } from './groupChunksByFile.js';

/** Per-chunk skill subset produced by file-level extraction (keyed by chunkIndex). */
export interface SkillAssignment {
    readonly chunkIndex: number;
    readonly skills: string[];
}

/**
 * Evidence predicate: does this chunk's content support this skill beyond a plain
 * surface match? Injected so the resolver/embedding lane (paraphrase) stays out
 * of this pure function. In production the pipeline passes a function backed by
 * the SkillEmbeddingResolver; tests pass a stub.
 */
export type SkillEvidence = (chunkContent: string, skill: string) => boolean;

/** Cheap deterministic surface check — the skill phrase appears in the chunk. */
export function surfaceMatch(content: string, skill: string): boolean {
    return content.toLowerCase().includes(skill.toLowerCase());
}

/**
 * Fan a file unit's extracted skills back to its member chunks under the
 * precision guard (FR-004): a chunk gets a skill ONLY if it evidences it —
 * surface-match OR the injected evidence fn. A unit skill that no chunk
 * evidences is dropped entirely (never force-attached). Each chunk's output is
 * therefore a SUBSET of the unit skills, never a superset.
 *
 * This is what stops a big multi-purpose file from smearing a skill that lives
 * in one region onto every chunk of the file. Pure + deterministic given
 * `evidence`.
 */
export function assignSkillsToChunks(
    unit: FileEnrichUnit,
    unitSkills: readonly string[],
    evidence: SkillEvidence,
): SkillAssignment[] {
    return unit.chunks.map((c) => ({
        chunkIndex: c.chunkIndex,
        skills: unitSkills.filter(
            (s) => surfaceMatch(c.content, s) || evidence(c.content, s),
        ),
    }));
}
