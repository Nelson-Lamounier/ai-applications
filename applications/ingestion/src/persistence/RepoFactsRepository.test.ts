/** @format */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Pool, PoolClient } from 'pg';

import { RepoFactsRepository } from './RepoFactsRepository.js';
import type { RepoFactsRow } from './RepoFactsRepository.js';
import type { RepoFactsPayload } from '../facts/build-repo-facts.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(): { client: PoolClient; query: jest.Mock } {
    const query = jest.fn<() => Promise<{ rows: unknown[] }>>().mockResolvedValue({ rows: [] });
    const client = { query, release: jest.fn() } as unknown as PoolClient;
    return { client, query };
}

function makePool(client: PoolClient): Pool {
    return { connect: jest.fn<() => Promise<PoolClient>>().mockResolvedValue(client) } as unknown as Pool;
}

const EMPTY_FACTS: RepoFactsPayload = {
    languages: [], frameworks: [], databases: [], infrastructure: [], tools: [], concepts: [],
};

function row(over: Partial<RepoFactsRow> = {}): RepoFactsRow {
    return {
        githubRepoId:   12345,
        role:           'backend',
        classification: 'project',
        facts:          EMPTY_FACTS,
        factVersion:    1,
        ...over,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RepoFactsRepository.upsert', () => {
    let client: PoolClient;
    let query: jest.Mock;
    let repo: RepoFactsRepository;

    beforeEach(() => {
        const m = makeClient();
        client = m.client;
        query  = m.query;
        repo   = new RepoFactsRepository(makePool(client));
    });

    it('stamps set_config with the user id before the upsert, inside one BEGIN/COMMIT transaction', async () => {
        await repo.upsert('user-1', 'octo/repo', row());

        const calls = query.mock.calls as Array<[string, unknown[]?]>;
        const kinds = calls.map(([sql]) => {
            if (/^BEGIN/i.test(sql as string)) return 'BEGIN';
            if (/set_config/.test(sql as string)) return 'set_config';
            if (/INSERT INTO repo_facts/i.test(sql as string)) return 'INSERT';
            if (/^COMMIT/i.test(sql as string)) return 'COMMIT';
            if (/^ROLLBACK/i.test(sql as string)) return 'ROLLBACK';
            return 'OTHER';
        });

        expect(kinds).toEqual(['BEGIN', 'set_config', 'INSERT', 'COMMIT']);

        const setConfigCall = calls[1];
        expect(setConfigCall[0]).toMatch(/SELECT set_config\('app\.current_user_id', \$1, true\)/);
        expect(setConfigCall[1]).toEqual(['user-1']);
    });

    it('issues the INSERT with an ON CONFLICT upsert scoped to (user_id, repo_full_name)', async () => {
        await repo.upsert('user-1', 'octo/repo', row({ githubRepoId: 42, role: 'infra', classification: 'fork', factVersion: 2 }));

        const insertCall = (query.mock.calls as Array<[string, unknown[]]>).find(
            ([sql]) => typeof sql === 'string' && /INSERT INTO repo_facts/i.test(sql),
        );
        expect(insertCall).toBeDefined();
        const [sql, params] = insertCall!;

        expect(sql).toMatch(/ON CONFLICT \(user_id, repo_full_name\) DO UPDATE/);
        expect(sql).toMatch(/github_repo_id = COALESCE\(EXCLUDED\.github_repo_id, repo_facts\.github_repo_id\)/);

        expect(params).toEqual([
            'user-1', 'octo/repo', 42, 'infra', 'fork', JSON.stringify(EMPTY_FACTS), 2,
        ]);
    });

    it('rolls back and rethrows when the INSERT fails', async () => {
        query.mockImplementation(async (sql: unknown) => {
            if (typeof sql === 'string' && /INSERT INTO repo_facts/i.test(sql)) {
                throw new Error('boom');
            }
            return { rows: [] };
        });

        await expect(repo.upsert('user-1', 'octo/repo', row())).rejects.toThrow('boom');

        const kinds = (query.mock.calls as Array<[string]>).map(([sql]) => sql);
        expect(kinds.some((sql) => /^ROLLBACK/i.test(sql))).toBe(true);
    });

    it('releases the client even when the transaction fails', async () => {
        const releaseSpy = client.release as jest.Mock;
        query.mockImplementation(async (sql: unknown) => {
            if (typeof sql === 'string' && /INSERT INTO repo_facts/i.test(sql)) {
                throw new Error('boom');
            }
            return { rows: [] };
        });

        await expect(repo.upsert('user-1', 'octo/repo', row())).rejects.toThrow();
        expect(releaseSpy).toHaveBeenCalledTimes(1);
    });
});
