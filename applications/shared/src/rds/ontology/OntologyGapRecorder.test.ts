/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import type { Pool } from 'pg';
import { RdsOntologyGapRecorder, NullOntologyGapRecorder } from './OntologyGapRecorder.js';

function poolSpy() {
    const query = jest.fn<(sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>>().mockResolvedValue({ rows: [] });
    return { pool: { query } as unknown as Pick<Pool, 'query'>, query };
}

describe('RdsOntologyGapRecorder', () => {
    const ctx = { userId: '11111111-1111-1111-1111-111111111111', repoFullName: 'a/b', modelId: 'haiku', ontologyVersion: 273 };

    it('flush is a no-op when nothing was recorded', async () => {
        const { pool, query } = poolSpy();
        await new RdsOntologyGapRecorder(pool, ctx).flush();
        expect(query).not.toHaveBeenCalled();
    });

    it('dedups by (kind, phrase) within a run and batch-inserts with context', async () => {
        const { pool, query } = poolSpy();
        const r = new RdsOntologyGapRecorder(pool, ctx);
        r.record({ kind: 'skill', rawPhrase: 'acm' });
        r.record({ kind: 'skill', rawPhrase: 'acm' }); // dup → collapses
        r.record({ kind: 'skill', rawPhrase: 'containerd' });
        await r.flush();

        expect(query).toHaveBeenCalledTimes(1);
        const [, params] = query.mock.calls[0] as [string, unknown[]];
        // 2 distinct phrases × 9 columns
        expect(params).toHaveLength(18);
        // first row: kind, phrase, method default 'raw', null canonical, null sim, then ctx
        expect(params.slice(0, 9)).toEqual(['skill', 'acm', 'raw', null, null, ctx.userId, 'a/b', 'haiku', 273]);
    });

    it('never throws when the insert fails (best-effort capture)', async () => {
        const query = jest.fn<() => Promise<{ rows: unknown[] }>>().mockRejectedValue(new Error('db down'));
        const pool = { query } as unknown as Pick<Pool, 'query'>;
        const r = new RdsOntologyGapRecorder(pool, ctx);
        r.record({ kind: 'skill', rawPhrase: 'x' });
        await expect(r.flush()).resolves.toBeUndefined();
    });

    it('ignores empty/whitespace phrases', async () => {
        const { pool, query } = poolSpy();
        const r = new RdsOntologyGapRecorder(pool, ctx);
        r.record({ kind: 'skill', rawPhrase: '   ' });
        await r.flush();
        expect(query).not.toHaveBeenCalled();
    });
});

describe('NullOntologyGapRecorder', () => {
    it('record + flush are no-ops', async () => {
        const r = new NullOntologyGapRecorder();
        r.record({ kind: 'skill', rawPhrase: 'x' });
        await expect(r.flush()).resolves.toBeUndefined();
    });
});
