/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import type { Pool, PoolClient } from 'pg';

import { buildRepoFacts } from './build-repo-facts.js';

// ---------------------------------------------------------------------------
// A single mocked pool is shared by:
//   - the direct `pool.query` calls inside build-repo-facts.ts (repo row,
//     tech-evidence aggregate)
//   - `loadRepoRoleSignals` (also a direct `pool.query`, imported unmocked
//     from @bedrock/shared, so its real row -> RepoRoleSignals mapping runs)
//   - `RepoFactsRepository.upsert`, which calls `pool.connect()` for its own
//     transaction (BEGIN / set_config / INSERT / COMMIT)
// Routing is by a SQL-shape fingerprint per query, not by call order, so the
// test stays robust to incidental reordering inside buildRepoFacts.
// ---------------------------------------------------------------------------

const REPOSITORY_ID = 'repo-uuid-1';

function makeRepoRow(over: Record<string, unknown> = {}) {
    return {
        repository_id:         REPOSITORY_ID,
        github_repo_id:        '123456',
        primary_language:      'TypeScript',
        classification:        'project',
        has_monitoring_config: false,
        ...over,
    };
}

function makeRoleSignalsRow(over: Record<string, unknown> = {}) {
    return {
        repository_id:     REPOSITORY_ID,
        primary_language:  'TypeScript',
        topics:             [],
        tech_stack:         [],
        archetype_signals: {},
        evidence_topology: {},
        file_class_counts: {},
        ...over,
    };
}

function makePool(opts: {
    repoRow: Record<string, unknown> | null;
    roleSignalsRow: Record<string, unknown>;
    techRows?: Array<Record<string, unknown>>;
}): { pool: Pool; clientQuery: jest.Mock; poolQuery: jest.Mock } {
    const poolQuery = jest.fn<() => Promise<{ rows: unknown[] }>>();
    poolQuery.mockImplementation(async (...args: unknown[]) => {
        const sql = args[0] as string;
        if (/has_monitoring_config/.test(sql)) {
            return { rows: opts.repoRow ? [opts.repoRow] : [] };
        }
        if (/FROM technology_evidence/.test(sql)) {
            return { rows: opts.techRows ?? [] };
        }
        if (/archetype_signals\s+AS\s+archetype_signals/.test(sql)) {
            return { rows: [opts.roleSignalsRow] };
        }
        return { rows: [] };
    });

    const clientQuery = jest.fn<() => Promise<{ rows: unknown[] }>>().mockResolvedValue({ rows: [] });
    const client = { query: clientQuery, release: jest.fn() } as unknown as PoolClient;

    const pool = {
        query:   poolQuery,
        connect: jest.fn<() => Promise<PoolClient>>().mockResolvedValue(client),
    } as unknown as Pool;

    return { pool, clientQuery, poolQuery };
}

describe('buildRepoFacts — orchestration', () => {
    it('throws when the repository row is not found (best-effort caller catches it)', async () => {
        const { pool } = makePool({ repoRow: null, roleSignalsRow: makeRoleSignalsRow() });

        await expect(buildRepoFacts(pool, 'user-1', 'octo/repo')).rejects.toThrow(/repository not found/);
    });

    it('throws when the repository has no role signals row', async () => {
        // loadRepoRoleSignals returns nothing for this repository id, so the
        // signals map lookup misses even though the repo row itself resolved.
        const { pool } = makePool({
            repoRow:        makeRepoRow(),
            roleSignalsRow: makeRoleSignalsRow({ repository_id: 'some-other-repo' }),
        });

        await expect(buildRepoFacts(pool, 'user-1', 'octo/repo')).rejects.toThrow(/no role signals/);
    });

    it('(d) role passthrough — classifyComponentKind\'s verdict lands unchanged on the persisted row', async () => {
        // has_helm_chart is an immediate infra-classification signal
        // (see classifyComponentKind / isInfra), independent of file-class
        // counts, so this deterministically resolves to role = 'infra'.
        const { pool, clientQuery } = makePool({
            repoRow: makeRepoRow(),
            roleSignalsRow: makeRoleSignalsRow({
                archetype_signals: { has_helm_chart: true },
            }),
        });

        await buildRepoFacts(pool, 'user-1', 'octo/repo');

        const insertCall = (clientQuery.mock.calls as Array<[string, unknown[]]>).find(
            ([sql]) => typeof sql === 'string' && /INSERT INTO repo_facts/i.test(sql),
        );
        expect(insertCall).toBeDefined();
        const [, params] = insertCall!;
        // Params: user_id, repo_full_name, github_repo_id, role, classification, facts(jsonb), fact_version
        expect(params[3]).toBe('infra');
    });

    it('threads github_repo_id, classification and assembled facts through to the upsert', async () => {
        const { pool, clientQuery } = makePool({
            repoRow:        makeRepoRow({ github_repo_id: '999', classification: 'fork' }),
            roleSignalsRow: makeRoleSignalsRow({ archetype_signals: { has_ci: true } }),
            techRows:       [{ name: 'typescript', category: 'language', version: null, evidence_count: 3 }],
        });

        await buildRepoFacts(pool, 'user-1', 'octo/repo');

        const insertCall = (clientQuery.mock.calls as Array<[string, unknown[]]>).find(
            ([sql]) => typeof sql === 'string' && /INSERT INTO repo_facts/i.test(sql),
        );
        const [, params] = insertCall!;
        expect(params[0]).toBe('user-1');
        expect(params[1]).toBe('octo/repo');
        expect(params[2]).toBe(999);
        expect(params[4]).toBe('fork');

        const facts = JSON.parse(params[5] as string);
        expect(facts.languages).toEqual([{ name: 'typescript', version: null, evidenceCount: 3 }]);
        expect(facts.concepts).toContainEqual({ name: 'ci/cd', detector: 'signal', files: 0 });
    });
});
