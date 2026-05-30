/**
 * @format
 * runBackfill — unit tests via fake pg Pool + fake KmsEnvelope.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { runBackfill } from './backfillOAuthTokenEnvelope.js';
import type { KmsEnvelope } from '../crypto/index.js';

interface Call { sql: string; params: unknown[] }

function fakeClient(updateLog: Call[]) {
    return {
        query: jest.fn(async (sql: string, params?: unknown[]) => {
            updateLog.push({ sql, params: params ?? [] });
            return { rows: [] };
        }),
        release: jest.fn(),
    };
}

/**
 * Fake pool that returns a fixed sequence of SELECT result sets and serves
 * a single client for the transactional UPDATEs.
 */
function fakePool(selectBatches: Array<Array<{ id: string; user_id: string; provider: string; access_token_enc: string }>>) {
    const updates: Call[] = [];
    let i = 0;
    const client = fakeClient(updates);
    return {
        updates,
        client,
        connect: jest.fn(async () => client),
        query: jest.fn(async (sql: string) => {
            if (sql.includes('SELECT id')) {
                return { rows: selectBatches[i++] ?? [] };
            }
            return { rows: [] };
        }),
    };
}

function fakeEnvelope(): KmsEnvelope & { calls: Array<{ pt: string; ctx?: Record<string,string> }> } {
    const calls: Array<{ pt: string; ctx?: Record<string,string> }> = [];
    return {
        calls,
        async encrypt(pt, ctx) {
            calls.push({ pt, ctx });
            return {
                ciphertext: Buffer.from(`ct:${pt}`),
                dek:        Buffer.from('dek'),
                iv:         Buffer.alloc(12, 1),
                tag:        Buffer.alloc(16, 2),
            };
        },
        async decrypt() { throw new Error('decrypt not used in backfill'); },
    };
}

describe('runBackfill', () => {
    it('encrypts and updates every plaintext row across batches', async () => {
        const pool = fakePool([
            [
                { id: 'r1', user_id: 'u1', provider: 'github', access_token_enc: 'tok-1' },
                { id: 'r2', user_id: 'u2', provider: 'github', access_token_enc: 'tok-2' },
            ],
            [
                { id: 'r3', user_id: 'u3', provider: 'github', access_token_enc: 'tok-3' },
            ],
            [], // sentinel — empty stops the loop
        ]);
        const env = fakeEnvelope();
        const res = await runBackfill({ pool: pool as never, envelope: env, batchSize: 2 });

        expect(res).toEqual({ encrypted: 3, batches: 2 });
        expect(env.calls.map(c => c.pt)).toEqual(['tok-1', 'tok-2', 'tok-3']);
        expect(env.calls[0]!.ctx).toEqual({ user_id: 'u1', provider: 'github' });

        // BEGIN / 3×UPDATE / COMMIT per batch — total 3 UPDATEs across 2 batches.
        const updates = pool.updates.filter(c => c.sql.includes('UPDATE oauth_connections'));
        expect(updates).toHaveLength(3);
        // Each UPDATE re-checks ciphertext IS NULL (race-safe + idempotent).
        for (const u of updates) {
            expect(u.sql).toMatch(/access_token_ciphertext IS NULL/);
        }
        // The BEGIN/COMMIT bookends are present.
        expect(pool.updates.some(c => c.sql === 'BEGIN')).toBe(true);
        expect(pool.updates.some(c => c.sql === 'COMMIT')).toBe(true);
    });

    it('is a no-op when no plaintext rows remain', async () => {
        const pool = fakePool([[]]);
        const env = fakeEnvelope();
        const res = await runBackfill({ pool: pool as never, envelope: env, batchSize: 100 });
        expect(res).toEqual({ encrypted: 0, batches: 0 });
        expect(env.calls).toHaveLength(0);
    });

    it('rolls back and rethrows on encrypt failure', async () => {
        const pool = fakePool([[
            { id: 'r1', user_id: 'u1', provider: 'github', access_token_enc: 'tok-1' },
        ]]);
        const env: KmsEnvelope = {
            async encrypt() { throw new Error('boom'); },
            async decrypt() { throw new Error('unused'); },
        };
        await expect(runBackfill({ pool: pool as never, envelope: env, batchSize: 1 })).rejects.toThrow(/boom/);
        expect(pool.updates.some(c => c.sql === 'ROLLBACK')).toBe(true);
        expect(pool.updates.some(c => c.sql === 'COMMIT')).toBe(false);
    });
});
