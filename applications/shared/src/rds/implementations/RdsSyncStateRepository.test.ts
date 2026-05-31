/**
 * @format
 * RdsSyncStateRepository — unit tests
 *
 * Uses a fake pg Pool injected onto the instance to capture SQL + params
 * without touching a real database.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { RdsSyncStateRepository } from './RdsSyncStateRepository.js';

function fakePool() {
    const calls: { sql: string; params: unknown[] }[] = [];
    return {
        calls,
        query: jest.fn(async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return { rows: [] }; }),
        end: jest.fn(),
    };
}

describe('RdsSyncStateRepository retrieval persistence', () => {
    it('writes retrieval_score and retrieval_breakdown via upsert/markComplete', async () => {
        const pool = fakePool();
        const repo = new RdsSyncStateRepository({} as never);
        (repo as unknown as { pool: typeof pool }).pool = pool;
        await repo.markComplete('u1', 'owner/repo', 3, 42, 0.8, { version: 1 }, 0.66, { version: 1, status: 'ok' });
        const upsert = pool.calls.find(c => c.sql.includes('INSERT INTO repo_sync_state'));
        expect(upsert).toBeDefined();
        expect(upsert!.sql).toContain('retrieval_score');
        expect(upsert!.sql).toContain('retrieval_breakdown');
        expect(upsert!.params).toContain(0.66);
        expect(upsert!.params.some(p => typeof p === 'string' && p.includes('"status":"ok"'))).toBe(true);
    });

    it('passes null for both retrieval params when omitted', async () => {
        const pool = fakePool();
        const repo = new RdsSyncStateRepository({} as never);
        (repo as unknown as { pool: typeof pool }).pool = pool;
        await repo.markComplete('u1', 'owner/repo', 1, 1, 0.5, { version: 1 });
        const upsert = pool.calls.find(c => c.sql.includes('INSERT INTO repo_sync_state'))!;
        expect(upsert.params.slice(-2)).toEqual([null, null]);
    });
});

describe('RdsSyncStateRepository.saveArchetypeSignals', () => {
    it('issues a targeted UPDATE of archetype_signals scoped by user_id + repo_full_name', async () => {
        const pool = fakePool();
        const repo = new RdsSyncStateRepository({} as never);
        (repo as unknown as { pool: typeof pool }).pool = pool;

        const signals = { has_ci: true, has_dockerfile: false, has_iac: true };
        await repo.saveArchetypeSignals('u1', 'owner/repo', signals);

        const update = pool.calls.find(c => c.sql.includes('UPDATE repo_sync_state'))!;
        expect(update).toBeDefined();
        expect(update.sql).toContain('archetype_signals');
        expect(update.sql).toContain('WHERE user_id = $1 AND repo_full_name = $2');
        // scoped params + JSON-stringified signals as the third param.
        expect(update.params[0]).toBe('u1');
        expect(update.params[1]).toBe('owner/repo');
        expect(update.params[2]).toBe(JSON.stringify(signals));
    });

    it('is a no-op-safe single UPDATE (mirrors markPhase: plain pool.query, no txn/set_config)', async () => {
        const pool = fakePool();
        const repo = new RdsSyncStateRepository({} as never);
        (repo as unknown as { pool: typeof pool }).pool = pool;

        await repo.saveArchetypeSignals('u1', 'owner/repo', { has_ci: true });

        // markPhase does not BEGIN a txn nor call set_config — neither should this.
        expect(pool.calls).toHaveLength(1);
        expect(pool.calls.some(c => /set_config/i.test(c.sql))).toBe(false);
        expect(pool.calls.some(c => /^\s*begin/i.test(c.sql))).toBe(false);
    });
});
