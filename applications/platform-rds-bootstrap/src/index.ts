/**
 * @format
 * Platform RDS Bootstrap — DDL runner (K8s Job entrypoint)
 *
 * Runs idempotent DDL: pgvector extension, all platform tables, indexes,
 * and all numbered migration files in src/migrations/ (in lexical order).
 * Exits 0 on success, non-zero on error (K8s Job backoffLimit handles
 * retries).
 *
 * Connects directly to RDS (not via PgBouncer) — PgBouncer may not be
 * ready on first deploy.
 *
 * Implementation lives in `bootstrap.ts` so the same DDL + migration
 * loader is importable by the migration E2E test without triggering
 * `main()` as a side effect of import.
 *
 * Env vars from ESO-synced secrets:
 *   PGHOST      — RDS endpoint (from platform-rds-config)
 *   PGPORT      — 5432 (from platform-rds-config)
 *   PGDATABASE  — tucaken (from platform-rds-config)
 *   PGUSER      — postgres (from platform-rds-credentials)
 *   PGPASSWORD  — auto-generated (from platform-rds-credentials)
 */
import { createPool, runBootstrap } from './bootstrap';

async function main(): Promise<void> {
    console.log('Platform RDS bootstrap starting...');
    const pool = createPool();
    try {
        await runBootstrap(pool);
        console.log('Bootstrap complete.');
    } finally {
        await pool.end();
    }
}

main().catch((err) => {
    console.error('Bootstrap failed:', err);
    process.exit(1);
});
