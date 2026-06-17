/**
 * @format
 * backfillGithubRepoId — unit tests via fake pg Pool + fake resolve-by-name adapter.
 *
 * The fake pool records every SQL + params so we can assert the anchor
 * `repositories` UPDATE carries the resolved id + refreshed name, and that the
 * denormalised label tables are propagated. A 404 (RepoNotFoundError) is
 * recorded as `unresolved` and does not fail the run.
 */

import { describe, it, expect, jest } from '@jest/globals';

import { backfillGithubRepoId } from './backfillGithubRepoId.js';
import { RepoNotFoundError } from '../ingestion/implementations/github-errors.js';

interface Call { sql: string; params: unknown[] }

/**
 * Fake pool: serves the repositories SELECT on `pool.query`, and hands out a
 * fake client via `pool.connect()` whose `.query` records the transaction
 * (BEGIN/COMMIT/ROLLBACK + every UPDATE) into the SAME `calls` array, with a
 * no-op `.release()`. Propagation now runs on the client, so the per-repo
 * UPDATEs land in `client.calls`, while the recovery SELECT stays on the pool.
 */
function fakePool(repoRows: Array<{ user_id: string; full_name: string }>) {
    const calls: Call[] = [];
    const record = jest.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        if (/SELECT[\s\S]*FROM repositories/.test(sql)) {
            return { rows: repoRows };
        }
        return { rows: [] };
    });
    const release = jest.fn(() => undefined);
    return {
        calls,
        release,
        query: record,
        connect: jest.fn(async () => ({ query: record, release })),
    };
}

/** Fake adapter exposing only resolveByName. */
function fakeAdapter(
    impl: (fullName: string) => Promise<{ id: number; fullName: string; defaultBranch: string }>,
) {
    return { resolveByName: jest.fn(impl) };
}

describe('backfillGithubRepoId', () => {
    it('resolves each repo, sets the id + refreshed name on the anchor and propagates to label tables', async () => {
        const pool = fakePool([{ user_id: 'u1', full_name: 'o/old' }]);
        const adapter = fakeAdapter(async () => ({ id: 555, fullName: 'o/new', defaultBranch: 'main' }));

        const res = await backfillGithubRepoId({ pool: pool as never, adapter: adapter as never });

        expect(res.resolved).toBe(1);
        expect(res.unresolved).toEqual([]);
        expect(adapter.resolveByName).toHaveBeenCalledWith('o/old');

        // Propagation runs in a transaction: a BEGIN was issued before the
        // writes and a COMMIT after them.
        const sqls = pool.calls.map(c => c.sql);
        const beginIdx  = sqls.findIndex(s => /^\s*BEGIN\b/.test(s));
        const commitIdx = sqls.findIndex(s => /^\s*COMMIT\b/.test(s));
        expect(beginIdx).toBeGreaterThanOrEqual(0);
        expect(commitIdx).toBeGreaterThan(beginIdx);

        // Anchor UPDATE carries the resolved id AND the refreshed (current) name,
        // matched on the OLD name, and is now guarded by `github_repo_id IS NULL`.
        const anchorIdx = sqls.findIndex(s => /UPDATE repositories\b/.test(s));
        const anchor = pool.calls[anchorIdx];
        expect(anchor).toBeDefined();
        expect(anchor.params).toEqual([555, 'o/new', 'u1', 'o/old']);
        expect(anchor.sql).toMatch(/github_repo_id\s*=\s*\$1/);
        expect(anchor.sql).toMatch(/full_name\s*=\s*\$2/);
        expect(anchor.sql).toMatch(/github_repo_id IS NULL/);
        // Anchor is issued LAST (after BEGIN, before COMMIT).
        expect(anchorIdx).toBeGreaterThan(beginIdx);
        expect(anchorIdx).toBeLessThan(commitIdx);

        // At least one denormalised label-table UPDATE was issued, guarded by
        // `github_repo_id IS NULL` so re-runs are no-ops.
        const labelUpdates = pool.calls.filter(
            c => /UPDATE \w+ SET github_repo_id = \$1, repo_full_name = \$2/.test(c.sql),
        );
        expect(labelUpdates.length).toBeGreaterThan(0);
        for (const u of labelUpdates) {
            expect(u.sql).toMatch(/github_repo_id IS NULL/);
            expect(u.params).toEqual([555, 'o/new', 'u1', 'o/old']);
        }

        // prompt_invocations uses repo_name, not repo_full_name.
        const promptUpdate = pool.calls.find(c => /UPDATE prompt_invocations\b/.test(c.sql));
        expect(promptUpdate).toBeDefined();
        expect(promptUpdate!.sql).toMatch(/repo_name = \$2/);
        expect(promptUpdate!.sql).toMatch(/github_repo_id IS NULL/);
    });

    it('flags a 404 repo as unresolved and continues without failing', async () => {
        const pool = fakePool([{ user_id: 'u1', full_name: 'o/gone' }]);
        const adapter = fakeAdapter(async () => {
            throw new RepoNotFoundError('/repos/o/gone');
        });

        const res = await backfillGithubRepoId({ pool: pool as never, adapter: adapter as never });

        expect(res.resolved).toBe(0);
        expect(res.unresolved).toEqual([{ userId: 'u1', fullName: 'o/gone' }]);
        // No transaction was opened and no anchor UPDATE was issued for the
        // unresolved repo — resolution is attempted before any BEGIN.
        expect(pool.connect).not.toHaveBeenCalled();
        expect(pool.calls.some(c => /^\s*BEGIN\b/.test(c.sql))).toBe(false);
        expect(pool.calls.some(c => /UPDATE repositories\b/.test(c.sql))).toBe(false);
    });

    it('rethrows on a non-404 error (fail loudly)', async () => {
        const pool = fakePool([{ user_id: 'u1', full_name: 'o/r' }]);
        const adapter = fakeAdapter(async () => {
            throw new Error('rate limited');
        });

        await expect(
            backfillGithubRepoId({ pool: pool as never, adapter: adapter as never }),
        ).rejects.toThrow(/rate limited/);
    });
});
