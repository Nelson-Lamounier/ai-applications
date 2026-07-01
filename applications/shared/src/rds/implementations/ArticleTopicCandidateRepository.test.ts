/** @format */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Pool } from 'pg';

import {
    ArticleTopicCandidateRepository,
    type ArticleTopicCandidateInput,
} from './ArticleTopicCandidateRepository.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clientQuery = jest.fn() as jest.Mock<any>;
const release = jest.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const poolQuery = jest.fn() as jest.Mock<any>;
const connect = jest.fn<() => Promise<unknown>>().mockResolvedValue({ query: clientQuery, release });

const pool = { query: poolQuery, connect } as unknown as Pool;

const INPUT: ArticleTopicCandidateInput = {
    userId:          'user-1',
    githubRepoId:    '123456789',
    repoFullName:    'nelson/ai-applications',
    title:           'Chunk-enrichment cost cascade cut per-repo cost from EUR5 to EUR0.30',
    problem:         'Per-chunk LLM enrichment cost EUR5/repo; a tiered cache/cascade cut it.',
    angle:           'FinOps for AI pipelines',
    evidenceRefs:    [{ type: 'commit', ref: 'abc123' }],
    verifiedMetrics: [{ label: 'cost per repo', value: '0.30', unit: 'EUR', source: 'commit abc123' }],
    skills:          ['Cost Optimisation'],
};

describe('ArticleTopicCandidateRepository', () => {
    beforeEach(() => {
        clientQuery.mockReset().mockResolvedValue({ rows: [] });
        poolQuery.mockReset().mockResolvedValue({ rows: [] });
        release.mockReset();
    });

    describe('replaceSuggestedForRepo', () => {
        it('deletes only suggested rows then inserts new candidates in a transaction', async () => {
            const repo = new ArticleTopicCandidateRepository(pool);
            await repo.replaceSuggestedForRepo('user-1', '123456789', [INPUT]);

            const sqls = clientQuery.mock.calls.map((c) => (c as unknown[])[0] as string);
            expect(sqls[0]).toBe('BEGIN');
            expect(sqls.some((s) => /DELETE FROM article_topic_candidates/.test(s) && /status = 'suggested'/.test(s))).toBe(true);
            expect(sqls.some((s) => /INSERT INTO article_topic_candidates/.test(s))).toBe(true);
            expect(sqls[sqls.length - 1]).toBe('COMMIT');

            const insertCall = clientQuery.mock.calls.find((c) => /INSERT INTO/.test((c as unknown[])[0] as string));
            const params = (insertCall as unknown[])[1] as unknown[];
            expect(params[1]).toBe('123456789'); // github_repo_id, not name
            expect(release).toHaveBeenCalled();
        });

        it('rolls back and rethrows if an insert fails', async () => {
            clientQuery.mockImplementation((sql: string) => {
                if (/INSERT INTO/.test(sql)) return Promise.reject(new Error('boom'));
                return Promise.resolve({ rows: [] });
            });
            const repo = new ArticleTopicCandidateRepository(pool);
            await expect(repo.replaceSuggestedForRepo('user-1', '123456789', [INPUT])).rejects.toThrow('boom');
            const sqls = clientQuery.mock.calls.map((c) => (c as unknown[])[0] as string);
            expect(sqls).toContain('ROLLBACK');
            expect(release).toHaveBeenCalled();
        });
    });

    describe('listByRepo', () => {
        it('maps rows and coerces the BIGINT github_repo_id to a string', async () => {
            poolQuery.mockResolvedValueOnce({
                rows: [{
                    id: 'c1', user_id: 'user-1', github_repo_id: '123456789',
                    repo_full_name: 'nelson/ai-applications', title: 'T', problem: 'P',
                    angle: null, primary_keyword: null,
                    evidence_refs: [{ type: 'commit', ref: 'abc' }],
                    verified_metrics: [{ label: 'cost', value: '0.30' }],
                    skills: ['Cost Optimisation'], status: 'suggested',
                    used_article_slug: null, created_at: new Date(), updated_at: new Date(),
                }],
            });
            const repo = new ArticleTopicCandidateRepository(pool);
            const out = await repo.listByRepo('user-1', '123456789', 'suggested');
            expect(out).toHaveLength(1);
            expect(out[0]!.githubRepoId).toBe('123456789');
            expect(out[0]!.verifiedMetrics[0]!.value).toBe('0.30');
            const [sql, params] = poolQuery.mock.calls[0] as unknown as [string, unknown[]];
            expect(sql).toMatch(/status = \$3/);
            expect(params).toEqual(['user-1', '123456789', 'suggested']);
        });
    });

    describe('markUsed / markDismissed', () => {
        it('markUsed sets status=used and the slug', async () => {
            const repo = new ArticleTopicCandidateRepository(pool);
            await repo.markUsed('c1', 'my-slug');
            const [sql, params] = poolQuery.mock.calls[0] as unknown as [string, unknown[]];
            expect(sql).toMatch(/status = 'used'/);
            expect(params).toEqual(['c1', 'my-slug']);
        });

        it('markDismissed sets status=dismissed', async () => {
            const repo = new ArticleTopicCandidateRepository(pool);
            await repo.markDismissed('c1');
            const [sql] = poolQuery.mock.calls[0] as unknown as [string];
            expect(sql).toMatch(/status = 'dismissed'/);
        });
    });
});
