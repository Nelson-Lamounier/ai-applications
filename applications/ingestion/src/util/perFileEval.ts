/**
 * @format
 * Per-file candidate builder for the recall eval (run-per-file-eval.ts).
 *
 * Factors the group → call → fan-back pipeline into a pure-ish exported
 * helper so the unit test can exercise it with a stub enricher (no Bedrock).
 * Production callers pass a real BedrockChunkEnricher; the test passes a
 * plain object that satisfies the minimal interface.
 */

import { groupChunksByFile, assignSkillsToChunks, type RawChunk } from '@bedrock/shared';
import type { SkillsByChunk } from './enrichEvalMetrics.js';

// ---------------------------------------------------------------------------
// Minimal enricher interface (subset of IChunkEnricher)
// ---------------------------------------------------------------------------

/**
 * Minimal surface of IChunkEnricher required by buildPerFileCandidate.
 * Using a structural type rather than importing the full interface keeps
 * tests free of Bedrock / PG dependencies.
 */
export interface PerFileEnricher {
    enrichText(filePath: string, content: string, heading?: string): Promise<{ skills: string[]; technologies: string[] }>;
    enrichTextCanonical?(
        vocabulary: readonly string[],
        filePath: string,
        content: string,
        heading?: string,
    ): Promise<{ canonical: string[]; newSkills: string[] }>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BuildPerFileCandidateOpts {
    /** Maximum concatenated character budget per FileEnrichUnit (default 12 000). */
    readonly maxChars?: number;
    /** When provided, calls enrichTextCanonical instead of enrichText. */
    readonly vocab?: readonly string[];
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface BuildPerFileCandidateResult {
    /** Skills keyed by `${filePath}::${chunkIndex}`, matching SkillsByChunk. */
    readonly candidate: SkillsByChunk;
    /** Number of enricher calls made (one per FileEnrichUnit). */
    readonly callCount: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHARS = 12_000;

/** Key scheme shared with the eval harnesses: `${filePath}::${chunkIndex}`. */
const chunkKey = (filePath: string, chunkIndex: number): string =>
    `${filePath}::${chunkIndex}`;

/**
 * Group chunks into per-file units, call the enricher once per unit, then fan
 * the returned skills back to member chunks via assignSkillsToChunks (surface-
 * match precision guard). Returns a SkillsByChunk map and the total call count.
 *
 * Report-only helper — makes no DB writes.
 */
export async function buildPerFileCandidate(
    chunks: readonly RawChunk[],
    enricher: PerFileEnricher,
    opts: BuildPerFileCandidateOpts = {},
): Promise<BuildPerFileCandidateResult> {
    const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
    const vocab = opts.vocab;

    const units = groupChunksByFile(chunks, maxChars);
    const candidate = new Map<string, string[]>();
    let callCount = 0;

    for (const unit of units) {
        const heading = unit.chunks[0]?.heading;

        let unitSkills: string[];
        if (vocab && enricher.enrichTextCanonical) {
            const { canonical } = await enricher.enrichTextCanonical(vocab, unit.filePath, unit.text, heading);
            unitSkills = canonical;
        } else {
            const { skills } = await enricher.enrichText(unit.filePath, unit.text, heading);
            unitSkills = skills;
        }
        callCount++;

        for (const assignment of assignSkillsToChunks(unit, unitSkills, () => false)) {
            candidate.set(chunkKey(unit.filePath, assignment.chunkIndex), assignment.skills);
        }
    }

    return { candidate, callCount };
}
