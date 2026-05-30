/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { OntologyImportSourceRepository } from './OntologyImportSourceRepository.js';

function fakePool(result: { rows?: unknown[]; rowCount?: number } = {}) {
    const calls: { sql: string; params?: unknown[] }[] = [];
    return {
        calls,
        query: jest.fn(async (sql: string, params?: unknown[]) => {
            calls.push({ sql, params });
            return { rows: result.rows ?? [], rowCount: result.rowCount };
        }),
    };
}

describe('OntologyImportSourceRepository', () => {
    it('upsertSeen() upserts and resets consecutive_misses on conflict', async () => {
        const pool = fakePool();
        const repo = new OntologyImportSourceRepository(pool as never);
        await repo.upsertSeen('tech-1', 'npm_top_5k', 'react', 0.99, { downloads: 100 });
        const u = pool.calls[0];
        expect(u.sql).toContain('INSERT INTO ontology_import_sources');
        expect(u.sql).toContain('ON CONFLICT (technology_id, source) DO UPDATE');
        expect(u.sql).toContain('consecutive_misses = 0');
        expect(u.params).toEqual(
            expect.arrayContaining(['tech-1', 'npm_top_5k', 'react', 0.99, JSON.stringify({ downloads: 100 })]),
        );
    });

    it('incrementMissesOlderThan() bumps misses and returns rowCount', async () => {
        const runStart = new Date('2026-05-25T00:00:00.000Z');
        const pool = fakePool({ rows: [], rowCount: 7 });
        const repo = new OntologyImportSourceRepository(pool as never);
        const updated = await repo.incrementMissesOlderThan('npm_top_5k', runStart);
        expect(updated).toBe(7);
        const u = pool.calls[0];
        expect(u.sql).toContain('UPDATE ontology_import_sources');
        expect(u.sql).toContain('consecutive_misses = consecutive_misses + 1');
        expect(u.params).toEqual(expect.arrayContaining(['npm_top_5k', runStart.toISOString()]));
    });

    it('deactivateStale() deactivates ontology rows over the miss threshold and returns rowCount', async () => {
        const pool = fakePool({ rows: [], rowCount: 4 });
        const repo = new OntologyImportSourceRepository(pool as never);
        const deactivated = await repo.deactivateStale('npm_top_5k', 3);
        expect(deactivated).toBe(4);
        const u = pool.calls[0];
        expect(u.sql).toContain('UPDATE technology_ontology SET is_active = false');
        expect(u.sql).toContain('SELECT technology_id FROM ontology_import_sources');
        expect(u.sql).toContain('consecutive_misses >= $2');
        expect(u.params).toEqual(['npm_top_5k', 3]);
    });
});
