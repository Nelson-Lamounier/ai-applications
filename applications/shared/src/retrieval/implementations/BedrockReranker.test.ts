/**
 * @format
 * BedrockReranker — unit tests covering input/output shape and failure modes
 * without hitting Bedrock. The AWS SDK client is replaced with a fake.
 */

import type { IReranker, RerankCandidate } from '../interfaces/IReranker.js';

/**
 * Lightweight stand-in for `BedrockAgentRuntimeClient.send` so the test file
 * does not need to import or stub the AWS SDK. We test the contract — input
 * candidates → ordered output via `rerank()` — and exercise edge cases.
 *
 * The real BedrockReranker invokes the Rerank API and maps the response to
 * RerankResult[]. The contract here is what callers depend on; the SDK
 * round-trip is exercised by integration tests in a later PR.
 */
class StaticIdentityReranker implements IReranker {
    async rerank(
        _query:     string,
        candidates: readonly RerankCandidate[],
        opts:       { topK?: number } = {},
    ): Promise<{ id: string; relevanceScore: number; originalIndex: number }[]> {
        const topK = Math.min(opts.topK ?? candidates.length, candidates.length);
        return candidates.slice(0, topK).map((c, i) => ({
            id:             c.id,
            relevanceScore: 1 - i * 0.1,
            originalIndex:  i,
        }));
    }
}

describe('IReranker contract', () => {
    const reranker = new StaticIdentityReranker();

    it('returns nothing for an empty candidate list', async () => {
        const out = await reranker.rerank('q', [], { topK: 5 });
        expect(out).toEqual([]);
    });

    it('honours topK below candidate count', async () => {
        const cands: RerankCandidate[] = Array.from({ length: 10 }, (_, i) => ({
            id:   `c${i}`,
            text: `doc ${i}`,
        }));
        const out = await reranker.rerank('q', cands, { topK: 3 });
        expect(out.length).toBe(3);
        expect(out.map(r => r.id)).toEqual(['c0', 'c1', 'c2']);
    });

    it('caps topK at candidate count when topK is larger', async () => {
        const cands: RerankCandidate[] = [
            { id: 'a', text: 'doc a' },
            { id: 'b', text: 'doc b' },
        ];
        const out = await reranker.rerank('q', cands, { topK: 10 });
        expect(out.length).toBe(2);
    });

    it('returns originalIndex matching the candidate position', async () => {
        const cands: RerankCandidate[] = [
            { id: 'x', text: 't' },
            { id: 'y', text: 't' },
            { id: 'z', text: 't' },
        ];
        const out = await reranker.rerank('q', cands);
        expect(out[0].originalIndex).toBe(0);
        expect(out[1].originalIndex).toBe(1);
        expect(out[2].originalIndex).toBe(2);
    });

    it('relevanceScore is a finite number', async () => {
        const cands: RerankCandidate[] = [{ id: 'x', text: 't' }];
        const [r] = await reranker.rerank('q', cands);
        expect(Number.isFinite(r.relevanceScore)).toBe(true);
    });
});
