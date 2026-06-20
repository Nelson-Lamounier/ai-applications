/**
 * @format
 * Deterministic profile facts (workstream 1 of the profile-LLM hardening).
 *
 * profile-extract (run-ingestion Phase 0) runs BEFORE the orchestrator writes
 * `repo_commits`, so it cannot count commits — it falls back to a separate
 * 30-commit GitHub fetch and emits `commit_count = min(real, 30)` (a saturated
 * sentinel) plus an LLM-guessed `role_inferred`. Both are facts the code already
 * has once ingestion has run: `repo_commits` holds the real history (with
 * author logins). This patch runs AFTER the orchestrator (repo_commits fresh)
 * and overwrites those two fields with computed values — deterministic-in,
 * inferential-out (CLAUDE.md). The LLM keeps domain/complexity/narrative.
 *
 * Repository identity is keyed on the immutable `repositories.id` UUID (shared by
 * repo_commits + repository_profiles, FK to repositories), NOT the rename-volatile
 * repo_full_name — so commit history is read correctly even across a repo rename.
 */
import type { Pool } from 'pg';

export type AuthorshipRole = 'creator' | 'maintainer' | 'contributor';

/**
 * Classify the owner's role from authorship concentration. `ownerCount` is the
 * number of commits authored by the repo owner (parsed from repo_full_name).
 * Returns null when there is no commit history to judge (caller skips the patch).
 *
 * Thresholds: owner wrote the clear majority -> creator; a meaningful share ->
 * maintainer; a small share of someone else's repo -> contributor.
 */
export function classifyAuthorshipRole(total: number, ownerCount: number): AuthorshipRole | null {
    if (total <= 0) return null;
    const share = ownerCount / total;
    if (share >= 0.6) return 'creator';
    if (share >= 0.2) return 'maintainer';
    return 'contributor';
}

export interface PatchProfileFactsArgs {
    readonly userId: string;
    readonly repoFullName: string;
    /** repositories.id UUID — rename-safe key for the commit history. Null falls back to repo_full_name. */
    readonly repositoryId: string | null;
}

export interface PatchedProfileFacts {
    readonly commitCount: number;
    readonly role: AuthorshipRole | null;
    readonly ownerShare: number;
    readonly patched: boolean;
}

/**
 * Overwrite repository_profiles.extracted.{signals.commit_count, role_inferred}
 * with values computed from repo_commits. No-op (patched:false) when there is no
 * commit history yet (first sync before activity persisted) — the LLM's values
 * stand until the next run. One SELECT + one UPDATE; cheap and idempotent. Also
 * back-fills the profile's repository_id when it was null.
 */
export async function patchDeterministicProfileFacts(
    pool: Pool,
    args: PatchProfileFactsArgs,
): Promise<PatchedProfileFacts> {
    const { userId, repoFullName, repositoryId } = args;
    const owner = (repoFullName.split('/')[0] ?? '').toLowerCase();

    // Count + owner-authored count. Prefer the immutable repository_id (rename-safe);
    // fall back to (user_id, repo_full_name) when no repositories row was resolved.
    const counts = repositoryId
        ? await pool.query<{ total: number; owner_c: number }>(
            `SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE lower(author_login) = $2)::int AS owner_c
               FROM repo_commits WHERE repository_id = $1::uuid`,
            [repositoryId, owner],
        )
        : await pool.query<{ total: number; owner_c: number }>(
            `SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE lower(author_login) = $3)::int AS owner_c
               FROM repo_commits WHERE user_id = $1 AND repo_full_name = $2`,
            [userId, repoFullName, owner],
        );

    const total  = counts.rows[0]?.total ?? 0;
    const ownerC = counts.rows[0]?.owner_c ?? 0;
    const role   = classifyAuthorshipRole(total, ownerC);

    if (total === 0 || role === null) {
        return { commitCount: 0, role: null, ownerShare: 0, patched: false };
    }

    await pool.query(
        `UPDATE repository_profiles
            SET extracted = jsonb_set(
                  jsonb_set(extracted, '{signals,commit_count}', to_jsonb($3::int), true),
                  '{role_inferred}', to_jsonb($4::text), true),
                repository_id = COALESCE(repository_id, $5::uuid),
                updated_at = now()
          WHERE user_id = $1 AND repo_full_name = $2 AND extracted IS NOT NULL`,
        [userId, repoFullName, total, role, repositoryId],
    );

    return { commitCount: total, role, ownerShare: Number((ownerC / total).toFixed(3)), patched: true };
}
