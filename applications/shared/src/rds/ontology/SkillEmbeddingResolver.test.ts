/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { SkillEmbeddingResolver } from './SkillEmbeddingResolver.js';

function fakePool(rows: unknown[]) {
    const query = jest.fn(async () => ({ rows }));
    return { pool: { query } as never, query };
}

describe('SkillEmbeddingResolver', () => {
    it('returns the nearest canonical when it clears the threshold', async () => {
        const { pool, query } = fakePool([{ canonical_name: 'aws auto scaling', similarity: 0.89 }]);
        const resolver = new SkillEmbeddingResolver(pool, 0.62);
        const match = await resolver.resolveByVector([0.1, 0.2, 0.3]);

        expect(match).toEqual({ canonical: 'aws auto scaling', similarity: 0.89 });
        const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
        expect(sql).toMatch(/embedding <=> \$1::vector/);          // cosine NN
        expect(sql).toMatch(/1 - \(embedding <=> \$1::vector\)/);   // similarity
        expect(params[0]).toBe('[0.1,0.2,0.3]');                    // vector literal
    });

    it('returns null when the nearest match is below the threshold (keep raw)', async () => {
        const { pool } = fakePool([{ canonical_name: 'docker security', similarity: 0.41 }]);
        const resolver = new SkillEmbeddingResolver(pool, 0.62);
        expect(await resolver.resolveByVector([0.1, 0.2])).toBeNull();
    });

    it('returns null when nothing is embedded yet', async () => {
        const { pool } = fakePool([]);
        const resolver = new SkillEmbeddingResolver(pool);
        expect(await resolver.resolveByVector([0.1, 0.2])).toBeNull();
    });

    it('returns null for an empty query vector without hitting the DB', async () => {
        const { pool, query } = fakePool([]);
        const resolver = new SkillEmbeddingResolver(pool);
        expect(await resolver.resolveByVector([])).toBeNull();
        expect(query).not.toHaveBeenCalled();
    });
});
