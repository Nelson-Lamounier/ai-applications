/** @format */
import type { KbRetrievalStats, KbRetrievalSource } from '@bedrock/shared';

/**
 * Parse the per-passage headers in an assembled kbContext into a retrieval-health
 * snapshot. Handles the current `[Source: x, Cosine: c, Rerank: r]` header and
 * the legacy `[Source: x, Score: s]` header (treating `Score` as the cosine).
 *
 * Pure — no I/O. `floor` is recorded so the UI can show how many passages a run
 * cleared. An empty/blank kbContext yields `passageCount: 0` and zeroed scores.
 */
const HEADER_COSINE = /^\[Source:\s*(.+?),\s*Cosine:\s*([0-9.]+),\s*Rerank:\s*[0-9.]+\]/;
const HEADER_LEGACY = /^\[Source:\s*(.+?),\s*Score:\s*([0-9.]+)\]/;

function median(sorted: readonly number[]): number {
    if (sorted.length === 0) return 0;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function repoOf(source: string): string {
    // source = "owner/repo/path/to/file" → "owner/repo"
    const parts = source.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : source;
}

export function computeKbStats(kbContext: string, floor: number): KbRetrievalStats {
    const sources: KbRetrievalSource[] = [];
    for (const line of kbContext.split('\n')) {
        const m = HEADER_COSINE.exec(line) ?? HEADER_LEGACY.exec(line);
        if (m) sources.push({ source: m[1], cosine: Number.parseFloat(m[2]) });
    }

    if (sources.length === 0) {
        return {
            passageCount: 0, maxCosine: 0, medianCosine: 0, minCosine: 0,
            floor, topSources: [], repoBreakdown: [],
        };
    }

    const cosines = sources.map(s => s.cosine).sort((a, b) => a - b);
    const repoCounts = new Map<string, number>();
    for (const s of sources) {
        const repo = repoOf(s.source);
        repoCounts.set(repo, (repoCounts.get(repo) ?? 0) + 1);
    }

    const topSources = [...sources]
        .sort((a, b) => b.cosine - a.cosine)
        .slice(0, 5);

    const repoBreakdown = [...repoCounts.entries()]
        .map(([repo, count]) => ({ repo, count }))
        .sort((a, b) => b.count - a.count);

    return {
        passageCount: sources.length,
        maxCosine:    cosines[cosines.length - 1],
        medianCosine: median(cosines),
        minCosine:    cosines[0],
        floor,
        topSources,
        repoBreakdown,
    };
}
