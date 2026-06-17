/** @format */
import { describe, it, expect } from '@jest/globals';
import { summariseCommitChange } from './change-metrics.js';
import type { CommitDetail } from '../ingestion/interfaces/IRepoAdapter.js';

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
