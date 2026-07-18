/**
 * @format
 * repo_facts backfill K8s Job entrypoint — (re)computes `repo_facts` for a
 * user's repos WITHOUT re-ingesting. Same rationale as run-rollup.ts: the
 * only place `repo_facts` gets built is the best-effort hook inside
 * run-ingestion.ts (right after `applyDeterministicProfileFacts`), so the
 * only way to backfill users ingested before that hook shipped is a full
 * re-embed (~minutes per repo). This lightweight entrypoint re-reads each of
 * the user's repositories and (re)builds its fact sheet only.
 *
 * Env vars:
 *   USER_ID                                          — required
 *   PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD
 *   REPO_FULL_NAME                                    — optional; when set,
 *     limits the backfill to that one repo instead of looping every repo the
 *     user owns.
 *
 * Exit codes: 0 = backfill ran (best-effort per repo — one repo's failure is
 * logged and does not stop the rest), 1 = fatal (bad env / DB unreachable).
 */

import { bootstrapK8sObservability, pushFinalMetrics } from '@bedrock/shared';
import { Pool } from 'pg';

import { buildRepoFactsBatch } from './facts/build-repo-facts.js';

const obs = bootstrapK8sObservability({ serviceName: 'repo-facts-backfill' });
const log = obs.logger;

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

async function loadRepoFullNames(pool: Pool, userId: string): Promise<string[]> {
    const { rows } = await pool.query<{ full_name: string }>(
        'SELECT full_name FROM repositories WHERE user_id = $1::uuid',
        [userId],
    );
    return rows.map((row) => row.full_name);
}

async function main(): Promise<void> {
    const userId = requireEnv('USER_ID');

    const pgPool = new Pool({
        host:     requireEnv('PG_HOST'),
        port:     Number.parseInt(process.env['PG_PORT'] ?? '5432', 10),
        database: requireEnv('PG_DATABASE'),
        user:     requireEnv('PG_USER'),
        password: requireEnv('PG_PASSWORD'),
        max:      3,
    });

    log.info({ userId }, 'repo_facts_backfill.start');

    let repoFullNames: string[] = [];

    try {
        const single = process.env['REPO_FULL_NAME'];
        repoFullNames = single ? [single] : await loadRepoFullNames(pgPool, userId);

        // buildRepoFactsBatch loads the user's role-signals ONCE for the whole
        // batch (rather than once per repo, as looping buildRepoFacts did) and
        // isolates each repo's failure with its own try/catch internally.
        const { succeeded, failed } = await buildRepoFactsBatch(pgPool, userId, repoFullNames, (repoFullName, err) => {
            log.warn({ err, userId, repoFullName }, 'repo_facts_backfill.repo_failed');
        });

        log.info({
            event:     'repo_facts_backfill.complete',
            userId,
            total:     repoFullNames.length,
            succeeded,
            failed,
        }, 'repo_facts backfill complete');
    } finally {
        await pgPool.end().catch(() => { /* best-effort drain */ });
        await pushFinalMetrics(obs.registry, 'repo-facts-backfill', userId).catch(() => { /* best-effort */ });
        await obs.shutdown().catch(() => { /* flush spans */ });
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        log.error({ err }, 'repo_facts_backfill.failed');
        process.exit(1);
    });
