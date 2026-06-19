/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { backfillSkillEmbeddings } from './backfillSkillEmbeddings.js';
import type { SkillOntologyRepository } from '../implementations/SkillOntologyRepository.js';
import type { IEmbeddingProvider } from '../interfaces/IEmbeddingProvider.js';

/** Repo stub that hands out a fixed queue of batches, then empties. */
function fakeRepo(batches: { id: string; canonicalName: string }[][]) {
    const updates: { id: string; vec: readonly number[] }[] = [];
    let call = 0;
    const repo = {
        loadCanonicalsNeedingEmbedding: jest.fn(async () => batches[call++] ?? []),
        updateEmbedding: jest.fn(async (id: string, vec: readonly number[]) => { updates.push({ id, vec }); }),
    } as unknown as SkillOntologyRepository;
    return { repo, updates };
}

function fakeEmbedder(): IEmbeddingProvider {
    return { embed: jest.fn(async (t: string) => [t.length, 0, 0]) } as unknown as IEmbeddingProvider;
}

describe('backfillSkillEmbeddings', () => {
    it('embeds every unembedded skill and persists each vector, draining batches', async () => {
        const { repo, updates } = fakeRepo([
            [{ id: 'a', canonicalName: 'gitops' }, { id: 'b', canonicalName: 'rest api design' }],
            [{ id: 'c', canonicalName: 'observability' }],
            [], // drained
        ]);
        const n = await backfillSkillEmbeddings(repo, fakeEmbedder(), { batchSize: 2 });

        expect(n).toBe(3);
        expect(updates.map(u => u.id)).toEqual(['a', 'b', 'c']);
        expect(updates[0].vec).toEqual([6, 0, 0]); // 'gitops'.length
    });

    it('stops at the max cap (cost guard) without over-fetching', async () => {
        const { repo, updates } = fakeRepo([
            [{ id: 'a', canonicalName: 'x' }, { id: 'b', canonicalName: 'yy' }],
        ]);
        const n = await backfillSkillEmbeddings(repo, fakeEmbedder(), { batchSize: 5, max: 2 });
        expect(n).toBe(2);
        expect(updates).toHaveLength(2);
        expect(repo.loadCanonicalsNeedingEmbedding).toHaveBeenCalledTimes(1);
    });

    it('no-ops when everything is already embedded', async () => {
        const { repo } = fakeRepo([[]]);
        expect(await backfillSkillEmbeddings(repo, fakeEmbedder())).toBe(0);
    });
});
