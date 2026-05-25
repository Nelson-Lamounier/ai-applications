/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { OntologySkippedImportRepository } from './OntologySkippedImportRepository.js';

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

describe('OntologySkippedImportRepository', () => {
    it('add inserts into ontology_skipped_imports with ON CONFLICT (raw_name, ecosystem) DO NOTHING', async () => {
        const pool = fakePool();
        await new OntologySkippedImportRepository(pool as never).add({
            rawName: 'left-pad',
            ecosystem: 'npm',
            source: 'npm_top_5k',
            llmDecision: 'skip',
            llmReasoning: 'trivial utility, not a technology',
            llmRunId: 'run-123',
        });
        expect(pool.calls[0].sql).toContain('INSERT INTO ontology_skipped_imports');
        expect(pool.calls[0].sql).toContain('ON CONFLICT (raw_name, ecosystem) DO NOTHING');
        expect(pool.calls[0].params).toEqual(
            expect.arrayContaining(['left-pad', 'npm', 'npm_top_5k']),
        );
    });

    it('add tolerates missing optional fields', async () => {
        const pool = fakePool();
        await new OntologySkippedImportRepository(pool as never).add({
            rawName: 'is-odd',
            ecosystem: 'npm',
            source: 'npm_top_5k',
            llmDecision: 'skip',
        });
        expect(pool.calls[0].params).toEqual(
            expect.arrayContaining(['is-odd', 'npm', 'npm_top_5k', 'skip']),
        );
    });
});
