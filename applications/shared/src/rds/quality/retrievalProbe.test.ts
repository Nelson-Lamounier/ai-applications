import {
    sampleChunks,
    matchRank,
    scoreRetrieval,
    buildRetrievalSuggestions,
} from './retrievalProbe.js';
import type { RawChunk } from '../types.js';

function chunk(filePath: string, chunkIndex: number, tag: string, content = 'x'.repeat(50)): RawChunk {
    return { filePath, chunkIndex, content, tags: [tag] } as RawChunk;
}

describe('sampleChunks', () => {
    it('is deterministic for the same repoFullName', () => {
        const chunks = Array.from({ length: 20 }, (_, i) => chunk(`d${i % 4}/f${i}.md`, 0, `t${i % 4}`));
        const a = sampleChunks(chunks, 'owner/repo', 5);
        const b = sampleChunks(chunks, 'owner/repo', 5);
        expect(a.map(c => c.filePath)).toEqual(b.map(c => c.filePath));
        expect(a).toHaveLength(5);
    });

    it('excludes commit-history synthetic chunks', () => {
        const chunks = [
            chunk('README.md', 0, 'root'),
            { ...chunk('x', 0, '_commits'), fileType: 'commit_history' } as RawChunk,
        ];
        const out = sampleChunks(chunks, 'owner/repo', 5);
        expect(out.every(c => c.fileType !== 'commit_history')).toBe(true);
        expect(out).toHaveLength(1);
    });

    it('returns empty when fewer than 2 eligible chunks', () => {
        expect(sampleChunks([chunk('a.md', 0, 'root')], 'owner/repo', 5)).toEqual([]);
    });

    it('spreads the sample across tag buckets', () => {
        const chunks = Array.from({ length: 10 }, (_, i) =>
            chunk(`t${i % 3}/f${i}.md`, 0, `tag${i % 3}`),
        );
        const out = sampleChunks(chunks, 'owner/repo', 6);
        const tags = new Set(out.map(c => c.tags![0]));
        expect(tags.size).toBe(3);
    });
});

describe('matchRank', () => {
    const source = chunk('docs/a.md', 2, 'docs');
    it('returns 1-based rank when source (filePath,chunkIndex) is present', () => {
        const results = [
            { filePath: 'docs/b.md', chunkIndex: 0, similarity: 0.9 },
            { filePath: 'docs/a.md', chunkIndex: 2, similarity: 0.8 },
        ];
        expect(matchRank(source, results)).toBe(2);
    });
    it('returns null on miss', () => {
        expect(matchRank(source, [{ filePath: 'docs/b.md', chunkIndex: 0, similarity: 0.9 }])).toBeNull();
    });
});

describe('scoreRetrieval', () => {
    it('computes recall@3, mrr, meanTopSimilarity and 0.6/0.4 score', () => {
        const r = scoreRetrieval([
            { sourceIndex: 0, rank: 1, topSimilarity: 0.9 },
            { sourceIndex: 1, rank: 3, topSimilarity: 0.7 },
            { sourceIndex: 2, rank: null, topSimilarity: 0.4 },
            { sourceIndex: 3, rank: 2, topSimilarity: 0.6 },
        ]);
        expect(r.sampled).toBe(4);
        expect(r.recallAt3).toBeCloseTo(0.75, 5);
        expect(r.mrr).toBeCloseTo((1 + 1 / 3 + 0 + 1 / 2) / 4, 5);
        expect(r.meanTopSimilarity).toBeCloseTo(0.65, 5);
        expect(r.score).toBe(Math.round((0.6 * 0.75 + 0.4 * ((1 + 1 / 3 + 0 + 1 / 2) / 4)) * 100) / 100);
    });
    it('returns all-zero metrics for empty input', () => {
        const r = scoreRetrieval([]);
        expect(r).toMatchObject({ sampled: 0, recallAt3: 0, mrr: 0, meanTopSimilarity: 0, score: 0 });
    });
});

describe('buildRetrievalSuggestions', () => {
    it('emits the recall suggestion when recallAt3 < 0.5', () => {
        const out = buildRetrievalSuggestions({ recallAt3: 0.2, mrr: 0.6, meanTopSimilarity: 0.8 });
        expect(out.some(s => s.includes('retrieve poorly'))).toBe(true);
    });
    it('emits nothing when all signals are healthy', () => {
        expect(buildRetrievalSuggestions({ recallAt3: 0.9, mrr: 0.8, meanTopSimilarity: 0.8 })).toEqual([]);
    });
});
