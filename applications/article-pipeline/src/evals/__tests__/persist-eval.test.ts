/** @format */
import { describe, it, expect } from '@jest/globals';

import { toEvalRunRows } from '../persist-eval.js';
import type { ArticleEvalReport } from '../article-eval-score.js';
import type { WriterCheckReport } from '../article-quality-checks.js';
import type { QaEvalReport } from '../qa-eval-score.js';

const research: ArticleEvalReport = {
    queryCount: 3, positiveCount: 2, negativeCount: 1,
    meanRecallPositive: 0.75, meanRecallNegative: 0,
    perQuery: [
        { id: 'r1', kind: 'positive', repoRecall: 1, retrievedRepos: ['a/b'], retrievedCount: 6 },
        { id: 'r2', kind: 'positive', repoRecall: 0.5, retrievedRepos: ['a/b'], retrievedCount: 4 },
        { id: 'n1', kind: 'negative', repoRecall: 0, retrievedRepos: ['x/y'], retrievedCount: 3 },
    ],
};

const writer: WriterCheckReport[] = [
    { id: 'w1', checks: [], passedCount: 6, total: 6, ok: true },
    { id: 'w2', checks: [], passedCount: 4, total: 6, ok: false },
];

const qa: QaEvalReport = {
    caseCount: 3, detectedCount: 3, accuracy: 1,
    perCase: [
        { id: 'clean', expectedFlag: 'none', detected: true, recommendation: 'publish', flaggedDimensionScore: null },
        { id: 'mdx', expectedFlag: 'mdxStructure', detected: true, recommendation: 'revise', flaggedDimensionScore: 40 },
        { id: 'tech', expectedFlag: 'technicalAccuracy', detected: true, recommendation: 'reject', flaggedDimensionScore: 30 },
    ],
};

describe('toEvalRunRows', () => {
    const rows = toEvalRunRows(research, writer, qa, { research: true, writer: false, qa: true });

    it('emits one run row per phase, tagged by tool', () => {
        expect(rows.map((r) => r.tool)).toEqual(['article-research', 'article-writer', 'article-qa']);
    });

    it('maps research headline metrics (recall positive, leakage negative)', () => {
        const r = rows[0]!;
        expect(r.meanRecallAtK).toBe(0.75);
        expect(r.meanRelevanceNegative).toBe(0);
        expect(r.positiveCount).toBe(2);
        expect(r.negativeCount).toBe(1);
        expect(r.results).toHaveLength(3);
        expect(r.results[0]).toMatchObject({ queryId: 'r1', kind: 'positive', recallAtK: 1 });
    });

    it('maps writer clean-brief rate and 0/1 per-brief results', () => {
        const w = rows[1]!;
        expect(w.meanRecallAtK).toBe(0.5); // 1 of 2 briefs ok
        expect(w.results.map((x) => x.recallAtK)).toEqual([1, 0]);
        expect(w.notes).toBe('pass=false');
    });

    it('maps QA accuracy and splits clean control as negative, defects as positive', () => {
        const q = rows[2]!;
        expect(q.meanRecallAtK).toBe(1);
        expect(q.positiveCount).toBe(2); // mdx + tech defects
        expect(q.negativeCount).toBe(1); // clean control
        expect(q.results.find((x) => x.queryId === 'clean')?.kind).toBe('negative');
        expect(q.results.find((x) => x.queryId === 'mdx')?.kind).toBe('positive');
    });
});
