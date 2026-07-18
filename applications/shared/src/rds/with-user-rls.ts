/**
 * @format
 * withUserRls — the single demoting-transaction helper for every per-user RLS
 * write/read in this repo.
 *
 * Why demotion is required: every pool in this codebase connects to RDS as
 * the superuser `postgres` via `platform-rds-credentials` (BYPASSRLS). A bare
 * `SELECT set_config('app.current_user_id', ...)` on that connection sets the
 * GUC but never triggers policy evaluation, because a superuser bypasses RLS
 * regardless of the GUC — the ritual was inert. `SET LOCAL ROLE tucaken_app`
 * demotes the session to the non-owner role (rolbypassrls = false) for the
 * remainder of the transaction, so the `user_id = current_setting(...)::uuid`
 * policies actually run.
 *
 * `SET LOCAL` (not plain `SET ROLE`) auto-reverts at COMMIT/ROLLBACK, which
 * matters because pgbouncer runs in transaction-pooling mode: a
 * connection-level SET would leak the demoted role — or a stale
 * `app.current_user_id` — onto the next transaction that reuses the pooled
 * connection. Scoping both statements to the transaction with `SET LOCAL`
 * keeps every borrow of a pooled connection starting from a clean session.
 *
 * Canonical order (asserted in tests): BEGIN -> SET LOCAL ROLE tucaken_app ->
 * SELECT set_config('app.current_user_id', $1, true) -> fn's statements ->
 * COMMIT; ROLLBACK on error; client.release() always, in finally.
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
        await client.query('SET LOCAL ROLE tucaken_app');
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
