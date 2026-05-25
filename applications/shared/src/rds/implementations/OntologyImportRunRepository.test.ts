/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { OntologyImportRunRepository } from './OntologyImportRunRepository.js';

function fakePool(rows: unknown[] = []) {
    const calls: { sql: string; params?: unknown[] }[] = [];
    return {
        calls,
        query: jest.fn(async (sql: string, params?: unknown[]) => {
            calls.push({ sql, params });
            return { rows };
        }),
    };
}

describe('OntologyImportRunRepository', () => {
    it('begin() inserts a running row and returns its id', async () => {
        const pool = fakePool([{ id: 'run-1' }]);
        const repo = new OntologyImportRunRepository(pool as never);
        const id = await repo.begin('npm_top_5k', 'manual');
        expect(id).toBe('run-1');
        expect(pool.calls[0].sql).toContain('INSERT INTO ontology_import_runs');
        expect(pool.calls[0].params).toEqual(expect.arrayContaining(['npm_top_5k', 'manual', 'running']));
    });

    it('finish() updates counts + status', async () => {
        const pool = fakePool();
        const repo = new OntologyImportRunRepository(pool as never);
        await repo.finish('run-1', 'success', {
            entriesFetched: 10, entriesInserted: 4, entriesUpdated: 6, entriesDeactivated: 0,
            aliasMerges: 1, unresolvedCount: 2, reviewQueueAdded: 0,
        });
        const u = pool.calls[0];
        expect(u.sql).toContain('UPDATE ontology_import_runs');
        expect(u.params).toEqual(expect.arrayContaining(['run-1', 'success', 10, 4, 6]));
    });
});
