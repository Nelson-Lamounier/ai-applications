/** @format */
import { describe, it, expect } from '@jest/globals';
import { summariseCommitChange, cyclomaticComplexityDelta, buildFileChangeImpact } from './change-metrics.js';
import type { CommitDetail } from '../ingestion/interfaces/IRepoAdapter.js';
import type { FileChange } from '../rds/implementations/RdsRepoActivityStore.js';

const detail = (over: Partial<CommitDetail> = {}): CommitDetail => ({
    sha: 'abc', additions: 0, deletions: 0, filesChanged: 0, files: [], ...over,
});

describe('summariseCommitChange', () => {
    it('computes loc delta and churn from commit stats', () => {
        const m = summariseCommitChange(detail({ additions: 30, deletions: 12, filesChanged: 4 }));
        expect(m.locDelta).toBe(18);   // 30 - 12
        expect(m.churn).toBe(42);      // 30 + 12
        expect(m.filesChanged).toBe(4);
        expect(m.sha).toBe('abc');
    });

    it('counts files by status', () => {
        const m = summariseCommitChange(detail({
            files: [
                { filePath: 'a.ts', status: 'modified', additions: 1, deletions: 1, changes: 2, patch: null, patchTruncated: false },
                { filePath: 'b.ts', status: 'added',    additions: 5, deletions: 0, changes: 5, patch: null, patchTruncated: false },
                { filePath: 'c.ts', status: 'modified', additions: 2, deletions: 3, changes: 5, patch: null, patchTruncated: false },
                { filePath: 'd.ts', status: 'removed',  additions: 0, deletions: 9, changes: 9, patch: null, patchTruncated: false },
            ],
        }));
        expect(m.byStatus).toEqual({ modified: 2, added: 1, removed: 1 });
    });

    it('handles a commit with no files', () => {
        const m = summariseCommitChange(detail());
        expect(m).toMatchObject({ locDelta: 0, churn: 0, filesChanged: 0, byStatus: {} });
    });

    it('is deterministic — never invents numbers beyond the stats provided', () => {
        const m = summariseCommitChange(detail({ additions: 7, deletions: 7 }));
        expect(m.locDelta).toBe(0);
        expect(m.churn).toBe(14);
    });
});

describe('cyclomaticComplexityDelta', () => {
    it('counts decision points added minus removed in a unified diff', () => {
        const patch = [
            '@@ -1,3 +1,4 @@',
            ' function f() {',
            '-  return 1;',
            '+  if (a && b) return 1;',
            '+  for (const x of xs) doThing(x);',
            ' }',
        ].join('\n');
        // added: if(+1) && (+1) for(+1) = +3 ; removed: 0
        expect(cyclomaticComplexityDelta(patch)).toBe(3);
    });

    it('goes negative when a change simplifies (removes branches/loops)', () => {
        const patch = [
            '@@ -1,5 +1,1 @@',
            '-  for (const x of xs) {',
            '-    if (x > 0 && x < 10) acc += x;',
            '-  }',
            '+  acc = sum(xs);',
        ].join('\n');
        // removed: for(-1) if(-1) &&(-1) = -3 ; added: 0
        expect(cyclomaticComplexityDelta(patch)).toBe(-3);
    });

    it('ignores diff headers and context lines', () => {
        const patch = [
            '--- a/x.ts',
            '+++ b/x.ts',
            '@@ -1 +1 @@',
            ' const ok = a && b;', // context — not counted
        ].join('\n');
        expect(cyclomaticComplexityDelta(patch)).toBe(0);
    });

    it('returns 0 for a null/empty patch', () => {
        expect(cyclomaticComplexityDelta(null)).toBe(0);
        expect(cyclomaticComplexityDelta('')).toBe(0);
    });
});

describe('buildFileChangeImpact', () => {
    const change = (over: Partial<FileChange> = {}): FileChange => ({
        commitSha: 's', status: 'modified', additions: 0, deletions: 0, changes: 0,
        patch: null, patchTruncated: false, authoredAt: '2026-01-01T00:00:00Z', message: 'm', ...over,
    });

    it('aggregates churn, net loc, change count, and complexity delta over history', () => {
        const impact = buildFileChangeImpact('src/a.ts', [
            change({ commitSha: 'c2', additions: 10, deletions: 4, authoredAt: '2026-02-01T00:00:00Z',
                     patch: '@@\n+  if (x) y();' }),
            change({ commitSha: 'c1', additions: 3, deletions: 1, authoredAt: '2026-01-01T00:00:00Z',
                     patch: '@@\n-  for (a of b) c();' }),
        ]);
        expect(impact.filePath).toBe('src/a.ts');
        expect(impact.changeCount).toBe(2);
        expect(impact.churn).toBe(18);        // 10+4 + 3+1
        expect(impact.netLoc).toBe(8);        // (10-4) + (3-1)
        expect(impact.complexityDelta).toBe(0); // +1 (if) then -1 (for)
        expect(impact.lastChangedAt).toBe('2026-02-01T00:00:00Z');
    });

    it('is empty-safe', () => {
        const impact = buildFileChangeImpact('src/none.ts', []);
        expect(impact).toMatchObject({ filePath: 'src/none.ts', changeCount: 0, churn: 0, netLoc: 0, complexityDelta: 0 });
        expect(impact.lastChangedAt).toBeNull();
    });
});
