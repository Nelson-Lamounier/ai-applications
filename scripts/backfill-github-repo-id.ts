/**
 * CLI wrapper for the github_repo_id backfill.
 *
 * The library function `backfillGithubRepoId` (and its tests) live at
 * applications/shared/src/rds/backfillGithubRepoId.ts. It resolves each
 * repository's full_name via GitHub (following the 301 for renamed repos) and
 * propagates the immutable repo id into every denormalised repo-scoped table.
 *
 * Idempotent + re-runnable: rows already backfilled are skipped. A deleted/
 * inaccessible repo is reported as `unresolved` (a warning) and does not fail
 * the run.
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *   GITHUB_TOKEN=ghp_... \
 *   npx tsx scripts/backfill-github-repo-id.ts
 */

import { Pool } from 'pg';

import { GitHubAdapter } from '../applications/ingestion/src/acquisition/GitHubAdapter.js';
import { backfillGithubRepoId } from '../applications/shared/src/rds/backfillGithubRepoId.js';

async function main(): Promise<void> {
    const url = process.env['DATABASE_URL'] ?? process.env['TEST_DATABASE_URL'];
    if (!url) {
        console.error('DATABASE_URL or TEST_DATABASE_URL required');
        process.exit(2);
    }
    if (!process.env['GITHUB_TOKEN']) {
        console.error('GITHUB_TOKEN required');
        process.exit(2);
    }

    const pool = new Pool({ connectionString: url });
    const adapter = GitHubAdapter.fromEnvironment();

    try {
        const r = await backfillGithubRepoId({ pool, adapter });
        console.log(
            `backfill complete: ${r.resolved} resolved, ${r.unresolved.length} unresolved`,
        );
        for (const u of r.unresolved) {
            console.warn(`unresolved repo (skipped): user=${u.userId} full_name=${u.fullName}`);
        }
    } finally {
        await pool.end();
    }
}

main().catch((err) => {
    console.error('backfill failed:', err);
    process.exit(1);
});
