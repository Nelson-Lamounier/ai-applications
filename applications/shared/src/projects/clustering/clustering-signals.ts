/**
 * @format
 * Deterministic signal extraction for project clustering.
 *
 * Pure functions — they take per-repo digests and existing description
 * embeddings, and produce the compact signal block fed to the clustering
 * agent. No Bedrock calls, no database access; the loader (in
 * run-clustering.ts) is responsible for materialising digests + embeddings
 * from RDS first.
 *
 * Keeping signals deterministic and external to the model serves three
 * goals:
 *
 *   1. The model receives correlations as evidence, not as work it has to
 *      do — Haiku 4.5 is plenty for picking and justifying groupings, but
 *      we don't pay it to recompute cosine similarity.
 *   2. We can unit-test signal extraction without burning Bedrock cost.
 *   3. The same signals are surfaced to humans in the Phase 5 review UI;
 *      "why are these grouped?" answers itself when the prompt-input is
 *      visible.
 */
import type { ClusteringSignals, RepoClusteringDigest } from '../types.js';

/** Topics so generic they don't help discriminate groupings — filtered out. */
const GENERIC_TOPICS = new Set([
    'typescript', 'javascript', 'python', 'java', 'go', 'rust',
    'react', 'node', 'nodejs', 'web', 'cli', 'library',
    'open-source', 'opensource', 'starter', 'boilerplate',
    'tutorial', 'demo', 'example',
]);

/** Default cosine threshold over Titan Embed v2 description embeddings. */
const EMBEDDING_PAIR_THRESHOLD = 0.78;

/** Hard cap on returned embedding pairs to bound prompt size. */
const MAX_EMBEDDING_PAIRS = 32;

/**
 * Drop tokens that wouldn't help discriminate. Operates on short-name parts
 * (already lower-cased and dash-split).
 */
function isCandidatePrefix(token: string): boolean {
    if (token.length < 3 || token.length > 32) return false;
    if (/^\d+$/.test(token)) return false;
    if (GENERIC_TOPICS.has(token)) return false;
    return true;
}

/**
 * Extract naming prefixes — dash-separated leading tokens of the repo short
 * name — that are shared by at least two repos. Returned map is keyed by the
 * prefix and valued by the repo short names that exhibit it.
 *
 * Example: `[tucaken-api, tucaken-web, notes-cli]` → `{ tucaken: [...] }`.
 */
export function extractNamingPrefixes(
    digests: readonly RepoClusteringDigest[],
): Map<string, readonly string[]> {
    const buckets = new Map<string, string[]>();
    for (const d of digests) {
        const parts = d.shortName.toLowerCase().split(/[-_]/).filter(Boolean);
        if (parts.length < 2) continue; // single-word repos can't share a prefix
        const first = parts[0];
        if (!isCandidatePrefix(first)) continue;
        const arr = buckets.get(first) ?? [];
        arr.push(d.shortName);
        buckets.set(first, arr);
    }

    const out = new Map<string, readonly string[]>();
    for (const [k, v] of buckets) {
        if (v.length >= 2) out.set(k, v);
    }
    return out;
}

/**
 * Topics that span ≥ 2 repos, with the matching repo short names.
 */
export function extractSharedTopics(
    digests: readonly RepoClusteringDigest[],
): Map<string, readonly string[]> {
    const buckets = new Map<string, string[]>();
    for (const d of digests) {
        for (const raw of d.topics) {
            const t = raw.trim().toLowerCase();
            if (!t || GENERIC_TOPICS.has(t)) continue;
            const arr = buckets.get(t) ?? [];
            arr.push(d.shortName);
            buckets.set(t, arr);
        }
    }
    const out = new Map<string, readonly string[]>();
    for (const [k, v] of buckets) {
        if (v.length >= 2) out.set(k, v);
    }
    return out;
}

/**
 * Tech-stack items that span ≥ 2 repos. Case-folded; deduped within a single
 * repo so a repo listing `React` and `react` doesn't double-count.
 */
