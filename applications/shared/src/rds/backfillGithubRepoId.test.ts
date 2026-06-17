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

/** Fake pool: serves the repositories SELECT, records every other query. */
function fakePool(repoRows: Array<{ user_id: string; full_name: string }>) {
    const calls: Call[] = [];
    return {
        calls,
        query: jest.fn(async (sql: string, params?: unknown[]) => {
            calls.push({ sql, params: params ?? [] });
            if (/SELECT[\s\S]*FROM repositories/.test(sql)) {
                return { rows: repoRows };
            }
            return { rows: [] };
        }),
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

        // Anchor UPDATE carries the resolved id AND the refreshed (current) name,
        // matched on the OLD name.
        const anchor = pool.calls.find(c => /UPDATE repositories\b/.test(c.sql));
        expect(anchor).toBeDefined();
        expect(anchor!.params).toEqual([555, 'o/new', 'u1', 'o/old']);
        expect(anchor!.sql).toMatch(/github_repo_id\s*=\s*\$1/);
        expect(anchor!.sql).toMatch(/full_name\s*=\s*\$2/);

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
        // No anchor UPDATE was issued for the unresolved repo.
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
