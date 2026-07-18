/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { RepoFactsReadRepository } from './RepoFactsReadRepository.js';
import type { RepoFactsPayload } from './RepoFactsReadRepository.js';

function fakePool(rows: unknown[]) {
    return { query: jest.fn(async () => ({ rows })) } as never;
}

const EMPTY_FACTS: RepoFactsPayload = {
    languages: [],
    frameworks: [],
    databases: [],
    infrastructure: [],
    tools: [],
    concepts: [],
};

describe('RepoFactsReadRepository', () => {
    describe('loadForUser', () => {
        it('maps rows to RepoFactRow', async () => {
            const facts: RepoFactsPayload = {
                ...EMPTY_FACTS,
                languages: [{ name: 'typescript', version: null, evidenceCount: 12 }],
                concepts: [{ name: 'observability', detector: 'grafana-config', files: 11 }],
            };
            const repo = new RepoFactsReadRepository(fakePool([
                { repo_full_name: 'org/repo-a', role: 'backend', classification: 'project', facts },
            ]));
            const rows = await repo.loadForUser('user-1');
            expect(rows).toEqual([
                { repoFullName: 'org/repo-a', role: 'backend', classification: 'project', facts },
            ]);
        });

        it('preserves a null classification', async () => {
            const repo = new RepoFactsReadRepository(fakePool([
                { repo_full_name: 'org/repo-a', role: 'backend', classification: null, facts: EMPTY_FACTS },
            ]));
            const rows = await repo.loadForUser('user-1');
            expect(rows[0]?.classification).toBeNull();
        });

        it('queries repo_facts filtered by user_id', async () => {
            const pool = fakePool([]);
            const repo = new RepoFactsReadRepository(pool);
            await repo.loadForUser('user-1');
            const mockQuery = (pool as unknown as { query: jest.Mock }).query;
            const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
            expect(sql).toContain('SELECT repo_full_name, role, classification, facts');
            expect(sql).toContain('FROM repo_facts');
            expect(sql).toContain('WHERE user_id = $1');
            expect(params).toEqual(['user-1']);
        });

        it('returns an empty array when the user has no fact sheets', async () => {
            const repo = new RepoFactsReadRepository(fakePool([]));
            expect(await repo.loadForUser('user-1')).toEqual([]);
        });
    });
});
