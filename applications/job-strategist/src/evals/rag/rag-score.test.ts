/** @format */
import {
    recallAtK, aggregate, parseRelevanceScores, buildRelevanceJudgePrompt,
    type RetrievedContext, type GoldenQuery, type QueryEvalResult,
} from './rag-score.js';

const ctx = (source: string, cosine = 0.3): RetrievedContext => ({ source, cosine, snippet: 's' });

describe('recallAtK', () => {
    const golden: GoldenQuery = { id: 'q', query: 'q', kind: 'positive', expectedRepos: ['cdk-monitoring'], expectedFiles: ['RdsVectorStore'] };

    it('counts expected sources present in the top-k', () => {
        const retrieved = [ctx('o/cdk-monitoring/a.ts'), ctx('o/ai-applications/RdsVectorStore.ts'), ctx('o/x/y.ts')];
        expect(recallAtK(retrieved, golden, 3)).toBe(1); // both expected matched
    });

    it('respects k (out-of-window matches do not count)', () => {
        const retrieved = [ctx('o/x/y.ts'), ctx('o/cdk-monitoring/a.ts'), ctx('o/ai-applications/RdsVectorStore.ts')];
        expect(recallAtK(retrieved, golden, 1)).toBe(0); // only y.ts in top-1
    });

    it('returns null when the golden declares no expected sources (negatives)', () => {
        expect(recallAtK([ctx('o/r/a.ts')], { id: 'n', query: 'q', kind: 'negative' }, 5)).toBeNull();
    });
});

describe('aggregate', () => {
    it('splits positive/negative relevance and averages recall over expectations', () => {
        const results: QueryEvalResult[] = [
            { id: 'p1', kind: 'positive', recallAtK: 1,    contextRelevance: 0.8, retrievedCount: 5, maxCosine: 0.4 },
            { id: 'p2', kind: 'positive', recallAtK: 0.5,  contextRelevance: 0.6, retrievedCount: 5, maxCosine: 0.3 },
            { id: 'n1', kind: 'negative', recallAtK: null, contextRelevance: 0.1, retrievedCount: 2, maxCosine: 0.15 },
        ];
        const r = aggregate(results);
        expect(r.queryCount).toBe(3);
        expect(r.positiveCount).toBe(2);
        expect(r.negativeCount).toBe(1);
        expect(r.meanRecallAtK).toBeCloseTo(0.75);          // (1 + 0.5)/2
        expect(r.meanRelevancePositive).toBeCloseTo(0.7);   // (0.8 + 0.6)/2
        expect(r.meanRelevanceNegative).toBeCloseTo(0.1);   // leakage signal
    });

    it('reports null mean recall when no query declared expectations', () => {
        const r = aggregate([{ id: 'n', kind: 'negative', recallAtK: null, contextRelevance: 0.2, retrievedCount: 1, maxCosine: 0.1 }]);
        expect(r.meanRecallAtK).toBeNull();
    });
});

describe('parseRelevanceScores', () => {
    it('clamps to [0,1] and pads/truncates to the context count', () => {
        expect(parseRelevanceScores({ scores: [0.9, 1.5, -0.2] }, 4)).toEqual([0.9, 1, 0, 0]);
    });
    it('defaults to zeros on a malformed judge response', () => {
        expect(parseRelevanceScores({ nope: true }, 2)).toEqual([0, 0]);
    });
});

describe('buildRelevanceJudgePrompt', () => {
    it('numbers each context and includes the query', () => {
        const p = buildRelevanceJudgePrompt('kubernetes', [ctx('o/r/a.ts'), ctx('o/r/b.ts')]);
        expect(p).toMatch(/QUERY: kubernetes/);
        expect(p).toMatch(/\[0\] source: o\/r\/a\.ts/);
        expect(p).toMatch(/\[1\] source: o\/r\/b\.ts/);
    });
});
