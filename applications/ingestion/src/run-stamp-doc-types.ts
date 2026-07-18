/**
 * @format
 * docType backfill K8s Job entrypoint — stamps `metadata.docType` on the
 * docs-lane chunks of an existing corpus for a user, WITHOUT re-ingesting.
 * Same rationale as run-rollup.ts / run-build-repo-facts.ts: Task 1 stamps
 * `docType` going forward at the ChunkerRegistry choke point, so this
 * lightweight entrypoint is the one-off catch-up for chunks embedded before
 * that landed.
 *
 * Env vars:
 *   USER_ID                                          — required
 *   PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD
 *   REPO_FULL_NAME                                    — optional; when set,
 *     limits the backfill to that one repo instead of every repo with
 *     docs-lane chunks for the user.
 *
 * Exit codes: 0 = backfill ran, 1 = fatal (bad env / DB unreachable / a
 * repo's transaction failed and was rolled back).
 */
import { bootstrapK8sObservability, pushFinalMetrics } from '@bedrock/shared';
import { Pool } from 'pg';

import { backfillDocTypes } from './knowledge/doc-type-backfill.js';

const obs = bootstrapK8sObservability({ serviceName: 'doc-type-backfill' });
const log = obs.logger;

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

async function main(): Promise<void> {
    const userId = requireEnv('USER_ID');
    const repoFullName = process.env['REPO_FULL_NAME'];

    const pgPool = new Pool({
        host:     requireEnv('PG_HOST'),
        port:     Number.parseInt(process.env['PG_PORT'] ?? '5432', 10),
        database: requireEnv('PG_DATABASE'),
        user:     requireEnv('PG_USER'),
        password: requireEnv('PG_PASSWORD'),
        max:      3,
    });

    log.info({ userId, repoFullName }, 'doc_type_backfill.start');

    try {
        const result = await backfillDocTypes(pgPool, userId, repoFullName);

        log.info({
            event:     'doc_type_backfill.complete',
            userId,
            repoFullName,
            repos:     result.repos,
            files:     result.files,
            byDocType: result.byDocType,
        }, 'docType backfill complete');
    } finally {
        await pgPool.end().catch(() => { /* best-effort drain */ });
        await pushFinalMetrics(obs.registry, 'doc-type-backfill', userId).catch(() => { /* best-effort */ });
        await obs.shutdown().catch(() => { /* flush spans */ });
    }
}

// Only auto-execute when run as the K8s Job entrypoint, not when imported by tests.
if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch((err) => {
            log.error({ err }, 'doc_type_backfill.failed');
            process.exit(1);
        });
}
