/**
 * @format
 * CommitChunker — weekly grouping behaviour.
 */

import { CommitChunker, isoWeek } from '../CommitChunker.js';
import type { RepoCommit } from '@bedrock/shared';

function commit(partial: Partial<RepoCommit> & { sha: string; authoredAt: string; message: string }): RepoCommit {
    return {
        sha:         partial.sha,
        authorLogin: partial.authorLogin ?? 'octocat',
        authorName:  partial.authorName  ?? 'Octo Cat',
        authoredAt:  partial.authoredAt,
        message:     partial.message,
    };
}

describe('isoWeek()', () => {
    it('formats week numbers with zero padding', () => {
        // 2026-01-05 is a Monday → ISO week 2026-W02 (W01 contains 2026-01-01..04
        // because Jan 1 is a Thursday; the first Thursday of the year is in W01).
        expect(isoWeek(new Date('2026-01-05T12:00:00Z'))).toBe('2026-W02');
    });

    it('handles year-boundary edge cases', () => {
        // 2025-12-29 (Mon) belongs to ISO week 2026-W01 because that's the
        // week containing the first Thursday (2026-01-01) of the year.
        expect(isoWeek(new Date('2025-12-29T00:00:00Z'))).toBe('2026-W01');
    });

    it('returns undefined for invalid dates', () => {
        expect(isoWeek(new Date('not a date'))).toBeUndefined();
    });
});

describe('CommitChunker', () => {
    const chunker = new CommitChunker();

    it('returns no chunks for empty input', () => {
        expect(chunker.chunkWeekly([])).toEqual([]);
    });

    it('groups commits in the same ISO week into one chunk', () => {
        const commits = [
            commit({ sha: 'aaa1111', authoredAt: '2026-04-13T08:00:00Z', message: 'feat: add x' }),
            commit({ sha: 'bbb2222', authoredAt: '2026-04-15T09:00:00Z', message: 'fix: y' }),
            commit({ sha: 'ccc3333', authoredAt: '2026-04-19T18:00:00Z', message: 'chore: z' }),
        ];
        const chunks = chunker.chunkWeekly(commits);
        expect(chunks.length).toBe(1);
        expect(chunks[0].heading).toBe('# Week of 2026-W16');
        expect(chunks[0].fileType).toBe('commit_history');
        expect(chunks[0].filePath).toBe('_commits/2026-W16.commit_history');
        expect(chunks[0].content).toContain('feat: add x');
        expect(chunks[0].content).toContain('fix: y');
        expect(chunks[0].content).toContain('chore: z');
    });

    it('emits weeks newest-first', () => {
        const commits = [
            commit({ sha: 'old1aaa', authoredAt: '2026-01-05T10:00:00Z', message: 'old work' }),
            commit({ sha: 'new1bbb', authoredAt: '2026-04-15T10:00:00Z', message: 'recent work' }),
        ];
        const chunks = chunker.chunkWeekly(commits);
        expect(chunks.length).toBe(2);
        expect(chunks[0].heading).toBe('# Week of 2026-W16');     // newer first
        expect(chunks[1].heading).toBe('# Week of 2026-W02');
    });

    it('tags include _commits, commit_history, and lowercased authors', () => {
        const commits = [
            commit({ sha: 'a1', authoredAt: '2026-04-15T10:00:00Z', message: 'x', authorLogin: 'Alice' }),
            commit({ sha: 'b2', authoredAt: '2026-04-16T10:00:00Z', message: 'y', authorLogin: 'BOB' }),
            commit({ sha: 'c3', authoredAt: '2026-04-17T10:00:00Z', message: 'z', authorLogin: 'alice' }),  // dup
        ];
        const chunks = chunker.chunkWeekly(commits);
        expect(chunks[0].tags).toEqual(
            expect.arrayContaining(['_commits', 'commit_history', 'alice', 'bob']),
        );
        expect(chunks[0].tags?.length).toBe(4);  // dedupe Alice/alice
    });

    it('persists timeline metadata for the week', () => {
        const commits = [
            commit({ sha: 'a1', authoredAt: '2026-04-13T08:00:00Z', message: 'first of week' }),
            commit({ sha: 'b2', authoredAt: '2026-04-19T20:00:00Z', message: 'last of week' }),
        ];
        const chunks = chunker.chunkWeekly(commits);
        const meta = chunks[0].metadata as Record<string, unknown>;
        const tl = meta.timeline as Record<string, unknown>;
        expect(tl.first_committed_at).toBe('2026-04-13T08:00:00Z');
        expect(tl.last_committed_at).toBe('2026-04-19T20:00:00Z');
        expect(meta.iso_week).toBe('2026-W16');
        expect(meta.commit_count).toBe(2);
    });

    it('splits a single oversize week into multiple chunks at commit boundaries', () => {
        // Build many commits in one week, each with a long-ish message,
        // to push past the 4000-char default budget.
        const longBody = 'detail line '.repeat(40);                        // ~480 chars
        const commits: RepoCommit[] = [];
        for (let i = 0; i < 20; i++) {
            commits.push(commit({
                sha:        `aabbcc${i.toString(16).padStart(2, '0')}`,
                authoredAt: `2026-04-${String(13 + (i % 7)).padStart(2, '0')}T10:00:00Z`,
                message:    `feat: change ${i}\n\n${longBody}`,
            }));
        }
        const chunks = chunker.chunkWeekly(commits);
        // Multiple chunks expected since aggregate body > 4000 chars.
        expect(chunks.length).toBeGreaterThan(1);
        // Each sub-chunk respects the budget.
        chunks.forEach(c => expect(c.content.length).toBeLessThanOrEqual(4500));
        // Sequential indices, consistent total.
        chunks.forEach((c, i) => {
            expect(c.chunkIndex).toBe(i);
            expect(c.totalChunks).toBe(chunks.length);
        });
    });

    it('skips commits with missing or invalid authoredAt', () => {
        const commits = [
            commit({ sha: 'good1', authoredAt: '2026-04-15T10:00:00Z', message: 'kept' }),
            commit({ sha: 'bad1',  authoredAt: '',                     message: 'dropped' }),
            commit({ sha: 'bad2',  authoredAt: 'not-a-date',           message: 'dropped' }),
        ];
        const chunks = chunker.chunkWeekly(commits);
        expect(chunks.length).toBe(1);
        expect(chunks[0].content).toContain('kept');
        expect(chunks[0].content).not.toContain('dropped');
    });
});
