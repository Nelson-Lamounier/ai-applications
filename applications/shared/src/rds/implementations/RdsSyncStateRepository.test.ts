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
        (repo as any).pool = pool;
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
        (repo as any).pool = pool;
        await repo.markComplete('u1', 'owner/repo', 1, 1, 0.5, { version: 1 });
        const upsert = pool.calls.find(c => c.sql.includes('INSERT INTO repo_sync_state'))!;
        expect(upsert.params.slice(-2)).toEqual([null, null]);
    });
});
