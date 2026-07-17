/**
 * @format
 * Row-level-security helper for writes against the platform RDS tables that
 * carry per-user RLS (resumes, job_applications, pipeline_runs).
 *
 * The job-strategist Job connects as the non-owner role `tucaken_app`
 * (rolbypassrls = false), so RLS is ENFORCED on its writes. The isolation
 * policy keys on a session GUC:
 *
 *   USING / WITH CHECK: user_id = current_setting('app.current_user_id', true)::uuid
 *
 * That GUC MUST be set, to the row's owner, in the SAME transaction as the
 * write — for two compounding reasons:
 *   1. When unset it reads as '' and `''::uuid` raises "invalid input syntax for
 *      type uuid", aborting the statement.
 *   2. pgbouncer runs in transaction-pooling mode, so a connection-level SET does
 *      not survive between transactions and a pooled connection may carry a stale
 *      context from an unrelated operation (→ the write silently matches 0 rows).
 *
 * `withUserRls` wraps the write in `BEGIN; set_config(..., is_local=true); …;
 * COMMIT` on a dedicated client, which makes the context deterministic. Mirrors
 * the pattern in shared/projects/system-tour/system-tour-persistence and shared/stage-prep.
 */
import type { Pool, PoolClient } from 'pg';

export async function withUserRls<T>(
    pool: Pool,
    userId: string,
    fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
}
