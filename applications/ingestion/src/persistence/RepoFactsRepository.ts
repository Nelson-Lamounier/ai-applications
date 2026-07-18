/**
 * @format
 * Persistence for `repo_facts` (migration 121) — one row per (user_id,
 * repo_full_name) holding the materialised `RepoFactsPayload` JSONB fact
 * sheet plus the derived component `role` and repo `classification`.
 *
 * RLS parity with the other `project_*` / DSA-lane repositories (mirrors
 * `RdsSystemTourRepository` / `system-tour-persistence.ts`): every write
 * runs through the shared `withUserRls(pool, userId, fn)` helper, which
 * demotes the transaction to `tucaken_app` via `SET LOCAL ROLE` and stamps
 * `SELECT set_config('app.current_user_id', $1, true)` so the
 * `rls_repo_facts` policy
 * (`USING user_id = current_setting('app.current_user_id', true)::uuid`)
 * actually authorises the write. COMMIT on success, ROLLBACK on error,
 * release the client in `finally` — all handled by the shared helper.
 */
import type { Pool } from 'pg';
import { withUserRls, type ProjectComponentKind } from '@bedrock/shared';

import type { RepoFactsPayload } from '../facts/build-repo-facts.js';

export interface RepoFactsRow {
    readonly githubRepoId:   number | null;
    readonly role:           ProjectComponentKind;
    readonly classification: string | null;
    readonly facts:          RepoFactsPayload;
    readonly factVersion:    number;
}

export class RepoFactsRepository {
    constructor(private readonly pool: Pool) {}

    /**
     * Insert-or-update the single fact sheet for a repo. Idempotent via the
     * `(user_id, repo_full_name)` primary key: a re-run replaces role,
     * classification, facts and fact_version, and bumps `computed_at`.
     * `github_repo_id` only overwrites when the new value is non-null, so a
     * later call that can't resolve the GitHub id never clobbers a
     * previously-known one.
     */
    async upsert(userId: string, repoFullName: string, row: RepoFactsRow): Promise<void> {
        await withUserRls(this.pool, userId, async (client) => {
            await client.query(
                `INSERT INTO repo_facts (
                    user_id, repo_full_name, github_repo_id, role, classification, facts, fact_version
                 ) VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7)
                 ON CONFLICT (user_id, repo_full_name) DO UPDATE
                   SET github_repo_id = COALESCE(EXCLUDED.github_repo_id, repo_facts.github_repo_id),
                       role           = EXCLUDED.role,
                       classification = EXCLUDED.classification,
                       facts          = EXCLUDED.facts,
                       fact_version   = EXCLUDED.fact_version,
                       computed_at    = now()`,
                [
                    userId,
                    repoFullName,
                    row.githubRepoId,
                    row.role,
                    row.classification,
                    JSON.stringify(row.facts),
                    row.factVersion,
                ],
            );
        });
    }
}
