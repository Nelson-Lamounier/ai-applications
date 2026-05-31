/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { RdsRepoActivityStore } from './RdsRepoActivityStore.js';
import type { RepoCommit, RepoPullRequest } from '../../ingestion/interfaces/IRepoAdapter.js';

interface RecordedQuery {
    sql: string;
    params?: unknown[];
}

function fakePool(opts: { throwOn?: RegExp } = {}) {
    const queries: RecordedQuery[] = [];
    const client = {
        queries,
        query: jest.fn(async (sql: string, params?: unknown[]) => {
            queries.push({ sql, params });
            if (opts.throwOn && opts.throwOn.test(sql)) {
                throw new Error('insert failed');
            }
            return { rowCount: 1, rows: [] };
        }),
        release: jest.fn(),
    };
    const pool = {
        client,
        connect: jest.fn(async () => client),
    };
    return pool;
}

const commits: RepoCommit[] = [
    {
        sha:        'abc123',
        authorName: 'Ada Lovelace',
        authorLogin: 'ada',
        authoredAt: '2026-01-01T00:00:00.000Z',
        message:    'Initial commit',
    },
    {
        sha:        'def456',
        authorName: 'Alan Turing',
        authoredAt: '2026-01-02T00:00:00.000Z',
        message:    'Second commit',
    },
];

const pulls: RepoPullRequest[] = [
    {
        number:      1,
        title:       'Add feature',
        body:        'A body',
        createdAt:   '2026-01-01T00:00:00.000Z',
        mergedAt:    '2026-01-03T00:00:00.000Z',
        state:       'merged',
        authorLogin: 'ada',
        htmlUrl:     'https://example.com/pr/1',
    },
    {
        number:      2,
        title:       'Fix bug',
        body:        null,
        createdAt:   '2026-01-04T00:00:00.000Z',
        mergedAt:    null,
        state:       'open',
        authorLogin: null,
        htmlUrl:     'https://example.com/pr/2',
    },
];

describe('RdsRepoActivityStore', () => {
    it('upsertCommits() inserts commits with RLS, conflict clause and commits the txn', async () => {
        const pool = fakePool();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = new RdsRepoActivityStore(pool as any);

        const count = await store.upsertCommits('user-1', 'repo-1', 'owner/repo', commits);

        expect(count).toBe(2);
        const sqls = pool.client.queries.map(q => q.sql);
        expect(sqls.some(s => /set_config\('app.current_user_id'/.test(s))).toBe(true);
        expect(sqls.some(s => /INSERT INTO repo_commits/.test(s))).toBe(true);
        expect(sqls.some(s => /ON CONFLICT \(repository_id, sha\) DO UPDATE/.test(s))).toBe(true);
        expect(sqls).toContain('COMMIT');
    });

    it('upsertCommits() returns 0 and does not connect for an empty batch', async () => {
        const pool = fakePool();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = new RdsRepoActivityStore(pool as any);

        const count = await store.upsertCommits('user-1', 'repo-1', 'owner/repo', []);

        expect(count).toBe(0);
        expect(pool.connect).not.toHaveBeenCalled();
    });

    it('upsertPullRequests() inserts PRs with conflict clause', async () => {
        const pool = fakePool();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = new RdsRepoActivityStore(pool as any);

        const count = await store.upsertPullRequests('user-1', 'repo-1', 'owner/repo', pulls);

        expect(count).toBe(2);
        const sqls = pool.client.queries.map(q => q.sql);
        expect(sqls.some(s => /INSERT INTO repo_pull_requests/.test(s))).toBe(true);
        expect(sqls.some(s => /ON CONFLICT \(repository_id, number\) DO UPDATE/.test(s))).toBe(true);
    });

    it('upsertCommits() rolls back and rethrows when the insert fails', async () => {
        const pool = fakePool({ throwOn: /INSERT INTO repo_commits/ });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = new RdsRepoActivityStore(pool as any);

        await expect(
            store.upsertCommits('user-1', 'repo-1', 'owner/repo', commits),
        ).rejects.toThrow('insert failed');

        const sqls = pool.client.queries.map(q => q.sql);
        expect(sqls).toContain('ROLLBACK');
    });
});
