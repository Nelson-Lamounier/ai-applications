/**
 * @format
 * E2E test for the Projects multi-repo migration (030 + 031).
 *
 *   just test-projects-migration
 *
 * What it does:
 *   1. Connects to PGHOST as PGUSER (must have CREATEDB).
 *   2. Creates an ephemeral database `tucaken_test_<timestamp>`.
 *   3. Runs the full platform-rds-bootstrap (base DDL + every migration,
 *      including 030 + 031) — verifies the schema is buildable from
 *      scratch and that 031 is a no-op on an empty database.
 *   4. Seeds two users with a handful of repos each.
 *   5. Re-applies 031 — the production backfill case (repos existed
 *      before the migration shipped).
 *   6. Asserts the row counts, slug uniqueness, FK shape, and RLS
 *      isolation that the migration spec requires.
 *   7. Re-applies 031 once more and asserts row counts are unchanged
 *      (idempotency).
 *   8. Drops the test database.
 *
 * Prerequisites:
 *   - PostgreSQL ≥ 14 with `vector` and `uuid-ossp` extensions available
 *     (use `pgvector/pgvector:pg15` for local Docker).
 *   - Connecting role has CREATEDB.
 *   - Env: PGHOST, PGPORT, PGUSER, PGPASSWORD. PGSSL=disable for local.
 *
 * No live AWS resources, no Bedrock calls — pure schema-level test.
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Pool } from 'pg';

import {
    DDL,
    loadMigrations,
} from '../applications/platform-rds-bootstrap/src/bootstrap.js';

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
        max:      1,
        connectionTimeoutMillis: 10_000,
    });
}

function readMigration(name: string): string {
    return fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
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

async function applyOne(pool: Pool, name: string): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query(readMigration(name));
    } finally {
        client.release();
    }
}

interface SeedResult {
    user1Id: string;
    user2Id: string;
    user1RepoIds: string[];
    user2RepoIds: string[];
}

async function seed(pool: Pool): Promise<SeedResult> {
    const client = await pool.connect();
    try {
        const u1 = await client.query<{ id: string }>(
            `INSERT INTO users (email, full_name) VALUES ($1, $2) RETURNING id`,
            ['alice@example.test', 'Alice'],
        );
        const u2 = await client.query<{ id: string }>(
            `INSERT INTO users (email, full_name) VALUES ($1, $2) RETURNING id`,
            ['bob@example.test', 'Bob'],
        );
        const user1Id = u1.rows[0].id;
        const user2Id = u2.rows[0].id;

        const insertRepo = async (userId: string, fullName: string) => {
            const r = await client.query<{ id: string }>(
                `INSERT INTO repositories (user_id, provider, full_name)
                 VALUES ($1, 'github', $2) RETURNING id`,
                [userId, fullName],
            );
            return r.rows[0].id;
        };

        const user1RepoIds = [
            await insertRepo(user1Id, 'alice/tucaken-frontend'),
            await insertRepo(user1Id, 'alice/tucaken-api'),
            await insertRepo(user1Id, 'alice/tucaken-infra'),
        ];
        const user2RepoIds = [
            await insertRepo(user2Id, 'bob/side-project'),
            await insertRepo(user2Id, 'bob/learning-rust'),
        ];

        return { user1Id, user2Id, user1RepoIds, user2RepoIds };
    } finally {
        client.release();
    }
}

async function rowCount(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
    const client = await pool.connect();
    try {
        const r = await client.query<{ count: string }>(sql, params);
        return parseInt(r.rows[0].count, 10);
    } finally {
        client.release();
    }
}

async function assertSchemaShape(pool: Pool): Promise<void> {
    const expectedTables = [
        'projects',
        'project_components',
        'project_repositories',
        'project_tags',
        'project_stack_items',
        'project_decisions',
        'project_highlights',
        'project_challenges',
        'project_resume_bullets',
        'project_depth_markers',
        'project_architecture',
    ];
    const client = await pool.connect();
    try {
        for (const t of expectedTables) {
            const r = await client.query<{ exists: boolean }>(
                `SELECT EXISTS (
                   SELECT 1 FROM information_schema.tables
                   WHERE table_schema = 'public' AND table_name = $1
                 ) AS exists`,
                [t],
            );
            assert.equal(r.rows[0].exists, true, `table ${t} should exist`);
        }
        // summary_embedding column exists with vector(1024) type
        const col = await client.query<{ udt_name: string }>(
            `SELECT udt_name FROM information_schema.columns
             WHERE table_name = 'projects' AND column_name = 'summary_embedding'`,
        );
        assert.equal(col.rows[0]?.udt_name, 'vector', 'summary_embedding should be a vector');

        // RLS enabled on every projects-domain table
        for (const t of expectedTables) {
            const r = await client.query<{ relrowsecurity: boolean }>(
                `SELECT relrowsecurity FROM pg_class
                 WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
                [t],
            );
            assert.equal(r.rows[0]?.relrowsecurity, true, `RLS should be enabled on ${t}`);
        }
    } finally {
        client.release();
    }
}

async function assertBackfill(pool: Pool, seed: SeedResult): Promise<void> {
    const expectedProjects = seed.user1RepoIds.length + seed.user2RepoIds.length;

    assert.equal(
        await rowCount(pool, 'SELECT COUNT(*)::text AS count FROM projects'),
        expectedProjects,
        'one project per repo',
    );
    assert.equal(
        await rowCount(pool, 'SELECT COUNT(*)::text AS count FROM project_components'),
        expectedProjects,
        'one component per project',
    );
    assert.equal(
        await rowCount(pool, 'SELECT COUNT(*)::text AS count FROM project_repositories'),
        expectedProjects,
        'one project_repositories link per repo',
    );

    // Per-user slug uniqueness
    const dup = await rowCount(
        pool,
        `SELECT COUNT(*)::text AS count FROM (
           SELECT user_id, slug, COUNT(*) AS n
           FROM projects GROUP BY user_id, slug HAVING COUNT(*) > 1
         ) d`,
    );
    assert.equal(dup, 0, 'no duplicate slugs per user');

    // Every project_repositories.repository_id traces back to a real repo
    // owned by the same user as the project
    const client = await pool.connect();
    try {
        const r = await client.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count
             FROM project_repositories pr
             JOIN project_components pc ON pc.id = pr.project_component_id
             JOIN projects p ON p.id = pc.project_id
             JOIN repositories r ON r.id = pr.repository_id
             WHERE r.user_id <> p.user_id`,
        );
        assert.equal(parseInt(r.rows[0].count, 10), 0, 'no cross-user project↔repo links');

        // Backfill defaults look right
        const sample = await client.query<{
            shape: string;
            is_ai_suggested: boolean;
            is_user_confirmed: boolean;
            kind: string;
        }>(`
            SELECT p.shape, p.is_ai_suggested, p.is_user_confirmed, pc.kind
            FROM projects p JOIN project_components pc ON pc.project_id = p.id
            LIMIT 1
        `);
        const row = sample.rows[0];
        assert.equal(row?.shape, 'single_repo', 'backfilled shape');
        assert.equal(row?.is_ai_suggested, false, 'backfilled is_ai_suggested');
        assert.equal(row?.is_user_confirmed, false, 'backfilled is_user_confirmed');
        assert.equal(row?.kind, 'shared', 'backfilled component kind');
    } finally {
        client.release();
    }
}

async function assertRlsIsolation(pool: Pool, seed: SeedResult): Promise<void> {
    // `set_config(..., true)` is transaction-scoped (LOCAL); wrap each
    // user's read in its own BEGIN/COMMIT so the policy resolves the
    // expected id. Superusers bypass RLS, so SET ROLE first.
    const checkAs = async (userId: string): Promise<number> => {
        const client = await pool.connect();
        try {
            await client.query(`SET ROLE tucaken_app`);
            await client.query(`BEGIN`);
            try {
                await client.query(
                    `SELECT set_config('app.current_user_id', $1, true)`,
                    [userId],
                );
                const r = await client.query<{ count: string }>(
                    `SELECT COUNT(*)::text AS count FROM projects`,
                );
                return parseInt(r.rows[0].count, 10);
            } finally {
                await client.query(`COMMIT`);
                await client.query(`RESET ROLE`);
            }
        } finally {
            client.release();
        }
    };

    assert.equal(
        await checkAs(seed.user1Id),
        seed.user1RepoIds.length,
        'alice sees only her projects',
    );
    assert.equal(
        await checkAs(seed.user2Id),
        seed.user2RepoIds.length,
        'bob sees only his projects',
    );
}

async function assertIdempotent(pool: Pool, seed: SeedResult): Promise<void> {
    const before = await rowCount(pool, 'SELECT COUNT(*)::text AS count FROM projects');
    await applyOne(pool, '031_projects_backfill.sql');
    const after = await rowCount(pool, 'SELECT COUNT(*)::text AS count FROM projects');
    assert.equal(after, before, 're-running 031 must not create new projects');
    assert.equal(
        after,
        seed.user1RepoIds.length + seed.user2RepoIds.length,
        'project count stable across re-runs',
    );
}

async function main(): Promise<void> {
    if (!process.env.PGHOST || !process.env.PGUSER) {
        console.error('PGHOST and PGUSER must be set');
        process.exit(2);
    }

    const dbName = `${TEST_DB_PREFIX}${Date.now()}`;
    const admin = adminPool();

    try {
        console.log(`Creating test database ${dbName}...`);
        const adminClient = await admin.connect();
        try {
            await adminClient.query(`CREATE DATABASE "${dbName}"`);
        } finally {
            adminClient.release();
        }

        const pool = targetPool(dbName);
        try {
            console.log('Applying base DDL + every numbered migration...');
            await applyAll(pool);

            console.log('Asserting schema shape...');
            await assertSchemaShape(pool);

            // 031 on an empty DB is a no-op
            assert.equal(
                await rowCount(pool, 'SELECT COUNT(*)::text AS count FROM projects'),
                0,
                '031 backfill must be a no-op on empty DB',
            );

            console.log('Seeding users and repos...');
            const seedResult = await seed(pool);

            console.log('Re-applying 031 to backfill seeded repos...');
            await applyOne(pool, '031_projects_backfill.sql');

            console.log('Asserting backfill...');
            await assertBackfill(pool, seedResult);

            console.log('Asserting RLS isolation...');
            await assertRlsIsolation(pool, seedResult);

            console.log('Asserting idempotency...');
            await assertIdempotent(pool, seedResult);

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
    console.error('Migration E2E failed:', err);
    process.exit(1);
});
