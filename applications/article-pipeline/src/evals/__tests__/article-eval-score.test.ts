/** @format */
import { describe, it, expect } from '@jest/globals';

import {
    repoRecall, distinctReposInOrder, aggregate, passesGate, formatReport,
    type ArticleQueryResult,
} from '../article-eval-score.js';

describe('repoRecall', () => {
    it('is 1 when every expected repo is surfaced (case-insensitive, substring)', () => {
        const retrieved = ['Nelson-Lamounier/ai-applications', 'Nelson-Lamounier/kubernetes-bootstrap'];
        expect(repoRecall(retrieved, ['nelson-lamounier/AI-APPLICATIONS'])).toBe(1);
    });

    it('is fractional when only some expected repos are surfaced', () => {
        const retrieved = ['Nelson-Lamounier/ai-applications'];
        expect(repoRecall(retrieved, ['Nelson-Lamounier/ai-applications', 'Nelson-Lamounier/tucaken-infra'])).toBe(0.5);
    });

    it('is 0 when none surface, and 0 when nothing is expected (negatives well-defined)', () => {
        expect(repoRecall(['owner/other'], ['owner/wanted'])).toBe(0);
        expect(repoRecall(['owner/anything'], [])).toBe(0);
    });
});

describe('distinctReposInOrder', () => {
    it('de-duplicates case-insensitively while preserving first-seen order', () => {
        expect(distinctReposInOrder(['a/b', 'A/B', 'c/d', 'a/b'])).toEqual(['a/b', 'c/d']);
    });
});

describe('aggregate + passesGate', () => {
    const results: ArticleQueryResult[] = [
        { id: 'p1', kind: 'positive', repoRecall: 1.0, retrievedRepos: ['a/b'], retrievedCount: 5 },
        { id: 'p2', kind: 'positive', repoRecall: 0.5, retrievedRepos: ['a/b'], retrievedCount: 4 },
        { id: 'n1', kind: 'negative', repoRecall: 0.0, retrievedRepos: ['x/y'], retrievedCount: 3 },
    ];

    it('computes per-kind mean recall', () => {
        const report = aggregate(results);
        expect(report.positiveCount).toBe(2);
        expect(report.negativeCount).toBe(1);
        expect(report.meanRecallPositive).toBeCloseTo(0.75, 5);
        expect(report.meanRecallNegative).toBe(0);
    });

    it('passes when positives clear the floor and negatives stay under the ceiling', () => {
        const report = aggregate(results);
        expect(passesGate(report, 0.6, 0.0)).toBe(true);
    });

    it('fails when positive recall is below the floor', () => {
        const report = aggregate(results);
        expect(passesGate(report, 0.8, 0.0)).toBe(false);
    });

    it('fails on negative leakage above the ceiling', () => {
        const leaky = aggregate([
            { id: 'p1', kind: 'positive', repoRecall: 1.0, retrievedRepos: ['a/b'], retrievedCount: 5 },
            { id: 'n1', kind: 'negative', repoRecall: 0.5, retrievedRepos: ['a/b'], retrievedCount: 3 },
        ]);
        expect(passesGate(leaky, 0.6, 0.0)).toBe(false);
    });
});

describe('formatReport', () => {
    it('renders a markdown table with a header line', () => {
        const out = formatReport(aggregate([
            { id: 'p1', kind: 'positive', repoRecall: 1.0, retrievedRepos: ['a/b'], retrievedCount: 5 },
        ]));
        expect(out).toContain('Article research-phase eval');
        expect(out).toContain('| query | kind | repo-recall | hits | retrieved repos |');
        expect(out).toContain('p1');
    });
});
