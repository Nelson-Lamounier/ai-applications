/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { RdsRepoFileStateRepository } from './RdsRepoFileStateRepository.js';
import type { RepoFileEntry } from './RdsRepoFileStateRepository.js';

interface RecordedQuery {
    sql: string;
    params?: unknown[];
}

function fakePool(opts: { throwOn?: RegExp; selectRows?: Array<{ file_path: string; blob_sha: string }> } = {}) {
    const queries: RecordedQuery[] = [];
    const client = {
        queries,
        query: jest.fn(async (sql: string, params?: unknown[]) => {
            queries.push({ sql, params });
            if (opts.throwOn && opts.throwOn.test(sql)) {
                throw new Error('query failed');
            }
            if (/SELECT file_path, blob_sha FROM repo_file_state/.test(sql)) {
                return { rowCount: opts.selectRows?.length ?? 0, rows: opts.selectRows ?? [] };
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

const files: RepoFileEntry[] = [
    { path: 'src/index.ts', blobSha: 'sha-a', sizeBytes: 100 },
    { path: 'README.md', blobSha: 'sha-b', sizeBytes: 200 },
];

describe('RdsRepoFileStateRepository', () => {
    it('getFileState() returns a Map of path->blob_sha scoped by user_id and repo_full_name', async () => {
        const pool = fakePool({
            selectRows: [
                { file_path: 'src/index.ts', blob_sha: 'sha-a' },
                { file_path: 'README.md', blob_sha: 'sha-b' },
            ],
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const repo = new RdsRepoFileStateRepository(pool as any);

        const result = await repo.getFileState('user-1', 'owner/repo');

        expect(result).toBeInstanceOf(Map);
        expect(result.get('src/index.ts')).toBe('sha-a');
        expect(result.get('README.md')).toBe('sha-b');
        expect(result.size).toBe(2);

        const select = pool.client.queries.find(q => /SELECT file_path, blob_sha FROM repo_file_state/.test(q.sql));
        expect(select).toBeDefined();
        expect(select!.sql).toMatch(/user_id = \$1 AND repo_full_name = \$2/);
        expect(select!.params).toEqual(['user-1', 'owner/repo']);

        const sqls = pool.client.queries.map(q => q.sql);
        expect(sqls.some(s => /set_config\('app.current_user_id'/.test(s))).toBe(true);
        expect(sqls).toContain('COMMIT');
    });

    it('getFileState() returns an empty Map when no rows', async () => {
        const pool = fakePool({ selectRows: [] });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const repo = new RdsRepoFileStateRepository(pool as any);

        const result = await repo.getFileState('user-1', 'owner/repo');

        expect(result).toBeInstanceOf(Map);
        expect(result.size).toBe(0);
    });

    it('upsertFileState() with files deletes then inserts and commits', async () => {
        const pool = fakePool();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const repo = new RdsRepoFileStateRepository(pool as any);

        await repo.upsertFileState('user-1', 'owner/repo', files);

        const sqls = pool.client.queries.map(q => q.sql);
        expect(sqls.some(s => /set_config\('app.current_user_id'/.test(s))).toBe(true);
        expect(sqls.some(s => /DELETE FROM repo_file_state/.test(s))).toBe(true);
        expect(sqls.some(s => /INSERT INTO repo_file_state/.test(s))).toBe(true);
        expect(sqls).toContain('COMMIT');
    });

    it('upsertFileState() dual-writes the injected github_repo_id (6 params/row)', async () => {
        const pool = fakePool();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const repo = new RdsRepoFileStateRepository(pool as any, 4242);

        await repo.upsertFileState('user-1', 'owner/repo', files);

        const insert = pool.client.queries.find(q => /INSERT INTO repo_file_state/.test(q.sql))!;
        expect(insert.sql).toMatch(/github_repo_id/);
        // 6 params/file × 2 files; github_repo_id is each tuple's 6th.
        expect(insert.params).toHaveLength(12);
        expect(insert.params![5]).toBe(4242);
        expect(insert.params![11]).toBe(4242);
    });

    it('upsertFileState() binds null github_repo_id on a pre-backfill run', async () => {
        const pool = fakePool();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const repo = new RdsRepoFileStateRepository(pool as any);

        await repo.upsertFileState('user-1', 'owner/repo', files);

        const insert = pool.client.queries.find(q => /INSERT INTO repo_file_state/.test(q.sql))!;
        expect(insert.params![5]).toBeNull();
    });

    it('upsertFileState() with an empty array deletes but does not insert', async () => {
        const pool = fakePool();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const repo = new RdsRepoFileStateRepository(pool as any);

        await repo.upsertFileState('user-1', 'owner/repo', []);

        const sqls = pool.client.queries.map(q => q.sql);
        expect(sqls.some(s => /DELETE FROM repo_file_state/.test(s))).toBe(true);
        expect(sqls.some(s => /INSERT INTO repo_file_state/.test(s))).toBe(false);
        expect(sqls).toContain('COMMIT');
    });

    it('deleteFileState() issues a DELETE scoped by user and repo', async () => {
        const pool = fakePool();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const repo = new RdsRepoFileStateRepository(pool as any);

        await repo.deleteFileState('user-1', 'owner/repo');

        const sqls = pool.client.queries.map(q => q.sql);
        expect(sqls.some(s => /DELETE FROM repo_file_state/.test(s))).toBe(true);
        expect(sqls).toContain('COMMIT');
    });

    it('upsertFileState() rolls back and rethrows when the insert fails', async () => {
        const pool = fakePool({ throwOn: /INSERT INTO repo_file_state/ });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const repo = new RdsRepoFileStateRepository(pool as any);

        await expect(
            repo.upsertFileState('user-1', 'owner/repo', files),
        ).rejects.toThrow('query failed');

        const sqls = pool.client.queries.map(q => q.sql);
        expect(sqls).toContain('ROLLBACK');
    });
});
