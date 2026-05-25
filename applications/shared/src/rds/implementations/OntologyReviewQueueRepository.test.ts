/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { OntologyReviewQueueRepository } from './OntologyReviewQueueRepository.js';

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

describe('OntologyReviewQueueRepository', () => {
    it('add inserts into ontology_review_queue with ON CONFLICT (raw_name, ecosystem) DO NOTHING', async () => {
        const pool = fakePool();
        await new OntologyReviewQueueRepository(pool as never).add({
            rawName: 'fastify',
            ecosystem: 'npm',
            source: 'npm_top_5k',
            reason: 'llm_maybe',
            suggestedCategory: 'framework_web',
            llmReasoning: 'looks like a web framework',
        });
        expect(pool.calls[0].sql).toContain('INSERT INTO ontology_review_queue');
        expect(pool.calls[0].sql).toContain('ON CONFLICT (raw_name, ecosystem) DO NOTHING');
        expect(pool.calls[0].params).toEqual(
            expect.arrayContaining(['fastify', 'npm', 'npm_top_5k']),
        );
    });

    it('add tolerates missing optional fields', async () => {
        const pool = fakePool();
        await new OntologyReviewQueueRepository(pool as never).add({
            rawName: 'mystery',
            ecosystem: 'pypi',
            source: 'pypi_top',
            reason: 'uncategorized',
        });
        expect(pool.calls[0].params).toEqual(
            expect.arrayContaining(['mystery', 'pypi', 'pypi_top', 'uncategorized']),
        );
    });
});
