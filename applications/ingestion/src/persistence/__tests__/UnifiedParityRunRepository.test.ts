/** @format */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Pool, PoolClient } from 'pg';

import { UnifiedParityRunRepository } from '../UnifiedParityRunRepository.js';
import type { LayerParity } from '../../facts/parity/layer-parity.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(): { client: PoolClient; query: jest.Mock } {
    const query = jest.fn<() => Promise<{ rows: unknown[] }>>().mockResolvedValue({ rows: [] });
    const client = { query, release: jest.fn() } as unknown as PoolClient;
    return { client, query };
}

function makePool(client: PoolClient): Pool {
    return { connect: jest.fn<() => Promise<PoolClient>>().mockResolvedValue(client) } as unknown as Pool;
}

function row(over: Partial<LayerParity> = {}): LayerParity {
    return {
        sourceLayer:         'treesitter',
        legacyCount:         3,
        unifiedCount:        3,
        intersectionCount:   3,
        legacyOnlyExamples:  [],
        unifiedOnlyExamples: [],
        ...over,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UnifiedParityRunRepository.insertMany', () => {
    let client: PoolClient;
    let query: jest.Mock;
    let repo: UnifiedParityRunRepository;

    beforeEach(() => {
        const m = makeClient();
        client = m.client;
        query  = m.query;
        repo   = new UnifiedParityRunRepository(makePool(client));
    });

    it('does nothing and never opens a connection when rows is empty', async () => {
        const pool = makePool(client);
        const emptyRepo = new UnifiedParityRunRepository(pool);

        await emptyRepo.insertMany('user-1', 'octo/repo', 'sha123', []);

        expect((pool.connect as jest.Mock)).not.toHaveBeenCalled();
    });

    it('demotes to tucaken_app and stamps set_config with the user id before the insert, inside one BEGIN/COMMIT transaction', async () => {
        await repo.insertMany('user-1', 'octo/repo', 'sha123', [row()]);

        const calls = query.mock.calls as Array<[string, unknown[]?]>;
        const kinds = calls.map(([sql]) => {
            if (/^BEGIN/i.test(sql as string)) return 'BEGIN';
            if (/^SET LOCAL ROLE tucaken_app/i.test(sql as string)) return 'SET_LOCAL_ROLE';
            if (/set_config/.test(sql as string)) return 'set_config';
            if (/INSERT INTO unified_parity_runs/i.test(sql as string)) return 'INSERT';
            if (/^COMMIT/i.test(sql as string)) return 'COMMIT';
            if (/^ROLLBACK/i.test(sql as string)) return 'ROLLBACK';
            return 'OTHER';
        });

        expect(kinds).toEqual(['BEGIN', 'SET_LOCAL_ROLE', 'set_config', 'INSERT', 'COMMIT']);

        const setConfigCall = calls[2];
        expect(setConfigCall[0]).toMatch(/SELECT set_config\('app\.current_user_id', \$1, true\)/);
        expect(setConfigCall[1]).toEqual(['user-1']);
    });

    it('issues one INSERT per row, all inside the same transaction', async () => {
        await repo.insertMany('user-1', 'octo/repo', 'sha123', [
            row({ sourceLayer: 'treesitter' }),
            row({ sourceLayer: 'dockerfile', legacyCount: 1, unifiedCount: 0, intersectionCount: 0 }),
        ]);

        const insertCalls = (query.mock.calls as Array<[string, unknown[]]>).filter(
            ([sql]) => typeof sql === 'string' && /INSERT INTO unified_parity_runs/i.test(sql),
        );
        expect(insertCalls).toHaveLength(2);

        const [firstSql, firstParams] = insertCalls[0];
        expect(firstSql).toMatch(/INSERT INTO unified_parity_runs/i);
        expect(firstParams).toEqual([
            'user-1', 'octo/repo', 'sha123', 'treesitter', 3, 3, 3,
            JSON.stringify([]), JSON.stringify([]),
        ]);

        const [, secondParams] = insertCalls[1];
        expect(secondParams).toEqual([
            'user-1', 'octo/repo', 'sha123', 'dockerfile', 1, 0, 0,
            JSON.stringify([]), JSON.stringify([]),
        ]);
    });

    it('serialises the example arrays as JSON for the JSONB columns', async () => {
        await repo.insertMany('user-1', 'octo/repo', 'sha123', [
            row({ legacyOnlyExamples: ['a b'], unifiedOnlyExamples: ['c d'] }),
        ]);

        const [, params] = (query.mock.calls as Array<[string, unknown[]]>).find(
            ([sql]) => typeof sql === 'string' && /INSERT INTO unified_parity_runs/i.test(sql),
        )!;
        expect(params[7]).toBe(JSON.stringify(['a b']));
        expect(params[8]).toBe(JSON.stringify(['c d']));
    });

    it('rolls back and rethrows when an INSERT fails', async () => {
        query.mockImplementation(async (sql: unknown) => {
            if (typeof sql === 'string' && /INSERT INTO unified_parity_runs/i.test(sql)) {
                throw new Error('boom');
            }
            return { rows: [] };
        });

        await expect(repo.insertMany('user-1', 'octo/repo', 'sha123', [row()])).rejects.toThrow('boom');

        const kinds = (query.mock.calls as Array<[string]>).map(([sql]) => sql);
        expect(kinds.some((sql) => /^ROLLBACK/i.test(sql))).toBe(true);
    });

    it('releases the client even when the transaction fails', async () => {
        const releaseSpy = client.release as jest.Mock;
        query.mockImplementation(async (sql: unknown) => {
            if (typeof sql === 'string' && /INSERT INTO unified_parity_runs/i.test(sql)) {
                throw new Error('boom');
            }
            return { rows: [] };
        });

        await expect(repo.insertMany('user-1', 'octo/repo', 'sha123', [row()])).rejects.toThrow();
        expect(releaseSpy).toHaveBeenCalledTimes(1);
    });
});
