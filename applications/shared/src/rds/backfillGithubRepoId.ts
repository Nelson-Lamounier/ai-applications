/**
 * @format
 * One-shot, re-runnable backfill: populates the immutable `github_repo_id`
 * anchor (migration 084) for every repository whose column is still NULL, then
 * propagates that id into every denormalised repo-scoped table.
 *
 * How it heals a rename:
 *   For each `repositories` row missing an id we resolve `full_name` via
 *   `adapter.resolveByName`. The adapter's HTTP layer follows GitHub's 301, so a
 *   stale name (e.g. `o/cdk-monitoring`) resolves to its *current* identity
 *   (`o/tucaken-infra`) + immutable id. We write the id, refresh the possibly
 *   stale label on the anchor, and propagate `(id, currentName)` to every
 *   denormalised table keyed on `(user_id, oldName)`.
 *
 * Idempotency:
 *   Every denormalised UPDATE is guarded by `github_repo_id IS NULL`, so a
 *   second run is a no-op for rows already backfilled. The anchor SELECT only
 *   returns rows where `github_repo_id IS NULL`, so resolved repos are skipped.
 *
 * Failure semantics:
 *   A `RepoNotFoundError` (deleted/inaccessible repo) is recorded in
 *   `unresolved` and the run continues. Any other error is rethrown — we fail
 *   loudly rather than silently skip on transient/auth failures.
 *
 * user_id typing:
 *   `repo_sync_state.user_id` is TEXT while every other table's `user_id` is
 *   UUID. We therefore bind `user_id` as a plain string parameter with NO
 *   explicit `::uuid` cast — Postgres coerces the text parameter to uuid for the
 *   uuid columns and compares text-to-text for `repo_sync_state`. A blanket
 *   `$u::uuid` would break `repo_sync_state`.
 *
 * The library returns data; logging happens in the CLI wrapper
 * (`scripts/backfill-github-repo-id.ts`).
 */

import type { Pool } from 'pg';

import { RepoNotFoundError } from '../ingestion/implementations/github-errors.js';

/** Minimal adapter surface this backfill needs (a real GitHubAdapter satisfies it). */
export interface ResolveByNameAdapter {
    resolveByName(fullName: string): Promise<{ id: number; fullName: string; defaultBranch: string }>;
}

export interface BackfillGithubRepoIdResult {
    resolved:   number;
    unresolved: Array<{ userId: string; fullName: string }>;
}

interface RepositoryRow {
    user_id:   string;
    full_name: string;
}

/**
 * Denormalised repo-scoped tables labelled with `repo_full_name` (verified
 * against migration 084). `prompt_invocations` is handled separately because it
 * labels the repo with `repo_name` instead.
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

export async function backfillGithubRepoId(opts: {
    pool:    Pool;
    adapter: ResolveByNameAdapter;
}): Promise<BackfillGithubRepoIdResult> {
    const { pool, adapter } = opts;

    const sel = await pool.query<RepositoryRow>(
        `SELECT user_id, full_name
         FROM repositories
         WHERE provider = 'github' AND github_repo_id IS NULL`,
    );

    let resolved = 0;
    const unresolved: Array<{ userId: string; fullName: string }> = [];

    for (const row of sel.rows) {
        const userId  = row.user_id;
        const oldName = row.full_name;

        const resolution = await resolveOrFlag(adapter, userId, oldName, unresolved);
        if (!resolution) continue;

        const { id, fullName: newName } = resolution;
        await propagate(pool, id, newName, userId, oldName);
        resolved++;
    }

    return { resolved, unresolved };
}

/**
 * Resolve a name to its current identity, or push it to `unresolved` and return
 * null on a 404. Non-404 errors are rethrown (fail loudly).
 */
async function resolveOrFlag(
    adapter: ResolveByNameAdapter,
    userId: string,
    fullName: string,
    unresolved: Array<{ userId: string; fullName: string }>,
): Promise<{ id: number; fullName: string } | null> {
    try {
        const { id, fullName: current } = await adapter.resolveByName(fullName);
        return { id, fullName: current };
    } catch (err) {
        if (err instanceof RepoNotFoundError) {
            unresolved.push({ userId, fullName });
            return null;
        }
        throw err;
    }
}

/**
 * Write the resolved id (and refreshed name) to the anchor, then to every
 * denormalised table keyed on the OLD name. user_id is bound un-cast so the same
 * query works for both UUID and TEXT `user_id` columns (see file header).
 */
async function propagate(
    pool: Pool,
    id: number,
    newName: string,
    userId: string,
    oldName: string,
): Promise<void> {
    // Anchor: set id AND refresh the (possibly stale) label, matched on old name.
    await pool.query(
        `UPDATE repositories
         SET github_repo_id = $1, full_name = $2
         WHERE user_id = $3 AND provider = 'github' AND full_name = $4`,
        [id, newName, userId, oldName],
    );

    // Denormalised tables keyed on repo_full_name. The `github_repo_id IS NULL`
    // guard makes re-runs no-ops (idempotent).
    for (const table of LABEL_TABLES) {
        await pool.query(
            `UPDATE ${table} SET github_repo_id = $1, repo_full_name = $2
             WHERE user_id = $3 AND repo_full_name = $4 AND github_repo_id IS NULL`,
            [id, newName, userId, oldName],
        );
    }

    // prompt_invocations labels the repo with repo_name, not repo_full_name.
    await pool.query(
        `UPDATE prompt_invocations SET github_repo_id = $1, repo_name = $2
         WHERE user_id = $3 AND repo_name = $4 AND github_repo_id IS NULL`,
        [id, newName, userId, oldName],
    );
}
