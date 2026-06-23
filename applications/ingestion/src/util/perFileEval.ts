/**
 * @format
 * Per-file candidate builder for the recall eval (run-per-file-eval.ts).
 *
 * Factors the group -> call -> fan-back pipeline into a pure-ish exported
 * helper so the unit test can exercise it with a stub enricher (no Bedrock).
 * Production callers pass a real BedrockChunkEnricher; the test passes a
 * plain object that satisfies the minimal interface.
 */

import {
    groupChunksByFile,
    assignSkillsToChunks,
    assignSkillsByEmbedding,
    type RawChunk,
} from '@bedrock/shared';
import type { FileEnrichUnit } from '@bedrock/shared';
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

// Alias so the brief's PerFileEvalEnricher name resolves to the same type.
export type PerFileEvalEnricher = PerFileEnricher;

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
 * Report-only helper -- makes no DB writes.
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

// ---------------------------------------------------------------------------
// Threshold-sweep helpers (Task 4)
// ---------------------------------------------------------------------------

/** A grouped unit paired with the skills the enricher returned for it. */
export interface EnrichedUnit {
    readonly unit: FileEnrichUnit;
    readonly skills: string[];
}

/**
 * Group chunks into per-file units and run ONE enricher call per unit.
 * The Bedrock cost is paid once; callers then sweep thresholds over the cached
 * skills with zero extra model calls.
 *
 * Report-only helper -- makes no DB writes.
 */
export async function enrichUnitsOnce(
    chunks: readonly RawChunk[],
    enricher: PerFileEvalEnricher,
    opts: { maxChars?: number; vocab?: readonly string[] } = {},
): Promise<{ units: EnrichedUnit[]; callCount: number }> {
    const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
    const grouped = groupChunksByFile(chunks, maxChars);
    const units: EnrichedUnit[] = [];
    let callCount = 0;

    for (const unit of grouped) {
        const heading = unit.chunks[0]?.heading;
        let skills: string[];

        if (opts.vocab && enricher.enrichTextCanonical) {
            const { canonical } = await enricher.enrichTextCanonical(opts.vocab, unit.filePath, unit.text, heading);
            skills = canonical;
        } else {
            const { skills: rawSkills } = await enricher.enrichText(unit.filePath, unit.text, heading);
            skills = rawSkills;
        }
        callCount += 1;
        units.push({ unit, skills });
    }

    return { units, callCount };
}

/** Evidence options for embedding-based fan-back inside fanbackCandidate. */
export interface FanbackEvidence {
    readonly skillVectors: ReadonlyMap<string, readonly number[]>;
    /** Return the embedding vector for a specific chunk, or undefined if absent. */
    readonly chunkVectorOf: (filePath: string, chunkIndex: number) => readonly number[] | undefined;
    readonly threshold: number;
}

/**
 * Fan cached unit skills back to DB-row-keyed skill arrays.
 *
 * - evidence === null  -> surface-match only (assignSkillsToChunks with no match fn).
 * - evidence provided  -> assignSkillsByEmbedding per unit, building a per-unit
 *   chunkVectors map from evidence.chunkVectorOf (keyed by chunkIndex within the unit).
 *
 * Returns a Map from DB row id (looked up via idMap) to assigned skills.
 * idMap keys are "${filePath}::${chunkIndex}".
 */
export function fanbackCandidate(
    units: readonly EnrichedUnit[],
    idMap: Map<string, string>,
    evidence: FanbackEvidence | null,
): Map<string, string[]> {
    const out = new Map<string, string[]>();

    for (const { unit, skills } of units) {
        let assigned;

        if (evidence) {
            // Build a per-unit chunkVectors map keyed by chunkIndex.
            const chunkVectors = new Map<number, readonly number[]>();
            for (const c of unit.chunks) {
                const v = evidence.chunkVectorOf(unit.filePath, c.chunkIndex);
                if (v) chunkVectors.set(c.chunkIndex, v);
            }
            assigned = assignSkillsByEmbedding(unit, skills, {
                skillVectors: evidence.skillVectors,
                chunkVectors,
                threshold: evidence.threshold,
            });
        } else {
            assigned = assignSkillsToChunks(unit, skills, () => false);
        }

        for (const a of assigned) {
            const id = idMap.get(`${unit.filePath}::${a.chunkIndex}`);
            if (id !== undefined) out.set(id, a.skills);
        }
    }

    return out;
}
