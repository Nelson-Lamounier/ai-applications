/**
 * @format
 * computeKbQuality — Pure derivation of KB quality from ingested chunks.
 *
 * Pick #4 in the Tucaken-product roadmap. Runs at end of ingestion. No I/O,
 * no async, no LLM. Inputs are everything we already have on hand; outputs
 * are persisted to repo_sync_state.kb_quality_score (NUMERIC) plus
 * kb_quality_breakdown (JSONB) for the UI to surface actionable feedback.
 *
 * Design choices:
 *   - Each factor is a 0..1 score with a transparent value + threshold so
 *     the UI can explain *why* the score is what it is, not just show a
 *     number.
 *   - Weights sum to exactly 1.0. README presence is the heaviest single
 *     factor (0.20) because no README = "this repo is undocumented" = the
 *     resume generator has nothing to work with at the project level.
 *   - Suggestions are derived deterministically from low-scoring factors
 *     so the UI never has to call an LLM to phrase actionable advice.
 *   - Score precision is fixed to 2 decimals to match the column's
 *     NUMERIC(4,2) declaration without surprise rounding mid-pipeline.
 */

import type { RawChunk } from '../types.js';

// =============================================================================
// PUBLIC TYPES
// =============================================================================

export interface KbQualityFactor {
    /** Raw measurement (chunk count, distinct skills, etc.). */
    readonly value:    number | boolean;
    /** Normalised 0..1 score for this factor. */
    readonly score:    number;
    /** Contribution weight; the sum of all weights is exactly 1.0. */
    readonly weight:   number;
    /** score × weight, pre-summed for transparency. */
    readonly weighted: number;
}

export interface KbQualityBreakdown {
    readonly version: 1;
    readonly factors: {
        readonly chunk_count:      KbQualityFactor;
        readonly avg_chunk_length: KbQualityFactor;
        readonly readme_present:   KbQualityFactor;
        readonly tag_diversity:    KbQualityFactor;
        readonly commit_evidence:  KbQualityFactor;
        readonly skill_coverage:   KbQualityFactor;
    };
    /** Final 0..1 score, rounded to 2 decimals. */
    readonly score:        number;
    /** Human-actionable improvements derived from low factor scores. */
    readonly suggestions:  string[];
}

export interface KbQualityResult {
    readonly score:     number;
    readonly breakdown: KbQualityBreakdown;
}

// =============================================================================
// WEIGHTS  (must sum to 1.0)
// =============================================================================

const W = {
    chunk_count:      0.15,
    avg_chunk_length: 0.10,
    readme_present:   0.20,
    tag_diversity:    0.15,
    commit_evidence:  0.20,
    skill_coverage:   0.20,
} as const;

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Compute the KB quality score for a freshly-ingested repo. Caller is
 * expected to pass the same RawChunk[] that the pipeline was about to upsert
 * (post-chunking, post-enrichment). Pure — safe to call before, during, or
 * after persistence.
 */
