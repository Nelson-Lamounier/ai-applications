/**
 * @format
 * CommitChunker — Groups commits into RawChunks for ingestion.
 *
 * Pure class — no I/O, no async. Stands outside the ChunkerRegistry because
 * commits are not file content; the registry routes by file path while this
 * class is invoked directly by the orchestrator with a RepoCommit[] input.
 *
 * Default grouping: ISO week (YYYY-Www).
 *   Reads like a development log; produces a temporal anchor the resume
 *   generator can use ("in early 2026 the user worked on Kubernetes").
 *   One chunk per week regardless of commit volume — keeps chunk count
 *   proportional to evidence density, not commit churn.
 *
 * Why not per-file or per-feature grouping?
 *   - Per-file grouping requires per-commit `files[]` data which the GitHub
 *     list endpoint does not return; fetching it costs 1 API request per
 *     commit. Deferred to a follow-up.
 *   - Per-feature/topic clustering (by message similarity or path prefix) is
 *     the most useful long-term shape but needs embedding-based clustering
 *     or path heuristics — out of scope for v1.
 *
 * Synthetic file path:
 *   `_commits/<YYYY-Www>.commit_history` — leading underscore filters the
 *   directory out of the path-derived tag set automatically. The chunker
 *   sets explicit tags + file_type instead.
 */

import type { RepoCommit } from '../interfaces/IRepoAdapter.js';
import type { RawChunk } from '../../rds/types.js';
import { COMMIT_HISTORY_PATH_PREFIX } from '../../repo-entities.js';
export { COMMIT_HISTORY_PATH_PREFIX }; // preserve existing export surface

// =============================================================================
// CONFIG
// =============================================================================

export interface CommitChunkerConfig {
    /**
     * Maximum characters per chunk. If a week's formatted commits exceed
     * this, the week is split into multiple sub-chunks at commit boundaries
     * (a single commit message is never split). Default 4000 — bigger than
     * the markdown chunker's 2000 because commit chunks are denser and
     * benefit from broader temporal context.
     */
    readonly maxChunkChars: number;
}

