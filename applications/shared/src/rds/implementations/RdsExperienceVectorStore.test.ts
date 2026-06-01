/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { RdsExperienceVectorStore } from './RdsExperienceVectorStore.js';

function fakePool(rows: unknown[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query = jest.fn(async () => ({ rows }));
    return { pool: { query } as any, query };
}

describe('RdsExperienceVectorStore.querySimilar', () => {
    it('maps experience_embeddings rows to SimilarityResult (career source)', async () => {
        const { pool, query } = fakePool([
            { id: 'e1', chunk_type: 'role_description', content: 'Senior SWE at Acme (2020-2024)', similarity: 0.91 },
            { id: 'e2', chunk_type: 'achievement', content: 'Cut deploy time 40%', similarity: 0.82 },
        ]);
        const store = new RdsExperienceVectorStore({ host: 'h', port: 5432, database: 'd', user: 'u', password: 'p' }, pool);
        const out = await store.querySimilar({ userId: 'u1', queryEmbedding: [0.1, 0.2], limit: 10 });
        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({ repoFullName: 'career', filePath: 'role_description', content: 'Senior SWE at Acme (2020-2024)', similarity: 0.91 });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sql = ((query.mock.calls as any)[0][0]) as string;
        expect(sql).toMatch(/FROM experience_embeddings/);
        expect(sql).toMatch(/user_id = \$1/);
    });
    it('returns [] when no rows', async () => {
        const { pool } = fakePool([]);
        const store = new RdsExperienceVectorStore({ host: 'h', port: 5432, database: 'd', user: 'u', password: 'p' }, pool);
        expect(await store.querySimilar({ userId: 'u1', queryEmbedding: [0.1], limit: 5 })).toEqual([]);
    });
});
