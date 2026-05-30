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

    it('findPendingBatches() selects partial runs with a batch id and camelCases the mapping', async () => {
        const pool = fakePool([{ id: 'run-1', source: 'npm_top_5k', llm_batch_id: 'batch-abc' }]);
        const repo = new OntologyImportRunRepository(pool as never);
        const pending = await repo.findPendingBatches();
        expect(pending).toEqual([{ id: 'run-1', source: 'npm_top_5k', llmBatchId: 'batch-abc', recordMap: {}, runKey: '' }]);
        const u = pool.calls[0];
        expect(u.sql).toContain("status = 'partial'");
        expect(u.sql).toContain('llm_batch_id IS NOT NULL');
    });

    it('recordBatchRun inserts a partial pooled run with jobArn + recordMap + runKey in notes', async () => {
        const pool = fakePool([{ id: 'batch-run-1' }]);
        const repo = new OntologyImportRunRepository(pool as never);
        const map = { r0000001: { ecosystem: 'npm', identifier: 'fastify' } };
        const id = await repo.recordBatchRun('pooled_llm_batch', 'cronjob', 'arn:job:1', map, 'import_123');
        expect(id).toBe('batch-run-1');
        const sql = pool.calls[0].sql;
        expect(sql).toContain('INSERT INTO ontology_import_runs');
        expect(sql).toContain("'partial'");
        const params = pool.calls[0].params!;
        expect(params).toEqual(expect.arrayContaining(['pooled_llm_batch', 'cronjob', 'arn:job:1']));
        const notesJson = params.find((p) => typeof p === 'string' && p.includes('fastify')) as string;
        expect(notesJson).toContain('import_123');
        expect(JSON.parse(notesJson)).toEqual({ recordMap: map, runKey: 'import_123' });
    });

    it('findPendingBatches returns recordMap + runKey parsed from notes', async () => {
        const pool = fakePool([{ id: 'b1', source: 'pooled_llm_batch', llm_batch_id: 'arn:job:1', notes: { recordMap: { r0000001: { ecosystem: 'npm', identifier: 'fastify' } }, runKey: 'import_123' } }]);
        const repo = new OntologyImportRunRepository(pool as never);
        const pending = await repo.findPendingBatches();
        expect(pending[0]).toMatchObject({ id: 'b1', source: 'pooled_llm_batch', llmBatchId: 'arn:job:1', runKey: 'import_123' });
        expect(pending[0].recordMap).toEqual({ r0000001: { ecosystem: 'npm', identifier: 'fastify' } });
    });
});
