import { RetrievalProbe, type IProbeQuestionGenerator } from '../RetrievalProbe.js';
import type { RawChunk, RetrievalProbeArgs } from '@bedrock/shared';

type Embedder    = RetrievalProbeArgs['embedder'];
type VectorStore = RetrievalProbeArgs['vectorStore'];

function chunk(filePath: string, chunkIndex: number, tag: string): RawChunk {
    return { filePath, chunkIndex, tags: [tag], content: 'meaningful prose '.repeat(20) } as RawChunk;
}
const chunks = Array.from({ length: 6 }, (_, i) => chunk(`d${i % 3}/f${i}.md`, 0, `t${i % 3}`));
const embedder = { embed: jest.fn(async () => Array(1024).fill(0.1)) } as unknown as Embedder;

function vectorStore(hit: { filePath: string; chunkIndex: number } | null): VectorStore {
    return {
        querySimilar: jest.fn(async () =>
            hit
                ? [{ id: 'x', repoFullName: 'o/r', filePath: hit.filePath, chunkIndex: hit.chunkIndex, content: '', similarity: 0.85 }]
                : [{ id: 'y', repoFullName: 'o/r', filePath: 'nope.md', chunkIndex: 99, content: '', similarity: 0.3 }]),
    } as unknown as VectorStore;
}

const goodGen = {
    generate: jest.fn(async (texts: string[]) =>
        texts.map((_, i) => ({ sourceIndex: i, question: `question ${i} long enough` }))),
};

describe('RetrievalProbe.evaluate', () => {
    it('returns skipped_no_chunks when fewer than 2 eligible chunks', async () => {
        const probe = new RetrievalProbe(goodGen as IProbeQuestionGenerator, { questionCount: 5, topK: 3 });
        const res = await probe.evaluate({
            userId: 'u', repoFullName: 'o/r', rawChunks: [chunk('a.md', 0, 'root')],
            embedder, vectorStore: vectorStore(null),
        } as RetrievalProbeArgs);
        expect(res.status).toBe('skipped_no_chunks');
        expect(res.score).toBe(0);
    });

    it('returns status failed (never throws) when the generator throws', async () => {
        const badGen = { generate: jest.fn(async () => { throw new Error('bedrock down'); }) };
        const probe = new RetrievalProbe(badGen as IProbeQuestionGenerator, { questionCount: 5, topK: 3 });
        const res = await probe.evaluate({
            userId: 'u', repoFullName: 'o/r', rawChunks: chunks,
            embedder, vectorStore: vectorStore(null),
        } as RetrievalProbeArgs);
        expect(res.status).toBe('failed');
        expect(res.score).toBe(0);
    });

    it('status ok, recall=0 when search never returns the source chunk', async () => {
        const probe = new RetrievalProbe(goodGen as IProbeQuestionGenerator, { questionCount: 5, topK: 3 });
        const res = await probe.evaluate({
            userId: 'u', repoFullName: 'o/r', rawChunks: chunks,
            embedder, vectorStore: vectorStore(null),
        } as RetrievalProbeArgs);
        expect(res.status).toBe('ok');
        expect(res.sampled).toBeGreaterThanOrEqual(2);
        expect(res.recallAt3).toBe(0);
        expect(res.score).toBe(0);
        expect(res.suggestions.length).toBeGreaterThan(0);
    });

    it('produces a bounded [0,1] score and valid shape', async () => {
        const probe = new RetrievalProbe(goodGen as IProbeQuestionGenerator, { questionCount: 5, topK: 3 });
        const res = await probe.evaluate({
            userId: 'u', repoFullName: 'o/r', rawChunks: chunks,
            embedder, vectorStore: vectorStore({ filePath: 'd0/f0.md', chunkIndex: 0 }),
        } as RetrievalProbeArgs);
        expect(res.version).toBe(1);
        expect(res.score).toBeGreaterThanOrEqual(0);
        expect(res.score).toBeLessThanOrEqual(1);
        expect(res.sampled).toBe(5);
        expect(res.perQuestion).toHaveLength(5);
        expect(res.perQuestion.every(q => q.sourceIndex >= 0 && q.sourceIndex < 5)).toBe(true);
    });
});
