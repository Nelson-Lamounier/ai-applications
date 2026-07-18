/**
 * @format
 * Persistence for `unified_parity_runs` (migration 122) — one row per
 * (user_id, repo_full_name, commit_sha, source_layer) recording the
 * `UNIFIED_INGESTION` shadow gate's per-layer comparison between the legacy
 * two-job path's persisted `technology_evidence` and the unified job's
 * in-memory-computed evidence keys (see `../facts/parity/layer-parity.ts`).
 *
 * RLS parity with `RepoFactsRepository`: every write runs through the
 * shared `withUserRls(pool, userId, fn)` helper, which demotes the
 * transaction to `tucaken_app` via `SET LOCAL ROLE` and stamps
 * `SELECT set_config('app.current_user_id', $1, true)` so the
 * `rls_unified_parity_runs` policy
 * (`USING user_id = current_setting('app.current_user_id', true)::uuid`)
 * actually authorises the write. COMMIT on success, ROLLBACK on error,
 * release the client in `finally` — all handled by the shared helper.
 */
import type { Pool } from 'pg';
import { withUserRls } from '@bedrock/shared';

import type { LayerParity } from '../facts/parity/layer-parity.js';

export class UnifiedParityRunRepository {
    constructor(private readonly pool: Pool) {}

    /**
     * Persists one row per `LayerParity` entry for a single shadow-gate run.
     * A no-op (no connection acquired) when `rows` is empty.
     */
    async insertMany(userId: string, repoFullName: string, commitSha: string, rows: LayerParity[]): Promise<void> {
        if (rows.length === 0) return;

        await withUserRls(this.pool, userId, async (client) => {
            for (const r of rows) {
                await client.query(
                    `INSERT INTO unified_parity_runs (
                        user_id, repo_full_name, commit_sha, source_layer,
                        legacy_count, unified_count, intersection_count,
                        legacy_only_examples, unified_only_examples
                     ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
                    [
                        userId,
                        repoFullName,
                        commitSha,
                        r.sourceLayer,
                        r.legacyCount,
                        r.unifiedCount,
                        r.intersectionCount,
                        JSON.stringify(r.legacyOnlyExamples),
                        JSON.stringify(r.unifiedOnlyExamples),
                    ],
                );
            }
        });
    }
}
