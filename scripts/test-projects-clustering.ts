/**
 * @format
 * E2E test for the Project Clustering service (Phase 2A).
 *
 *   just test-projects-clustering
 *
 * What it does:
 *   1. Creates an ephemeral `tucaken_test_<ts>` database.
 *   2. Runs the full platform-rds-bootstrap (base DDL + migrations,
 *      including 030–032).
 *   3. Seeds Alice with four repos (two share a naming prefix), plus a
 *      repository_profile + description embedding for each so the signal
 *      extractors have real inputs.
 *   4. Injects a MockClusteringAgent that groups the two `tucaken-*` repos
 *      and exercises the orchestrator + persistence end-to-end.
 *   5. Asserts:
 *        - exactly one multi-repo proposal inserted
 *        - two components inserted
 *        - two project_repositories links
 *        - proposal_pipeline_run_id / proposal_reasoning / proposal_confidence
 *          populated
 *        - signal extractors find the shared prefix + the embedding pair
 *   6. Re-runs and asserts: priorProposalsCleared=1, proposalsInserted=1,
 *      no duplicate project_repositories rows.
 *   7. Marks one of the tucaken repos as part of a confirmed project,
 *      re-runs, asserts the confirmed repo is dropped from the new
 *      proposal (proposal becomes single-repo and is skipped).
 *   8. Exercises the feature-flag wrapper: false by default, true after
 *      `upsertFeatureFlag`, allow_users / deny_users / rollout-by-bucket.
 *   9. Drops the test database.
 *
 * Prerequisites:
 *   - Postgres with `vector` + `uuid-ossp` extensions (use
 *     `pgvector/pgvector:pg16`).
 *   - Connecting role has CREATEDB.
 *   - Env: PGHOST, PGPORT, PGUSER, PGPASSWORD. PGSSL=disable for local.
 */
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { Pool } from 'pg';

import {
    DDL,
    loadMigrations,
} from '../applications/platform-rds-bootstrap/src/bootstrap.js';
import {
    buildClusteringSignals,
    clearFeatureFlagCache,
    extractNamingPrefixes,
    isFeatureEnabled,
    runClusteringOrchestration,
    upsertFeatureFlag,
} from '../applications/shared/src/index.js';
import type {
    BasePipelineContext,
    ClusteringAgent,
    ClusteringResult,
    ClusteringSignals,
    RepoClusteringDigest,
} from '../applications/shared/src/index.js';

const TEST_DB_PREFIX = 'tucaken_test_';
const MIGRATIONS_DIR = path.resolve(
    __dirname,
    '../applications/platform-rds-bootstrap/migrations',
);

function adminPool(): Pool {
    return new Pool({
        host:     process.env.PGHOST,
        port:     parseInt(process.env.PGPORT ?? '5432', 10),
        database: 'postgres',
        user:     process.env.PGUSER,
        password: process.env.PGPASSWORD,
        ssl:      process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
        max:      1,
        connectionTimeoutMillis: 10_000,
    });
}

function targetPool(database: string): Pool {
    return new Pool({
        host:     process.env.PGHOST,
        port:     parseInt(process.env.PGPORT ?? '5432', 10),
        database,
        user:     process.env.PGUSER,
        password: process.env.PGPASSWORD,
        ssl:      process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
        max:      3,
        connectionTimeoutMillis: 10_000,
    });
}

async function applyAll(pool: Pool): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query(DDL);
        for (const { sql } of loadMigrations(MIGRATIONS_DIR)) {
            await client.query(sql);
        }
    } finally {
        client.release();
    }
}

// ─── Seed helpers ───────────────────────────────────────────────────────────

interface Seed {
    userId:                 string;
    pipelineRunId:          string;
    repoIdsByShortName:     Map<string, string>;
    profileIdsByShortName:  Map<string, string>;
}