const DEFAULT_CONFIG: CommitChunkerConfig = {
    maxChunkChars: 4000,
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class CommitChunker {
    private readonly config: CommitChunkerConfig;

    constructor(config: Partial<CommitChunkerConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Group commits into weekly RawChunks. Commits are expected in any order;
     * grouping does the bucketing and within-week sorting.
     *
     * Empty input → empty output. Weeks with zero qualifying commits are
     * silently dropped.
     */
    chunkWeekly(commits: RepoCommit[]): RawChunk[] {
        if (commits.length === 0) return [];

        // Bucket commits by ISO week. Within each bucket, sort by date asc
        // so the chunk reads like a chronological log.
        const buckets = new Map<string, RepoCommit[]>();
        for (const c of commits) {
            if (!c.authoredAt) continue;
            const week = isoWeek(new Date(c.authoredAt));
            if (!week) continue;
            const list = buckets.get(week) ?? [];
            list.push(c);
            buckets.set(week, list);
        }

        // Emit weeks newest-first so the most recent evidence is at the top
        // of any retrieved subset.
        const weekKeys = Array.from(buckets.keys()).sort().reverse();
        const flat: Omit<RawChunk, 'chunkIndex' | 'totalChunks'>[] = [];

        for (const week of weekKeys) {
            const weekCommits = (buckets.get(week) ?? []).slice().sort(
                (a, b) => a.authoredAt.localeCompare(b.authoredAt),
            );
            for (const c of this.formatWeek(week, weekCommits)) {
                flat.push(c);
            }
        }

        return flat.map((c, i) => ({
            ...c,
            chunkIndex:  i,
            totalChunks: flat.length,
        }));
    }

    // =========================================================================
    // Private
    // =========================================================================

    /**
     * Format one week's commits into one or more RawChunks. Splits at commit
     * boundaries when the formatted body exceeds maxChunkChars — never
     * splits within a single commit message.
     */
    private formatWeek(
        week: string,
        commits: RepoCommit[],
    ): Omit<RawChunk, 'chunkIndex' | 'totalChunks'>[] {
        const heading = `# Week of ${week}`;
        const out: Omit<RawChunk, 'chunkIndex' | 'totalChunks'>[] = [];

        // Authors who contributed in this week — used as tags + metadata.
        const authors = Array.from(new Set(
            commits.map(c => (c.authorLogin ?? c.authorName ?? '').toLowerCase().trim())
                   .filter(Boolean),
        ));

        const filePath = `${COMMIT_HISTORY_PATH_PREFIX}${week}.commit_history`;
        const tags     = ['_commits', 'commit_history', ...authors];

        const baseMetadata = {
            commit_count: commits.length,
            iso_week:     week,
            authors,
            timeline: {
                first_committed_at: commits[0].authoredAt,
                last_committed_at:  commits[commits.length - 1].authoredAt,
            },
        };

        // Build chunk bodies, splitting at commit boundaries when needed.
        let buffer       = `${heading}\n\n`;
        let bufferStart  = commits[0].authoredAt;
        let bufferShas: string[] = [];

        const flush = (lastAt: string) => {
            const body = buffer.trimEnd();
            if (body.length === heading.length) return;       // nothing but heading
            out.push({
                filePath,
                heading,
                content:  body,
                fileType: 'commit_history',
                tags,
                metadata: {
                    ...baseMetadata,
                    fileClass:                'history',
                    chunk_first_committed_at: bufferStart,
                    chunk_last_committed_at:  lastAt,
                    chunk_shas:               bufferShas,
                },
            });
            buffer      = `${heading} (continued)\n\n`;
            bufferShas  = [];
        };

        for (const c of commits) {
            const block = formatCommit(c);
            // +1 for the trailing newline we'll add between commits.
            if (buffer.length + block.length + 1 > this.config.maxChunkChars && bufferShas.length > 0) {
                flush(bufferShas.length > 0 ? commits[commits.indexOf(c) - 1].authoredAt : c.authoredAt);
                bufferStart = c.authoredAt;
            }
            if (bufferShas.length === 0) bufferStart = c.authoredAt;
            buffer += block + '\n';
            bufferShas.push(c.sha);
        }
        flush(commits[commits.length - 1].authoredAt);

        return out;
    }
}

// =============================================================================
// FORMATTING + ISO WEEK HELPERS
// =============================================================================

/** Render one commit as a bullet block — author, date, full message. */
function formatCommit(c: RepoCommit): string {
    const author    = c.authorLogin ?? c.authorName;
    const shortSha  = c.sha.slice(0, 7);
    const date      = c.authoredAt.split('T')[0] ?? c.authoredAt;
    const subject   = (c.message.split('\n')[0] ?? '').trim();
    const body      = c.message.split('\n').slice(1).join('\n').trim();

    const lines: string[] = [];
    lines.push(`- [${date}] (${shortSha}) ${author}: ${subject}`);
    if (body) {
        for (const line of body.split('\n')) {
            lines.push(`    ${line}`);
        }
    }
    return lines.join('\n');
}

/**
 * ISO 8601 week-numbering format: `YYYY-Www`. Aligns cleanly with how humans
 * think about time and avoids edge cases at year boundaries (week 1 of the
 * ISO year is the week containing the first Thursday of the calendar year,
 * so it may start in late December or early January).
 *
 * Returns undefined for invalid dates.
 */
export function isoWeek(date: Date): string | undefined {
    if (Number.isNaN(date.getTime())) return undefined;

    // Copy date in UTC to avoid local-tz drift across the year boundary.
    const tmp = new Date(Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
    ));
    // Shift to Thursday of the same ISO week (1 = Mon, …, 7 = Sun).
    const dayNum = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);

    const isoYear = tmp.getUTCFullYear();
    const yearStart = new Date(Date.UTC(isoYear, 0, 1));
    const week = Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);

    return `${isoYear}-W${String(week).padStart(2, '0')}`;
}
