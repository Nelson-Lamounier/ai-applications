/**
 * @format
 * reconcileRepoName — idempotently refresh the denormalised `repo_full_name`
 * label everywhere when a GitHub repository is renamed (or transferred to a new
 * owner), keyed on the immutable numeric `github_repo_id`.
 *
 * Every repo-scoped row is denormalised with the mutable `owner/name` label.
 * When GitHub renames a repo, that label goes stale. Because every row also
 * carries the immutable `github_repo_id` (migration 084 + the dual-write on
 * connect/ingest), we can heal a rename by re-stamping the label on every table
 * whose row matches `(user_id, github_repo_id)` — no re-ingest required.
 *
 * This is the ai-applications twin of the admin-api `reconcileRepoName`
 * (tucaken-app/admin-api/src/lib/reconcile-repo-name.ts): same tables, same
 * one-shape `user_id` binding, same transaction shape. The ingestion worker
 * calls it at the start of a sync to self-heal a stale stored name before it
 * fetches, so a renamed repo is followed by its immutable id rather than failing
 * on a 404 for the old name.
 *
 * Idempotency:
 *   The function reads the anchor's current `full_name` first. If the repo is
 *   unknown (no anchor row for this id) or the label already equals the new
 *   name, it is a no-op — no connection is acquired and no transaction begins.
 *
 * Atomicity:
 *   When a change is needed, all UPDATEs run inside a single transaction on ONE
 *   pooled connection (`pool.connect()` → BEGIN → all UPDATEs → COMMIT). A Pool
 *   hands each `pool.query` an arbitrary connection, so BEGIN/COMMIT MUST be
 *   issued on a single `client` to form a real transaction. ROLLBACK + rethrow
 *   on error; the connection is always released.
 *
 * user_id typing:
 *   `repo_sync_state.user_id` and `document_embeddings.user_id` are TEXT while
 *   every other table's `user_id` is UUID. We therefore bind `user_id` as a
 *   plain string parameter with NO explicit `::uuid` cast and let Postgres infer
 *   the column type per statement — text-to-text for the TEXT columns, and a
 *   text→uuid coercion for the UUID columns. A blanket `$u::uuid` would break the
 *   TEXT-keyed tables. This mirrors the sibling backfill (backfillGithubRepoId).
 */

import type { Pool } from 'pg';

/**
 * Denormalised repo-scoped tables labelled with `repo_full_name` (verified
 * against migration 084). `prompt_invocations` is handled separately because it
 * labels the repo with `repo_name` instead. Kept identical to the admin-api twin
 * and the backfill's LABEL_TABLES.
 */
const LABEL_TABLES = [
    'document_embeddings',
    'repo_file_state',
    'repo_sync_state',
    'repository_profiles',
    'repo_profile',
    'repo_commits',
    'repo_pull_requests',
    'repo_evidence_quality',
    'evidence_provenance',
    'ai_evidence',
    'ai_scanned_commits',
    'dsa_evidence',
    'dsa_scanned_commits',
    'technology_evidence',
    'technology_parity_runs',
    'story_candidates',
    'ingestion_audit_log',
    'retrieval_probe_history',
] as const;

/**
 * Refresh the denormalised display label for a renamed/transferred repo,
 * matched on `(user_id, github_repo_id)`. No-op when the repo is unknown or the
 * stored label already matches `newFullName`.
 */
export async function reconcileRepoName(
    pool: Pool,
    userId: string,
    githubRepoId: number,
    newFullName: string,
): Promise<void> {
    // Read the anchor's current label. Unknown repo or already-current label →
    // no-op (no connection, no transaction). user_id bound un-cast (see header).
    const { rows } = await pool.query<{ full_name: string }>(
        `SELECT full_name FROM repositories
         WHERE user_id = $1 AND github_repo_id = $2`,
        [userId, githubRepoId],
    );
    const current = rows[0]?.full_name;
    if (current === undefined || current === newFullName) {
        return;
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Anchor first: refresh the canonical label on `repositories`.
        await client.query(
            `UPDATE repositories SET full_name = $1
             WHERE user_id = $2 AND github_repo_id = $3`,
            [newFullName, userId, githubRepoId],
        );

        // Every denormalised table keyed on repo_full_name.
        for (const table of LABEL_TABLES) {
            await client.query(
                `UPDATE ${table} SET repo_full_name = $1
                 WHERE user_id = $2 AND github_repo_id = $3`,
                [newFullName, userId, githubRepoId],
            );
        }

        // prompt_invocations labels the repo with repo_name, not repo_full_name.
        await client.query(
            `UPDATE prompt_invocations SET repo_name = $1
             WHERE user_id = $2 AND github_repo_id = $3`,
            [newFullName, userId, githubRepoId],
        );

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}
