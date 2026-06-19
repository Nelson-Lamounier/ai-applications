/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { PhraseSkillResolver } from './PhraseSkillResolver.js';
import type { IEmbeddingProvider } from '../interfaces/IEmbeddingProvider.js';
import type { SkillEmbeddingResolver, SkillMatch } from './SkillEmbeddingResolver.js';

function fakeEmbedder(): IEmbeddingProvider & { calls: number } {
    const e = {
        calls: 0,
        embed: jest.fn(async (t: string) => { e.calls++; return [t.length, 0, 0]; }),
    } as unknown as IEmbeddingProvider & { calls: number };
    return e;
}

function fakeResolver(byVec: (vec: readonly number[]) => SkillMatch | null): SkillEmbeddingResolver {
    return { resolveByVector: jest.fn(async (vec: readonly number[]) => byVec(vec)) } as unknown as SkillEmbeddingResolver;
}

describe('PhraseSkillResolver', () => {
    it('resolves a phrase to its nearest canonical', async () => {
        const embedder = fakeEmbedder();
        const resolver = fakeResolver(() => ({ canonical: 'kubernetes networking', similarity: 0.8 }));
        const pr = new PhraseSkillResolver(embedder, resolver);

        expect(await pr.resolve('k8s net policy')).toBe('kubernetes networking');
    });

    it('returns null when no canonical clears the threshold (raw passthrough is the caller\'s job)', async () => {
        const pr = new PhraseSkillResolver(fakeEmbedder(), fakeResolver(() => null));
        expect(await pr.resolve('some novel bedrock thing')).toBeNull();
    });

    it('memoises: the same phrase embeds + queries only once', async () => {
        const embedder = fakeEmbedder();
        const resolver = fakeResolver(() => ({ canonical: 'iac with cdk', similarity: 0.9 }));
        const pr = new PhraseSkillResolver(embedder, resolver);

        await pr.resolve('cdk stack');
        await pr.resolve('cdk stack');
        await pr.resolve('cdk stack');

        expect(embedder.calls).toBe(1);
        expect(resolver.resolveByVector).toHaveBeenCalledTimes(1);
    });

    it('memoises null results too (never re-queries a known miss)', async () => {
        const embedder = fakeEmbedder();
        const pr = new PhraseSkillResolver(embedder, fakeResolver(() => null));
        await pr.resolve('novel');
        await pr.resolve('novel');
        expect(embedder.calls).toBe(1);
    });
});
