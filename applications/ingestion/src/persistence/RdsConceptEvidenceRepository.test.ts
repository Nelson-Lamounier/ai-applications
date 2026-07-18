/** @format */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Pool, PoolClient } from 'pg';

import { RdsConceptEvidenceRepository } from './RdsConceptEvidenceRepository.js';
import type { RawConceptEvidence } from '../facts/extractors/ConceptPatternExtractor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// SkillOntologyRepository.loadAliasMap() queries `SELECT alias, skill_id FROM
// skill_aliases` and does NOT lowercase keys — normalisation now happens at
// resolve time via OntologyResolver/normalizeAlias (lowercase + trim).
const ALIAS_ROWS = [
    { alias: 'ci/cd pipelines', skill_id: 'skill-cicd' },
    { alias: 'container orchestration', skill_id: 'skill-k8s' },
];

function makeClient(): { client: PoolClient; query: jest.Mock } {
    const query = jest.fn<() => Promise<{ rows: unknown[] }>>().mockResolvedValue({ rows: [] });
    const client = { query, release: jest.fn() } as unknown as PoolClient;
    return { client, query };
}

function makePool(client: PoolClient, aliasRows: unknown[] = ALIAS_ROWS): Pool {
    const poolQuery = jest.fn<() => Promise<{ rows: unknown[] }>>().mockResolvedValue({ rows: aliasRows });
    return {
        connect: jest.fn<() => Promise<PoolClient>>().mockResolvedValue(client),
        query: poolQuery,
    } as unknown as Pool;
}

function row(over: Partial<RawConceptEvidence> = {}): RawConceptEvidence {
    return {
        conceptAlias: 'ci/cd pipelines',
        detector: 'workflow-ci',
        filePath: '.github/workflows/ci.yaml',
        confidence: 1.0,
        ...over,
    };
}

// ---------------------------------------------------------------------------
// alias resolution — now delegated to the shared SkillOntologyRepository +
// OntologyResolver infrastructure instead of a bespoke query/normalisation
// ---------------------------------------------------------------------------

describe('RdsConceptEvidenceRepository alias resolution (shared ontology infra)', () => {
    it('loads the alias map via SkillOntologyRepository.loadAliasMap() (skill_aliases only, no bespoke join)', async () => {
        const { client } = makeClient();
        const pool = makePool(client, ALIAS_ROWS);
        const repo = new RdsConceptEvidenceRepository(pool);

        await repo.insertMany('user-1', 'octo/repo', 42, 'sha1', [row()]);

        const [sql] = (pool.query as jest.Mock).mock.calls[0] as [string];
        expect(sql).toMatch(/SELECT alias, skill_id FROM skill_aliases/);
    });

    it('resolves a mixed-case conceptAlias via OntologyResolver.normalizeAlias (lowercase + trim on the query side)', async () => {
        const { client } = makeClient();
        const pool = makePool(client, ALIAS_ROWS);
        const repo = new RdsConceptEvidenceRepository(pool);

        await repo.insertMany('user-1', 'octo/repo', 42, 'sha1', [
            row({ conceptAlias: '  CI/CD Pipelines  ' }),
        ]);

        const insertCall = (client.query as jest.Mock).mock.calls.find(
            ([sql]) => typeof sql === 'string' && /INSERT INTO concept_evidence/i.test(sql),
        ) as [string, unknown[]] | undefined;
        expect(insertCall).toBeDefined();
        expect(insertCall![1]).toEqual(
            expect.arrayContaining(['skill-cicd']),
        );
    });
});

// ---------------------------------------------------------------------------
// insertMany
// ---------------------------------------------------------------------------