export function computeKbQuality(chunks: readonly RawChunk[]): KbQualityResult {
    const chunkCount = chunks.length;

    // ----- chunk_count ----------------------------------------------------
    // 100 chunks ≈ a meaningfully-documented repo. Below 30 is "not enough
    // to retrieve from"; above 100 saturates.
    const chunkCountScore = clamp(chunkCount / 100, 0, 1);

    // ----- avg_chunk_length -----------------------------------------------
    // Sweet spot 800–1500 chars. Below = stub headings; above = chunker
    // didn't split well.
    const avgLen = chunkCount === 0
        ? 0
        : chunks.reduce((s, c) => s + c.content.length, 0) / chunkCount;
    const avgChunkLengthScore = scoreAvgLen(avgLen);

    // ----- readme_present -------------------------------------------------
    // Any chunk whose path matches README.{md,mdx} at root or any subdir.
    const readmePresent = chunks.some(c =>
        /(^|\/)README\.(md|mdx)$/i.test(c.filePath),
    );
    const readmePresentScore = readmePresent ? 1 : 0;

    // ----- tag_diversity --------------------------------------------------
    // Distinct top-level directory tags = breadth of the documentation tree.
    // Excludes synthetic '_commits' since that always appears once commit
    // ingestion is on, regardless of doc quality.
    const topLevelTags = new Set<string>();
    for (const c of chunks) {
        const tag = c.tags?.[0];
        if (tag && tag !== '_commits' && tag !== 'commit_history') {
            topLevelTags.add(tag);
        }
    }
    const tagDiversityScore = clamp(topLevelTags.size / 5, 0, 1);

    // ----- commit_evidence ------------------------------------------------
    // Number of commit_history chunks (= weeks of history under the cap).
    const commitWeeks = chunks.filter(c => c.fileType === 'commit_history').length;
    const commitEvidenceScore = clamp(commitWeeks / 10, 0, 1);

    // ----- skill_coverage -------------------------------------------------
    // Distinct skills the enricher pulled across all chunks. 30+ = broad
    // coverage. 0 means enrichment was off, failed, or yielded nothing.
    const skills = new Set<string>();
    for (const c of chunks) {
        for (const s of c.skills ?? []) skills.add(s);
    }
    const skillCoverageScore = clamp(skills.size / 30, 0, 1);

    // ----- assemble factors ----------------------------------------------
    const factors = {
        chunk_count:      mkFactor(chunkCount,        chunkCountScore,      W.chunk_count),
        avg_chunk_length: mkFactor(round0(avgLen),    avgChunkLengthScore,  W.avg_chunk_length),
        readme_present:   mkFactor(readmePresent,     readmePresentScore,   W.readme_present),
        tag_diversity:    mkFactor(topLevelTags.size, tagDiversityScore,    W.tag_diversity),
        commit_evidence:  mkFactor(commitWeeks,       commitEvidenceScore,  W.commit_evidence),
        skill_coverage:   mkFactor(skills.size,       skillCoverageScore,   W.skill_coverage),
    };

    const score = round2(
        factors.chunk_count.weighted +
        factors.avg_chunk_length.weighted +
        factors.readme_present.weighted +
        factors.tag_diversity.weighted +
        factors.commit_evidence.weighted +
        factors.skill_coverage.weighted,
    );

    const suggestions = buildSuggestions(factors);

    return {
        score,
        breakdown: {
            version: 1,
            factors,
            score,
            suggestions,
        },
    };
}

// =============================================================================
// INTERNAL
// =============================================================================

function mkFactor(value: number | boolean, score: number, weight: number): KbQualityFactor {
    return {
        value,
        score:    round2(score),
        weight,
        weighted: round2(score * weight),
    };
}

function clamp(n: number, lo: number, hi: number): number {
    if (Number.isNaN(n)) return lo;
    return Math.min(hi, Math.max(lo, n));
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

function round0(n: number): number {
    return Math.round(n);
}

/**
 * 0..1 score for average chunk length. Peaks 1.0 at 800–1500 chars,
 * tapers linearly outside that band. Below 200 or above 3000 = 0.
 */
function scoreAvgLen(avg: number): number {
    if (avg <= 0) return 0;
    if (avg >= 800 && avg <= 1500) return 1;
    if (avg < 800)   return clamp((avg - 200)  / (800  - 200),  0, 1);
    /* avg > 1500 */ return clamp((3000 - avg) / (3000 - 1500), 0, 1);
}

/**
 * Map low-scoring factors to concrete UI suggestions. Order matters — the
 * UI is expected to show the first 2–3 to avoid overwhelming users.
 */
function buildSuggestions(factors: KbQualityBreakdown['factors']): string[] {
    const out: string[] = [];

    if (factors.readme_present.score < 1) {
        out.push('Add a README.md at the repository root that describes the project, its architecture, and how to run it.');
    }
    if (factors.commit_evidence.score < 0.3) {
        out.push('Commit history is sparse or unavailable. If this repo is private, ensure your token has `repo` scope.');
    }
    if (factors.skill_coverage.score < 0.3) {
        out.push('Skill extraction yielded few signals. Add prose to your docs explaining what each module does and which technologies it uses.');
    }
    if (factors.tag_diversity.score < 0.4) {
        out.push('Documentation is concentrated in a single folder. Split it by concern: docs/concepts/, docs/decisions/, docs/troubleshooting/.');
    }
    if (factors.avg_chunk_length.score < 0.5) {
        out.push('Markdown sections are unusually short or long. Aim for 800–1500 characters per H2 section so each chunk is self-contained.');
    }
    if (factors.chunk_count.score < 0.3) {
        out.push('The repository has very little documented content. Even a thorough README plus per-module READMEs will materially improve resume generation.');
    }

    return out;
}