function randomVector1024(seed: number): number[] {
    // Deterministic pseudo-random unit vector — same seed always produces
    // the same direction. Used so cosine similarity is predictable in tests.
    const out = new Array<number>(1024);
    let x = seed;
    for (let i = 0; i < 1024; i++) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        out[i] = ((x / 0x7fffffff) * 2) - 1;
    }
    // Normalise so cosine math sits in [-1, 1].
    let norm = 0;
    for (let i = 0; i < 1024; i++) norm += out[i] * out[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < 1024; i++) out[i] /= norm;
    return out;
}

function vectorLiteral(values: readonly number[]): string {
    return `[${values.map((v) => v.toString()).join(',')}]`;
}

async function seed(pool: Pool): Promise<Seed> {
    const client = await pool.connect();
    try {
        const user = await client.query<{ id: string }>(
            `INSERT INTO users (email, full_name) VALUES ($1, $2) RETURNING id`,
            ['alice@example.test', 'Alice'],
        );
        const userId = user.rows[0].id;

        const repoIdsByShortName = new Map<string, string>();
        const profileIdsByShortName = new Map<string, string>();

        // Two repos share the `tucaken-` prefix; the model is expected to
        // cluster these. The other two are deliberate singletons.
        const repos: { fullName: string; topics: string[]; tech: string[] }[] = [
            { fullName: 'alice/tucaken-api', topics: ['rag', 'aws'],          tech: ['typescript', 'aws-cdk', 'postgres'] },
            { fullName: 'alice/tucaken-web', topics: ['rag', 'tailwind'],     tech: ['typescript', 'react', 'tailwind'] },
            { fullName: 'alice/notes-cli',   topics: ['cli', 'productivity'], tech: ['go'] },
            { fullName: 'alice/learning-rust', topics: ['rust'],              tech: ['rust'] },
        ];

        for (let i = 0; i < repos.length; i++) {
            const { fullName, topics, tech } = repos[i];
            const repo = await client.query<{ id: string }>(
                `INSERT INTO repositories (user_id, provider, full_name, topics, added_at, indexed_at)
                 VALUES ($1, 'github', $2, $3, NOW(), NOW())
                 RETURNING id`,
                [userId, fullName, topics],
            );
            const repoId = repo.rows[0].id;
            const shortName = fullName.split('/')[1];
            repoIdsByShortName.set(shortName, repoId);

            const profile = await client.query<{ id: string }>(
                `INSERT INTO repository_profiles (
                    user_id, repository_id, repo_full_name, extracted, classification,
                    extraction_status, extracted_at
                 )
                 VALUES ($1, $2, $3, $4::jsonb, 'project', 'completed', NOW())
                 RETURNING id`,
                [userId, repoId, fullName, JSON.stringify({ tech_stack: tech })],
            );
            profileIdsByShortName.set(shortName, profile.rows[0].id);

            // Embeddings: tucaken-* share a base direction (high cosine);
            // others get distinct seeds (low cosine to the cluster).
            const isTucaken = shortName.startsWith('tucaken-');
            const embeddingSeed = isTucaken ? 100 + i : 9000 + i * 31;
            const embedding = randomVector1024(embeddingSeed);
            if (isTucaken) {
                // Mix in 95% of the base tucaken direction so the two are highly similar.
                const base = randomVector1024(50);
                for (let j = 0; j < 1024; j++) embedding[j] = 0.95 * base[j] + 0.05 * embedding[j];
                let norm = 0;
                for (let j = 0; j < 1024; j++) norm += embedding[j] * embedding[j];
                norm = Math.sqrt(norm);
                for (let j = 0; j < 1024; j++) embedding[j] /= norm;
            }

            await client.query(
                `INSERT INTO repository_profile_embeddings (
                    user_id, profile_id, chunk_type, content, content_hash, embedding
                 )
                 VALUES ($1, $2, 'description', $3, $4, $5::vector)`,
                [userId, profile.rows[0].id, `desc-${shortName}`, `hash-${shortName}-${i}`, vectorLiteral(embedding)],
            );
        }

        // Run 031 backfill to create the default single-repo projects.
        const backfillSql = await import('node:fs').then((fs) =>
            fs.readFileSync(path.join(MIGRATIONS_DIR, '031_projects_backfill.sql'), 'utf8'),
        );
        await client.query(backfillSql);

        // Create the pipeline_runs row this orchestrator will reference.
        const pipelineRun = await client.query<{ id: string }>(
            `INSERT INTO pipeline_runs (user_id, pipeline_type, status)
             VALUES ($1, 'clustering', 'queued')
             RETURNING id`,
            [userId],
        );

        return {
            userId,
            pipelineRunId: pipelineRun.rows[0].id,
            repoIdsByShortName,
            profileIdsByShortName,
        };
    } finally {
        client.release();
    }
}