export function extractSharedTechStack(
    digests: readonly RepoClusteringDigest[],
): Map<string, readonly string[]> {
    const buckets = new Map<string, string[]>();
    for (const d of digests) {
        const seen = new Set<string>();
        for (const raw of d.techStack) {
            const t = raw.trim().toLowerCase();
            if (!t || seen.has(t)) continue;
            seen.add(t);
            const arr = buckets.get(t) ?? [];
            arr.push(d.shortName);
            buckets.set(t, arr);
        }
    }
    const out = new Map<string, readonly string[]>();
    for (const [k, v] of buckets) {
        if (v.length >= 2) out.set(k, v);
    }
    return out;
}

/**
 * Embedding rows passed in from RDS. The loader is expected to fetch one
 * row per `repository_profile_embeddings` row whose `chunk_type =
 * 'description'`, keeping the array of floats at vector(1024) length.
 */
export interface DescriptionEmbedding {
    readonly repoFullName: string;
    readonly embedding:    readonly number[];
}

function cosine(a: readonly number[], b: readonly number[]): number {
    const len = Math.min(a.length, b.length);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < len; i++) {
        dot   += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / Math.sqrt(normA * normB);
}

/**
 * Top-N embedding pairs above `threshold`, deduped, sorted by score
 * descending. The pgvector index gets us neighbours in O(log n) at query
 * time, but for the clustering pass we operate on the whole user-scoped
 * set in-memory (≤ a few hundred repos in practice).
 */
export function extractEmbeddingPairs(
    embeddings: readonly DescriptionEmbedding[],
    options: { threshold?: number; maxPairs?: number } = {},
): ClusteringSignals['embeddingPairs'] {
    const threshold = options.threshold ?? EMBEDDING_PAIR_THRESHOLD;
    const cap       = options.maxPairs  ?? MAX_EMBEDDING_PAIRS;

    const pairs: { repoA: string; repoB: string; score: number }[] = [];
    for (let i = 0; i < embeddings.length; i++) {
        for (let j = i + 1; j < embeddings.length; j++) {
            const score = cosine(embeddings[i].embedding, embeddings[j].embedding);
            if (score >= threshold) {
                pairs.push({
                    repoA: embeddings[i].repoFullName,
                    repoB: embeddings[j].repoFullName,
                    score,
                });
            }
        }
    }
    pairs.sort((a, b) => b.score - a.score);
    return pairs.slice(0, cap);
}

/**
 * Bundle everything into the `ClusteringSignals` shape the agent expects.
 */
export function buildClusteringSignals(
    digests: readonly RepoClusteringDigest[],
    embeddings: readonly DescriptionEmbedding[] = [],
): ClusteringSignals {
    return {
        namingPrefixes:  extractNamingPrefixes(digests),
        sharedTopics:    extractSharedTopics(digests),
        sharedTechStack: extractSharedTechStack(digests),
        embeddingPairs:  extractEmbeddingPairs(embeddings),
    };
}

/**
 * Serialise the signal block to a compact string suitable for direct
 * embedding in the agent's user message. Maps are flattened to arrays of
 * `[key, [members]]` pairs so the wire format is plain JSON. Repos are
 * referenced by short name everywhere in the signals view; the model maps
 * back to UUIDs via the digest array that accompanies the signals.
 */
export function serialiseSignalsForPrompt(signals: ClusteringSignals): string {
    return JSON.stringify({
        namingPrefixes:  Array.from(signals.namingPrefixes.entries()),
        sharedTopics:    Array.from(signals.sharedTopics.entries()),
        sharedTechStack: Array.from(signals.sharedTechStack.entries()),
        embeddingPairs:  signals.embeddingPairs.map((p) => ({
            repoA: p.repoA,
            repoB: p.repoB,
            score: Number(p.score.toFixed(3)),
        })),
    });
}
