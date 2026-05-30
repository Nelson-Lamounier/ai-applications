/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { OntologyWriteRepository } from './OntologyWriteRepository.js';

function fakePool(rows: unknown[] = []) {
    const calls: { sql: string; params?: unknown[] }[] = [];
    return {
        calls,
        query: jest.fn(async (sql: string, params?: unknown[]) => {
            calls.push({ sql, params });
            return { rows, rowCount: rows.length };
        }),
    };
}

describe('OntologyWriteRepository', () => {
    it('findByCanonical returns id+curationLevel or null', async () => {
        const hit = new OntologyWriteRepository(
            fakePool([{ id: 'x', curation_level: 'curated' }]) as never,
        );
        expect(await hit.findByCanonical('react')).toEqual({ id: 'x', curationLevel: 'curated' });
        const miss = new OntologyWriteRepository(fakePool([]) as never);
        expect(await miss.findByCanonical('nope')).toBeNull();
    });

    it('insertAutoImported inserts curation_level auto_imported and returns id', async () => {
        const pool = fakePool([{ id: 'new-1' }]);
        const repo = new OntologyWriteRepository(pool as never);
        const id = await repo.insertAutoImported('fastify', 'Fastify', 'framework_web', 'npm_top_5k');
        expect(id).toBe('new-1');
        expect(pool.calls[0].sql).toContain("'auto_imported'");
        expect(pool.calls[0].params).toEqual(
            expect.arrayContaining(['fastify', 'Fastify', 'framework_web']),
        );
    });

    it('bumpPopularity is additive and only raises', async () => {
        const pool = fakePool();
        await new OntologyWriteRepository(pool as never).bumpPopularity('x', 100);
        expect(pool.calls[0].sql).toContain('popularity_score = GREATEST(popularity_score');
    });

    it('insertAliases inserts each with ON CONFLICT DO NOTHING, returns count', async () => {
        const pool = fakePool([{}, {}]);
        const n = await new OntologyWriteRepository(pool as never).insertAliases(
            'x',
            ['a', 'b'],
            'npm_top_5k',
        );
        expect(pool.calls[0].sql).toContain('INSERT INTO technology_aliases');
        expect(pool.calls[0].sql).toContain('ON CONFLICT (alias) DO NOTHING');
        expect(n).toBeGreaterThanOrEqual(0);
    });
});