// ─── Mock agent ─────────────────────────────────────────────────────────────

function makeMockAgent(behavior: (digests: readonly RepoClusteringDigest[], signals: ClusteringSignals) => ClusteringResult): ClusteringAgent {
    return {
        async invoke(digests, signals, ctx) {
            const data = behavior(digests, signals);
            return {
                data,
                ctx,
                tokens: { input: 0, output: 0, thinking: 0 },
                costUsd: 0,
                durationMs: 0,
            } as unknown as { data: ClusteringResult } as Awaited<ReturnType<ClusteringAgent['invoke']>>;
        },
    };
}

function ctxFor(pipelineRunId: string): BasePipelineContext {
    return {
        pipelineId:        pipelineRunId,
        environment:       'test',
        cumulativeTokens:  { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
    };
}

// ─── Assertions ─────────────────────────────────────────────────────────────

async function rowCount(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
    const r = await pool.query<{ count: string }>(sql, params);
    return parseInt(r.rows[0].count, 10);
}

async function assertSignalExtraction(seed: Seed, pool: Pool): Promise<void> {
    // Direct unit-style test of extractNamingPrefixes on the seeded digests.
    const r = await pool.query<{
        repository_id: string;
        full_name:     string;
    }>(`SELECT id AS repository_id, full_name FROM repositories WHERE user_id = $1`, [seed.userId]);
    const digests: RepoClusteringDigest[] = r.rows.map((row) => ({
        repositoryId:    row.repository_id,
        fullName:        row.full_name,
        shortName:       row.full_name.split('/')[1],
        primaryLanguage: null,
        topics:          [],
        firstSeenAt:     null,
        lastSyncedAt:    null,
        techStack:       [],
        classification:  null,
    }));
    const prefixes = extractNamingPrefixes(digests);
    const tucakenRepos = prefixes.get('tucaken');
    assert.ok(tucakenRepos, 'naming prefix `tucaken` should be found');
    assert.equal(tucakenRepos!.length, 2, 'two repos share the tucaken prefix');

    // Spot-check that buildClusteringSignals returns the embedding pair too.
    const embeddings = (await pool.query<{ repo_full_name: string; embedding: string }>(
        `SELECT rp.repo_full_name, rpe.embedding::text AS embedding
         FROM repository_profile_embeddings rpe
         JOIN repository_profiles rp ON rp.id = rpe.profile_id
         WHERE rpe.user_id = $1 AND rpe.chunk_type = 'description'`,
        [seed.userId],
    )).rows.map((row) => ({
        repoFullName: row.repo_full_name,
        embedding:    row.embedding.slice(1, -1).split(',').map(Number),
    }));
    const signals = buildClusteringSignals(digests, embeddings);
    const tucakenPair = signals.embeddingPairs.find((p) =>
        (p.repoA.endsWith('tucaken-api') && p.repoB.endsWith('tucaken-web')) ||
        (p.repoB.endsWith('tucaken-api') && p.repoA.endsWith('tucaken-web')),
    );
    assert.ok(tucakenPair, 'embedding pair across tucaken-api and tucaken-web should exist');
    assert.ok(tucakenPair!.score >= 0.78, 'cosine score should exceed default threshold');
}

async function assertProposalState(seed: Seed, pool: Pool): Promise<void> {
    const proposals = await rowCount(
        pool,
        `SELECT COUNT(*)::text AS count FROM projects
         WHERE user_id = $1 AND is_ai_suggested = TRUE AND is_user_confirmed = FALSE
           AND shape = 'multi_repo'`,
        [seed.userId],
    );
    assert.equal(proposals, 1, 'one multi-repo proposal');

    const components = await rowCount(
        pool,
        `SELECT COUNT(*)::text AS count
         FROM project_components pc
         JOIN projects p ON p.id = pc.project_id
         WHERE p.user_id = $1 AND p.is_ai_suggested = TRUE AND p.shape = 'multi_repo'`,
        [seed.userId],
    );
    assert.equal(components, 2, 'two components on the proposal');

    const links = await rowCount(
        pool,
        `SELECT COUNT(*)::text AS count
         FROM project_repositories pr
         JOIN project_components pc ON pc.id = pr.project_component_id
         JOIN projects p ON p.id = pc.project_id
         WHERE p.user_id = $1 AND p.is_ai_suggested = TRUE AND p.shape = 'multi_repo'`,
        [seed.userId],
    );
    assert.equal(links, 2, 'two project_repositories links on the proposal');

    const detail = await pool.query<{
        proposal_pipeline_run_id: string;
        proposal_reasoning:       string;
        proposal_confidence:      string;
    }>(
        `SELECT proposal_pipeline_run_id, proposal_reasoning, proposal_confidence
         FROM projects
         WHERE user_id = $1 AND is_ai_suggested = TRUE AND shape = 'multi_repo'`,
        [seed.userId],
    );
    assert.equal(detail.rows[0].proposal_pipeline_run_id, seed.pipelineRunId, 'pipeline_run_id linked');
    assert.match(detail.rows[0].proposal_reasoning ?? '', /tucaken/i, 'reasoning mentions tucaken');
    assert.equal(detail.rows[0].proposal_confidence, 'high');
}

async function assertFeatureFlagBehaviour(pool: Pool, userId: string): Promise<void> {
    clearFeatureFlagCache();
    assert.equal(await isFeatureEnabled(pool, 'projects.clustering.enabled'), false,
        'unseeded flag defaults to false');

    await upsertFeatureFlag(pool, 'projects.clustering.enabled', { enabled: true, rollout: 1 });
    assert.equal(await isFeatureEnabled(pool, 'projects.clustering.enabled', userId), true,
        'enabled+rollout=1 returns true');

    await upsertFeatureFlag(pool, 'projects.clustering.enabled', {
        enabled: true, rollout: 1, deny_users: [userId],
    });
    assert.equal(await isFeatureEnabled(pool, 'projects.clustering.enabled', userId), false,
        'deny_users wins over rollout');

    await upsertFeatureFlag(pool, 'projects.clustering.enabled', {
        enabled: true, rollout: 0, allow_users: [userId],
    });
    assert.equal(await isFeatureEnabled(pool, 'projects.clustering.enabled', userId), true,
        'allow_users wins over rollout=0');

    await upsertFeatureFlag(pool, 'projects.clustering.enabled', { enabled: false });
    assert.equal(await isFeatureEnabled(pool, 'projects.clustering.enabled', userId), false,
        'enabled=false overrides everything');
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    if (!process.env.PGHOST || !process.env.PGUSER) {
         
        console.error('PGHOST and PGUSER must be set');
        process.exit(2);
    }
    const dbName = `${TEST_DB_PREFIX}${Date.now()}`;
    const admin  = adminPool();

    try {
         
        console.log(`Creating test database ${dbName}...`);
        const adminClient = await admin.connect();
        try { await adminClient.query(`CREATE DATABASE "${dbName}"`); }
        finally { adminClient.release(); }

        const pool = targetPool(dbName);
        try {
             
            console.log('Applying base DDL + every numbered migration...');
            await applyAll(pool);

             
            console.log('Seeding Alice with four repos + profiles + embeddings...');
            const seedResult = await seed(pool);

             
            console.log('Asserting signal extraction (prefixes + embedding pair)...');
            await assertSignalExtraction(seedResult, pool);

            // First clustering run: mock agent emits a tucaken-api + tucaken-web grouping.
            const mockAgent = makeMockAgent((digests) => {
                const tucakenApi = digests.find((d) => d.shortName === 'tucaken-api')!;
                const tucakenWeb = digests.find((d) => d.shortName === 'tucaken-web')!;
                return {
                    proposals: [{
                        name:       'Tucaken',
                        confidence: 'high',
                        reasoning:  'Shared `tucaken-` prefix and tightly coupled tech stack (TypeScript + AWS).',
                        components: [
                            { name: 'API',      kind: 'backend',  repositoryIds: [tucakenApi.repositoryId] },
                            { name: 'Frontend', kind: 'frontend', repositoryIds: [tucakenWeb.repositoryId] },
                        ],
                    }],
                };
            });

             
            console.log('Running orchestration with mocked clustering agent...');
            const out1 = await runClusteringOrchestration(pool, {
                userId:        seedResult.userId,
                pipelineRunId: seedResult.pipelineRunId,
                agent:         mockAgent,
                ctx:           ctxFor(seedResult.pipelineRunId),
            });
            assert.equal(out1.persisted.proposalsInserted, 1);
            assert.equal(out1.persisted.componentsInserted, 2);
            assert.equal(out1.persisted.linksInserted, 2);
            assert.equal(out1.persisted.priorProposalsCleared, 0);

             
            console.log('Asserting proposal state...');
            await assertProposalState(seedResult, pool);

            // Re-run: prior proposal should be cleared, new one inserted.
             
            console.log('Re-running orchestration; expecting prior proposal cleared...');
            const out2 = await runClusteringOrchestration(pool, {
                userId:        seedResult.userId,
                pipelineRunId: seedResult.pipelineRunId,
                agent:         mockAgent,
                ctx:           ctxFor(seedResult.pipelineRunId),
            });
            assert.equal(out2.persisted.priorProposalsCleared, 1);
            assert.equal(out2.persisted.proposalsInserted, 1);
            await assertProposalState(seedResult, pool);

            // Confirm one of the tucaken proposals — re-run should skip the
            // proposal because both repos are now in confirmed projects.
             
            console.log('Confirming Tucaken proposal; re-run should skip it...');
            await pool.query(
                `UPDATE projects SET is_user_confirmed = TRUE
                 WHERE user_id = $1 AND is_ai_suggested = TRUE AND shape = 'multi_repo'`,
                [seedResult.userId],
            );
            const out3 = await runClusteringOrchestration(pool, {
                userId:        seedResult.userId,
                pipelineRunId: seedResult.pipelineRunId,
                agent:         mockAgent,
                ctx:           ctxFor(seedResult.pipelineRunId),
            });
            assert.equal(out3.persisted.proposalsInserted, 0,
                'confirmed repos must not be re-proposed');
            assert.equal(out3.persisted.proposalsSkipped, 1,
                'the filtered proposal must register as skipped');

             
            console.log('Asserting feature-flag behaviour...');
            await assertFeatureFlagBehaviour(pool, seedResult.userId);

             
            console.log('OK — all assertions passed.');
        } finally {
            await pool.end();
        }
    } finally {
        const adminClient = await admin.connect();
        try {
            await adminClient.query(
                `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                 WHERE datname = $1 AND pid <> pg_backend_pid()`,
                [dbName],
            );
            await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}"`);
             
            console.log(`Dropped test database ${dbName}.`);
        } catch (err) {
             
            console.warn(`Failed to drop test database ${dbName}:`, err);
        } finally {
            adminClient.release();
        }
        await admin.end();
    }
}

main().catch((err) => {
     
    console.error('Clustering E2E failed:', err);
    process.exit(1);
});
