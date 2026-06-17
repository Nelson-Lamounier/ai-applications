/**
 * @format
 * reconcileRepoName — unit tests via a fake pg Pool.
 *
 * The fake pool answers the anchor `full_name` SELECT on `pool.query`, and hands
 * out a recording client via `pool.connect()` whose `.query` captures the
 * transaction (BEGIN/COMMIT/ROLLBACK + every UPDATE). We assert that:
 *   - a real rename re-stamps the anchor + label tables inside a transaction;
 *   - an already-current label is an idempotent no-op (no connect/BEGIN/UPDATE);
 *   - an unknown repo (empty SELECT) is a no-op.
 */

import { describe, it, expect, jest } from '@jest/globals';

import { reconcileRepoName } from './reconcileRepoName.js';

interface Call { sql: string; params: unknown[] }

/**
 * Fake pool: serves the anchor SELECT on `pool.query` from `selectRows`, hands a
 * recording client via `pool.connect()`. Client + pool SQL land in `calls`.
 */
function fakePool(selectRows: Array<{ full_name: string }>) {
    const calls: Call[] = [];
    const connect = jest.fn();
    const record = jest.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        if (/SELECT full_name FROM repositories/.test(sql)) {
            return { rows: selectRows };
        }
        return { rows: [] };
    });
    const release = jest.fn(() => undefined);
    connect.mockImplementation(async () => ({ query: record, release }));
    return {
        calls,
        release,
        connect,
        query: record,
    };
}

describe('reconcileRepoName', () => {
    it('renames the anchor + label tables inside a transaction when the name changed', async () => {
        const pool = fakePool([{ full_name: 'o/old' }]);

        await reconcileRepoName(pool as never, 'u1', 555, 'o/new');

        const sqls = pool.calls.map(c => c.sql);

        // A transaction was opened and committed.
        const beginIdx  = sqls.findIndex(s => /^\s*BEGIN\b/.test(s));
        const commitIdx = sqls.findIndex(s => /^\s*COMMIT\b/.test(s));
        expect(beginIdx).toBeGreaterThanOrEqual(0);
        expect(commitIdx).toBeGreaterThan(beginIdx);

        // Anchor UPDATE carries the new name, keyed on (user_id, github_repo_id).
        const anchorIdx = sqls.findIndex(s => /UPDATE repositories SET full_name/.test(s));
        const anchor = pool.calls[anchorIdx];
        expect(anchor).toBeDefined();
        expect(anchor?.params).toEqual(['o/new', 'u1', 555]);
        expect(anchorIdx).toBeGreaterThan(beginIdx);
        expect(anchorIdx).toBeLessThan(commitIdx);

        // At least one denormalised label-table UPDATE was issued with the new name.
        const labelUpdates = pool.calls.filter(
            c => /UPDATE \w+ SET repo_full_name = \$1/.test(c.sql),
        );
        expect(labelUpdates.length).toBeGreaterThan(0);
        for (const u of labelUpdates) {
            expect(u.params).toEqual(['o/new', 'u1', 555]);
        }

        // prompt_invocations is re-stamped via repo_name.
        const promptUpdate = pool.calls.find(c => /UPDATE prompt_invocations SET repo_name = \$1/.test(c.sql));
        expect(promptUpdate?.params).toEqual(['o/new', 'u1', 555]);

        // user_id is bound un-cast (no ::uuid) so the TEXT-keyed tables work too.
        expect(anchor?.sql).not.toMatch(/\$2::uuid/);
    });

    it('is a no-op when the stored name already equals the new name', async () => {
        const pool = fakePool([{ full_name: 'o/new' }]);

        await reconcileRepoName(pool as never, 'u1', 555, 'o/new');

        // Only the SELECT ran — no connection, no BEGIN, no UPDATE.
        expect(pool.connect).not.toHaveBeenCalled();
        const sqls = pool.calls.map(c => c.sql);
        expect(sqls.some(s => /^\s*BEGIN\b/.test(s))).toBe(false);
        expect(sqls.some(s => /UPDATE/.test(s))).toBe(false);
        expect(pool.calls).toHaveLength(1);
    });

    it('is a no-op when the repo is unknown (SELECT returns no row)', async () => {
        const pool = fakePool([]);

        await reconcileRepoName(pool as never, 'u1', 999, 'o/new');

        expect(pool.connect).not.toHaveBeenCalled();
        const sqls = pool.calls.map(c => c.sql);
        expect(sqls.some(s => /UPDATE/.test(s))).toBe(false);
        expect(pool.calls).toHaveLength(1);
    });
});
