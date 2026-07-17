/**
 * @format
 * Persistence for `unified_parity_runs` (migration 122) — one row per
 * (user_id, repo_full_name, commit_sha, source_layer) recording the
 * `UNIFIED_INGESTION` shadow gate's per-layer comparison between the legacy
 * two-job path's persisted `technology_evidence` and the unified job's
 * in-memory-computed evidence keys (see `../facts/parity/layer-parity.ts`).
 *
 * RLS parity with `RepoFactsRepository`: every write opens a transaction
 * and stamps the current user with
 * `SELECT set_config('app.current_user_id', $1, true)` so the
 * `rls_unified_parity_runs` policy
 * (`USING user_id = current_setting('app.current_user_id', true)::uuid`)
 * authorises the write. COMMIT on success, ROLLBACK on error, release the
 * client in `finally`.
 */
import type { Pool } from 'pg';

import type { LayerParity } from '../facts/parity/layer-parity.js';

export class UnifiedParityRunRepository {
    constructor(private readonly pool: Pool) {}

    /**
     * Persists one row per `LayerParity` entry for a single shadow-gate run.
     * A no-op (no connection acquired) when `rows` is empty.
     */
    async insertMany(userId: string, repoFullName: string, commitSha: string, rows: LayerParity[]): Promise<void> {
        if (rows.length === 0) return;

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(
                `SELECT set_config('app.current_user_id', $1, true)`,
                [userId],
            );
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
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }
}
