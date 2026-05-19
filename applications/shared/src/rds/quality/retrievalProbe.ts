/**
 * @format
 * retrievalProbe — Contract + pure math for the synthetic-Q&A retrieval probe.
 *
 * Companion to computeKbQuality. computeKbQuality measures documentation
 * breadth; this measures whether the ingested embeddings actually retrieve.
 *
 * This file is PURE: zero I/O, no Bedrock, no async. The concrete probe
 * (ingestion app) composes these helpers around its LLM/embed/search calls.
 * Score precision is fixed to 2 decimals to match repo_sync_state
 * .retrieval_score NUMERIC(4,2).
 */

import { createHash } from 'node:crypto';
import type { RawChunk } from '../types.js';
import type { IEmbeddingProvider } from '../interfaces/IEmbeddingProvider.js';
import type { IVectorStore } from '../interfaces/IVectorStore.js';

// ===== Contract ==============================================================

export interface RetrievalProbeArgs {
    readonly userId:       string;
    readonly repoFullName: string;
    readonly rawChunks:    readonly RawChunk[];
    /** The same embedder the corpus used — apples-to-apples. */
    readonly embedder:     IEmbeddingProvider;
    /** Repo-scoped similarity search target. */
    readonly vectorStore:  IVectorStore;
}

export interface IRetrievalProbe {
    /** Best-effort. MUST NOT throw — return status:'failed' instead. */
    evaluate(args: RetrievalProbeArgs): Promise<RetrievalBreakdown>;
}

// ===== Result types =========================================================

export type RetrievalStatus =
    | 'ok'
    | 'skipped_no_chunks'
    | 'skipped_not_configured'
    | 'failed';

export interface RetrievalQuestionResult {
    readonly sourceIndex:   number;
    readonly rank:          number | null;  // 1..K, or null = miss
    readonly topSimilarity: number;         // best result cosine, [0,1]
}

export interface RetrievalBreakdown {
    readonly version:           1;
    readonly status:            RetrievalStatus;
    readonly sampled:           number;
    readonly recallAt3:         number;
    readonly mrr:               number;
    readonly meanTopSimilarity: number;
    readonly score:             number;
    readonly perQuestion:       RetrievalQuestionResult[];
    readonly suggestions:       string[];
}

// ===== Pure helpers =========================================================

/** Minimal shape of a similarity hit the matcher needs. */
export interface RankCandidate {
    readonly filePath:   string;
    readonly chunkIndex: number;
    readonly similarity: number;
}

// Primary guard is fileType (below). Tag '_commits' catches synthetic
// commit-history chunks that are identified by their leading tag.
const SYNTHETIC_TAGS = new Set(['_commits']);

function isEligible(c: RawChunk): boolean {
    if (c.fileType === 'commit_history') return false;
    const tag = c.tags?.[0];
    return !(tag !== undefined && SYNTHETIC_TAGS.has(tag));
}

/**
 * Deterministically pick up to `n` chunks, stratified by `tags[0]`, seeded by
 * repoFullName so reruns and tests are stable. Returns [] when fewer than 2
 * eligible chunks exist (not enough signal to probe).
 */
export function sampleChunks(
    chunks: readonly RawChunk[],
    repoFullName: string,
    n: number,
): RawChunk[] {
    // Cheap pre-filter on raw count; the real "enough signal" decision is the
    // caller's (RetrievalProbe.run skips when the post-filter sample < 2). We
    // intentionally do NOT guard on eligible.length here so a repo with one
    // eligible chunk still yields that chunk for the caller to decide on.
    if (chunks.length < 2) return [];
    const eligible = chunks.filter(isEligible);
    if (eligible.length === 0) return [];

    const seed = parseInt(
        createHash('sha256').update(repoFullName).digest('hex').slice(0, 8),
        16,
    );

    // Stable sort key: hash(seed + filePath + chunkIndex). Group by tag, then
    // round-robin across tag buckets so the sample spreads across doc areas.
    const keyed = eligible
        .map(c => ({
            c,
            tag: c.tags?.[0] ?? '',
            k: parseInt(
                createHash('sha256')
                    .update(`${seed}:${c.filePath}:${c.chunkIndex}`)
                    .digest('hex')
                    .slice(0, 8),
                16,
            ),
        }))
        .sort((a, b) => a.k - b.k);

    const buckets = new Map<string, RawChunk[]>();
    for (const { c, tag } of keyed) {
        const arr = buckets.get(tag) ?? [];
        arr.push(c);
        buckets.set(tag, arr);
    }

    const order = [...buckets.keys()];
    const out: RawChunk[] = [];
    let i = 0;
    while (out.length < n && order.length > 0) {
        const tag = order[i % order.length];
        const arr = buckets.get(tag)!;
        const next = arr.shift();
        if (next) out.push(next);
        if (arr.length === 0) {
            // Do not increment i: splice shifts remaining tags left, so the
            // current slot already points to the next tag in sequence.
            order.splice(i % order.length, 1);
        } else {
            i++;
        }
    }
    return out;
}

/**
 * 1-based rank of the source chunk within results (matched on
 * filePath+chunkIndex), or null if absent. Results MUST be pre-sorted by
 * descending similarity (querySimilar already is).
 */
export function matchRank(
    source: Pick<RawChunk, 'filePath' | 'chunkIndex'>,
    results: readonly RankCandidate[],
): number | null {
    const idx = results.findIndex(
        r => r.filePath === source.filePath && r.chunkIndex === source.chunkIndex,
    );
    return idx === -1 ? null : idx + 1;
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

export function scoreRetrieval(
    perQuestion: readonly RetrievalQuestionResult[],
): Pick<RetrievalBreakdown,
    'sampled' | 'recallAt3' | 'mrr' | 'meanTopSimilarity' | 'score'> {
    const sampled = perQuestion.length;
    if (sampled === 0) {
        return { sampled: 0, recallAt3: 0, mrr: 0, meanTopSimilarity: 0, score: 0 };
    }
    const hits = perQuestion.filter(q => q.rank !== null).length;
    const recallAt3 = hits / sampled;
    const mrr =
        perQuestion.reduce((s, q) => s + (q.rank ? 1 / q.rank : 0), 0) / sampled;
    const meanTopSimilarity =
        perQuestion.reduce((s, q) => s + q.topSimilarity, 0) / sampled;
    const score = round2(0.6 * recallAt3 + 0.4 * mrr);
    return {
        sampled,
        recallAt3,
        mrr,
        meanTopSimilarity,
        score,
    };
}

export function buildRetrievalSuggestions(s: {
    recallAt3: number;
    mrr: number;
    meanTopSimilarity: number;
}): string[] {
    const out: string[] = [];
    if (s.recallAt3 < 0.5) {
        out.push('Chunks retrieve poorly — content may be near-duplicate or too generic; vary section prose so chunks are distinguishable.');
    }
    if (s.mrr < 0.4) {
        out.push('Correct chunk rarely ranks #1 — competing chunks too similar; split overlapping documentation by concern.');
    }
    if (s.meanTopSimilarity < 0.5) {
        out.push('Low absolute similarity — embeddings are weak for this content; check chunk size and that prose (not just code) is present.');
    }
    return out;
}
