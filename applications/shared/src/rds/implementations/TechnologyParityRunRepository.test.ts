/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { TechnologyParityRunRepository } from './TechnologyParityRunRepository.js';
import type { ParityRunRow } from '../types/techgraph.js';

function fakeClient() {
    const calls: { sql: string; params?: unknown[] }[] = [];
    return {
        calls,
        query: jest.fn(async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return { rows: [] }; }),
        release: jest.fn(),
    };
}
function fakePool(client: ReturnType<typeof fakeClient>) {
    return { connect: jest.fn(async () => client) };
}

const run: ParityRunRow = {
    userId: 'u1', repoFullName: 'o/r', commitSha: 'abc', ontologyVersion: 5,
    l1CanonicalCount: 10, llmCanonicalCount: 9, llmUnresolvableCount: 2,
    intersectionCount: 8, recall: 0.888,
    l1OnlyExamples: ['pgvector', 'helm'], llmOnlyExamples: ['kafka'],
};

describe('TechnologyParityRunRepository.insert', () => {
    it('sets RLS user and inserts the parity run with jsonb examples', async () => {
        const client = fakeClient();
        const repo = new TechnologyParityRunRepository(fakePool(client) as never);
        await repo.insert(run);
        const sqls = client.calls.map(c => c.sql).join('\n');
        expect(sqls).toContain("set_config('app.current_user_id'");
        const insert = client.calls.find(c => c.sql.includes('INSERT INTO technology_parity_runs'))!;
        expect(insert.sql).toContain('llm_only_examples');
        expect(insert.params!.some(p => typeof p === 'string' && p.includes('kafka'))).toBe(true);
        expect(insert.params).toContain(0.888);
    });
});
