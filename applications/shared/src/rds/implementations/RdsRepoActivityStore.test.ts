/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { RdsRepoActivityStore } from './RdsRepoActivityStore.js';
import type { RepoCommit, RepoPullRequest, CommitDetail } from '../../ingestion/interfaces/IRepoAdapter.js';

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

    it('dual-writes the injected github_repo_id on commits + PRs (COALESCE on conflict)', async () => {
        const pool = fakePool();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = new RdsRepoActivityStore(pool as any, 4242);

        await store.upsertCommits('user-1', 'repo-1', 'owner/repo', commits);
        await store.upsertPullRequests('user-1', 'repo-1', 'owner/repo', pulls);

        const commitInsert = pool.client.queries.find(q => /INSERT INTO repo_commits/.test(q.sql))!;
        expect(commitInsert.sql).toMatch(/github_repo_id/);
        expect(commitInsert.sql).toMatch(/COALESCE\(EXCLUDED\.github_repo_id, repo_commits\.github_repo_id\)/);
        // 9 params/commit × 2 commits; github_repo_id is each tuple's last.
        expect(commitInsert.params).toHaveLength(18);
        expect(commitInsert.params![8]).toBe(4242);
        expect(commitInsert.params![17]).toBe(4242);

        const prInsert = pool.client.queries.find(q => /INSERT INTO repo_pull_requests/.test(q.sql))!;
        expect(prInsert.sql).toMatch(/COALESCE\(EXCLUDED\.github_repo_id, repo_pull_requests\.github_repo_id\)/);
        expect(prInsert.params).toHaveLength(24); // 12 params/PR × 2
        expect(prInsert.params![11]).toBe(4242);
    });

    it('binds null github_repo_id on a pre-backfill run', async () => {
        const pool = fakePool();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = new RdsRepoActivityStore(pool as any);

        await store.upsertCommits('user-1', 'repo-1', 'owner/repo', commits);

        const commitInsert = pool.client.queries.find(q => /INSERT INTO repo_commits/.test(q.sql))!;
        expect(commitInsert.params![8]).toBeNull();
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

const DETAIL: CommitDetail = {
    sha: 'abc123', additions: 10, deletions: 3, filesChanged: 1,
    files: [{
        filePath: 'src/a.ts', status: 'modified', additions: 8, deletions: 3, changes: 11,
        patch: '@@ -1 +1 @@\n-old\n+new', patchTruncated: false,
    }],
};

describe('RdsRepoActivityStore.upsertCommitDetails', () => {
    it('updates repo_commits stats and inserts repo_commit_files', async () => {
        const pool = fakePool();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = new RdsRepoActivityStore(pool as any, 999);

        await store.upsertCommitDetails('user-1', 'repo-uuid', 'o/r', [DETAIL]);

        const sqls = pool.client.queries.map(q => q.sql).join('\n');
        expect(sqls).toContain('UPDATE repo_commits');
        expect(sqls).toContain('INSERT INTO repo_commit_files');
        expect(sqls).toContain('COMMIT');
        const fileInsert = pool.client.queries.find(q => /INSERT INTO repo_commit_files/.test(q.sql))!;
        expect(fileInsert.params).toEqual(expect.arrayContaining(['src/a.ts', 'abc123', '@@ -1 +1 @@\n-old\n+new']));
    });

    it('is a no-op for an empty list', async () => {
        const pool = fakePool();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = new RdsRepoActivityStore(pool as any);
        await store.upsertCommitDetails('user-1', 'repo-uuid', 'o/r', []);
        expect(pool.connect).not.toHaveBeenCalled();
    });

    it('rolls back and rethrows when the file insert fails', async () => {
        const pool = fakePool({ throwOn: /INSERT INTO repo_commit_files/ });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = new RdsRepoActivityStore(pool as any);
        await expect(store.upsertCommitDetails('user-1', 'repo-uuid', 'o/r', [DETAIL])).rejects.toThrow('insert failed');
        expect(pool.client.queries.map(q => q.sql)).toContain('ROLLBACK');
    });
});

describe('RdsRepoActivityStore.upsertCommitPerf', () => {
    it('inserts measured perf rows', async () => {
        const pool = fakePool();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = new RdsRepoActivityStore(pool as any, 7);
        const n = await store.upsertCommitPerf('user-1', 'repo-uuid', 'o/r', [
            { commitSha: 'abc', metricName: 'p95_latency_ms', value: 1200, unit: 'ms', source: 'ci-benchmark', measuredAt: '2026-01-01T00:00:00Z' },
        ]);
        expect(n).toBe(1);
        const sqls = pool.client.queries.map(q => q.sql).join('\n');
        expect(sqls).toContain('INSERT INTO repo_commit_perf');
        const ins = pool.client.queries.find(q => /repo_commit_perf/.test(q.sql))!;
        expect(ins.params).toEqual(expect.arrayContaining(['p95_latency_ms', 1200, 'ms', 'ci-benchmark']));
    });

    it('is a no-op for an empty list', async () => {
        const pool = fakePool();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = new RdsRepoActivityStore(pool as any);
        await store.upsertCommitPerf('user-1', 'repo-uuid', 'o/r', []);
        expect(pool.connect).not.toHaveBeenCalled();
    });
});

describe('RdsRepoActivityStore.getMeasuredPerf', () => {
    it('returns measured metrics for a sha', async () => {
        const rows = [{ commit_sha: 'abc', metric_name: 'p95_latency_ms', value: '400', unit: 'ms', source: 'ci-benchmark', measured_at: '2026-02-01T00:00:00Z' }];
        const client = {
            queries: [] as { sql: string; params?: unknown[] }[],
            query: jest.fn(async (sql: string, params?: unknown[]) => {
                client.queries.push({ sql, params });
                if (/FROM repo_commit_perf/.test(sql)) return { rowCount: 1, rows };
                return { rowCount: 0, rows: [] };
            }),
            release: jest.fn(),
        };
        const pool = { client, connect: jest.fn(async () => client) };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = new RdsRepoActivityStore(pool as any);
        const out = await store.getMeasuredPerf('user-1', 'o/r', 'abc');
        expect(out).toEqual([
            { commitSha: 'abc', metricName: 'p95_latency_ms', value: 400, unit: 'ms', source: 'ci-benchmark', measuredAt: '2026-02-01T00:00:00Z' },
        ]);
    });
});

describe('RdsRepoActivityStore.getFileChanges', () => {
    it('returns the per-file change history for a path, newest first', async () => {
        const rows = [
            { commit_sha: 'abc', status: 'modified', additions: 8, deletions: 3, changes: 11,
              patch: '@@', patch_truncated: false, authored_at: '2026-01-02T00:00:00Z', message: 'tune' },
        ];
        const client = {
            queries: [] as { sql: string; params?: unknown[] }[],
            query: jest.fn(async (sql: string, params?: unknown[]) => {
                client.queries.push({ sql, params });
                if (/FROM repo_commit_files/.test(sql)) return { rowCount: 1, rows };
                return { rowCount: 0, rows: [] };
            }),
            release: jest.fn(),
        };
        const pool = { client, connect: jest.fn(async () => client) };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = new RdsRepoActivityStore(pool as any);

        const out = await store.getFileChanges('user-1', 'o/r', 'src/a.ts', 10);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ commitSha: 'abc', status: 'modified', additions: 8, message: 'tune' });
        const sel = client.queries.find(q => /FROM repo_commit_files/.test(q.sql))!;
        expect(sel.params).toEqual(expect.arrayContaining(['src/a.ts', 10]));
    });
});

describe('RdsRepoActivityStore.selectShasMissingStats', () => {
    it('returns only the candidate shas that have no stats yet', async () => {
        const client = {
            queries: [] as { sql: string; params?: unknown[] }[],
            query: jest.fn(async (sql: string, params?: unknown[]) => {
                client.queries.push({ sql, params });
                if (/SELECT sha/.test(sql)) return { rowCount: 1, rows: [{ sha: 'need1' }] };
                return { rowCount: 0, rows: [] };
            }),
            release: jest.fn(),
        };
        const pool = { client, connect: jest.fn(async () => client) };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = new RdsRepoActivityStore(pool as any);

        const missing = await store.selectShasMissingStats('user-1', 'o/r', ['need1', 'have1']);
        expect(missing).toEqual(['need1']);
        const sel = client.queries.find(q => /SELECT sha/.test(q.sql))!;
        expect(sel.params).toEqual(expect.arrayContaining([['need1', 'have1']]));
    });
});