describe('RdsConceptEvidenceRepository.insertMany', () => {
    let client: PoolClient;
    let query: jest.Mock;
    let repo: RdsConceptEvidenceRepository;

    beforeEach(() => {
        const m = makeClient();
        client = m.client;
        query = m.query;
        repo = new RdsConceptEvidenceRepository(makePool(client));
    });

    it('no-ops without connecting a client when rows is empty', async () => {
        const pool = makePool(client);
        const repoEmpty = new RdsConceptEvidenceRepository(pool);
        await repoEmpty.insertMany('user-1', 'octo/repo', 42, 'sha1', []);
        expect(pool.connect).not.toHaveBeenCalled();
    });

    it('stamps set_config before the upsert, inside one BEGIN/COMMIT transaction', async () => {
        await repo.insertMany('user-1', 'octo/repo', 42, 'sha1', [row()]);

        const calls = query.mock.calls as Array<[string, unknown[]?]>;
        const kinds = calls.map(([sql]) => {
            if (/^BEGIN/i.test(sql as string)) return 'BEGIN';
            if (/set_config/.test(sql as string)) return 'set_config';
            if (/INSERT INTO concept_evidence/i.test(sql as string)) return 'INSERT';
            if (/^COMMIT/i.test(sql as string)) return 'COMMIT';
            if (/^ROLLBACK/i.test(sql as string)) return 'ROLLBACK';
            return 'OTHER';
        });
        expect(kinds).toEqual(['BEGIN', 'set_config', 'INSERT', 'COMMIT']);

        const setConfigCall = calls[1];
        expect(setConfigCall[0]).toMatch(/SELECT set_config\('app\.current_user_id', \$1, true\)/);
        expect(setConfigCall[1]).toEqual(['user-1']);
    });

    it('resolves conceptAlias to skill_id and issues the ON CONFLICT upsert from the brief', async () => {
        await repo.insertMany('user-1', 'octo/repo', 42, 'sha1', [
            row({ conceptAlias: 'CI/CD Pipelines', lineStart: 7, confidence: 0.9 }),
        ]);

        const insertCall = (query.mock.calls as Array<[string, unknown[]]>).find(
            ([sql]) => typeof sql === 'string' && /INSERT INTO concept_evidence/i.test(sql),
        );
        expect(insertCall).toBeDefined();
        const [sql, params] = insertCall!;

        expect(sql).toMatch(/ON CONFLICT \(user_id, repo_full_name, skill_id, detector, file_path\) DO UPDATE/);
        expect(sql).toMatch(/commit_sha\s*=\s*EXCLUDED\.commit_sha/);
        expect(sql).toMatch(/line_start\s*=\s*EXCLUDED\.line_start/);
        expect(sql).toMatch(/confidence\s*=\s*EXCLUDED\.confidence/);
        expect(sql).toMatch(/extracted_at\s*=\s*now\(\)/);

        expect(params).toEqual([
            'user-1', 'octo/repo', 42, 'skill-cicd', 'workflow-ci', '.github/workflows/ci.yaml', 7, 0.9, 'sha1',
        ]);
    });

    it('logs and skips rows whose conceptAlias has no seeded alias, never throwing', async () => {
        await expect(
            repo.insertMany('user-1', 'octo/repo', 42, 'sha1', [row({ conceptAlias: 'not-a-real-concept' })]),
        ).resolves.toBeUndefined();

        const insertCall = (query.mock.calls as Array<[string]>).find(
            ([sql]) => typeof sql === 'string' && /INSERT INTO concept_evidence/i.test(sql),
        );
        expect(insertCall).toBeUndefined();
    });

    it('skips only the unresolved row and still inserts the resolved one in the same batch', async () => {
        await repo.insertMany('user-1', 'octo/repo', 42, 'sha1', [
            row({ conceptAlias: 'not-a-real-concept', detector: 'ghost' }),
            row({ conceptAlias: 'container orchestration', detector: 'k8s-orchestration', filePath: 'k8s/deploy.yaml' }),
        ]);

        const insertCalls = (query.mock.calls as Array<[string, unknown[]]>).filter(
            ([sql]) => typeof sql === 'string' && /INSERT INTO concept_evidence/i.test(sql),
        );
        expect(insertCalls).toHaveLength(1);
        expect(insertCalls[0][1]).toEqual(
            expect.arrayContaining(['skill-k8s', 'k8s-orchestration', 'k8s/deploy.yaml']),
        );
    });

    it('rolls back and rethrows when an INSERT fails', async () => {
        query.mockImplementation(async (sql: unknown) => {
            if (typeof sql === 'string' && /INSERT INTO concept_evidence/i.test(sql)) throw new Error('boom');
            return { rows: [] };
        });

        await expect(repo.insertMany('user-1', 'octo/repo', 42, 'sha1', [row()])).rejects.toThrow('boom');

        const kinds = (query.mock.calls as Array<[string]>).map(([sql]) => sql);
        expect(kinds.some((sql) => /^ROLLBACK/i.test(sql))).toBe(true);
    });

    it('releases the client even when the transaction fails', async () => {
        const releaseSpy = client.release as jest.Mock;
        query.mockImplementation(async (sql: unknown) => {
            if (typeof sql === 'string' && /INSERT INTO concept_evidence/i.test(sql)) throw new Error('boom');
            return { rows: [] };
        });

        await expect(repo.insertMany('user-1', 'octo/repo', 42, 'sha1', [row()])).rejects.toThrow();
        expect(releaseSpy).toHaveBeenCalledTimes(1);
    });
});
