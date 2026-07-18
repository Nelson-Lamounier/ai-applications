/**
 * @format
 * Row-level-security helper for writes against the platform RDS tables that
 * carry per-user RLS (resumes, job_applications, pipeline_runs).
 *
 * The job-strategist Job's pool connects to RDS as the superuser `postgres`
 * via `platform-rds-credentials` (rolbypassrls = true), NOT as the non-owner
 * role `tucaken_app`. A superuser bypasses RLS regardless of any session GUC,
 * so enforcement does not come from the connection identity — it comes from
 * `withUserRls` demoting the session for the lifetime of the transaction via
 * `SET LOCAL ROLE tucaken_app`, then setting the isolation GUC the policies
 * key on:
 *
 *   USING / WITH CHECK: user_id = current_setting('app.current_user_id', true)::uuid
 *
 * Both statements MUST run in the SAME transaction as the write, and MUST use
 * `SET LOCAL` (not a session-level `SET`/`SELECT set_config(..., false)`) —
 * for two compounding reasons:
 *   1. When the GUC is unset it reads as '' and `''::uuid` raises "invalid
 *      input syntax for type uuid", aborting the statement.
 *   2. pgbouncer runs in transaction-pooling mode, so a connection-level
 *      demotion/SET would leak the tucaken_app role — or a stale
 *      `app.current_user_id` — onto the next transaction that reuses the
 *      pooled connection. `SET LOCAL` auto-reverts at COMMIT/ROLLBACK,
 *      keeping every borrow of a pooled connection starting clean.
 *
 * This module is a thin re-export of the canonical `withUserRls` in
 * `@bedrock/shared` (`applications/shared/src/rds/with-user-rls.ts`), kept
 * here so the 9 existing call sites in this package do not need to change
 * their import path.
 */
export { withUserRls } from '@bedrock/shared';
