/** @format */
import { reenrichSkippedChunks } from './reenrichSkippedChunks.js';
import type { Pool } from 'pg';
import type { IChunkEnricher } from '@bedrock/shared';

function makePool(skippedRows: Array<{ id: string; file_path: string; heading: string | null; content: string }>) {
    const updates: Array<{ skills: string[]; id: string }> = [];
    const query = jest.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT')) return { rows: skippedRows };
        if (sql.includes('UPDATE')) {
            updates.push({ skills: params?.[0] as string[], id: params?.[1] as string });
            return { rows: [] };
        }
        return { rows: [] };
    });
    return { pool: { query } as unknown as Pool, query, updates };
}

const rows = [
    { id: 'a', file_path: 'src/x.ts', heading: 'X', content: 'uses kubernetes networking' },
    { id: 'b', file_path: 'src/y.ts', heading: null, content: 'cdk stack' },
];

describe('reenrichSkippedChunks', () => {
    it('enriches each skipped chunk and flips status to ok', async () => {
        const { pool, query, updates } = makePool(rows);
        const enricher: IChunkEnricher = {
            enrich: jest.fn(async () => ({ skills: ['kubernetes networking'], technologies: [] })),
        };

        const result = await reenrichSkippedChunks(pool, enricher, { userId: 'u1', concurrency: 1 });

        expect(result).toEqual({ candidates: 2, enriched: 2, failed: 0 });
        expect((enricher.enrich as jest.Mock)).toHaveBeenCalledTimes(2);
        expect(updates).toHaveLength(2);
        expect(updates[0]).toEqual({ skills: ['kubernetes networking'], id: 'a' });
        // SELECT scoped to the user, status filter present
        const selectSql = query.mock.calls[0][0] as string;
        expect(selectSql).toMatch(/enrichment_status' IN \('skipped_quota', 'pending'\)/);
        expect(selectSql).toMatch(/user_id = \$1::uuid/);
        // UPDATE flips status to ok via jsonb_set
        const updateSql = query.mock.calls.find(c => (c[0] as string).includes('UPDATE'))?.[0] as string;
        expect(updateSql).toMatch(/jsonb_set/);
        expect(updateSql).toMatch(/"ok"/);
    });

    it('counts enricher failures and leaves those rows untouched (retryable)', async () => {
        const { pool, updates } = makePool(rows);
        const enricher: IChunkEnricher = {
            enrich: jest.fn()
                .mockResolvedValueOnce({ skills: ['cdk'], technologies: [] })
                .mockRejectedValueOnce(new Error('throttled')),
        };

        const result = await reenrichSkippedChunks(pool, enricher, { concurrency: 1 });

        expect(result.candidates).toBe(2);
        expect(result.enriched).toBe(1);
        expect(result.failed).toBe(1);
        expect(updates).toHaveLength(1); // only the successful one updated
    });

    it('applies a limit clause when provided', async () => {
        const { pool, query } = makePool(rows);
        const enricher: IChunkEnricher = { enrich: jest.fn(async () => ({ skills: [], technologies: [] })) };
        await reenrichSkippedChunks(pool, enricher, { limit: 50 });
        expect(query.mock.calls[0][0] as string).toMatch(/LIMIT 50/);
    });
});
