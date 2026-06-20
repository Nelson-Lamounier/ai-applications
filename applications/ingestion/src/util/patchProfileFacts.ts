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
export type Collaboration  = 'solo' | 'small-team' | 'team';

/**
 * Classify the owner's role from a single owner-dominance share in [0,1].
 * Clear majority -> creator; meaningful share -> maintainer; small share of
 * someone else's repo -> contributor.
 */
export function classifyRoleByShare(share: number): AuthorshipRole {
    if (share >= 0.6) return 'creator';
    if (share >= 0.2) return 'maintainer';
    return 'contributor';
}

/**
 * Classify the owner's role from commit-authorship concentration. `ownerCount`
 * is the number of commits authored by the repo owner. Returns null when there
 * is no commit history to judge (caller skips the patch).
 */
export function classifyAuthorshipRole(total: number, ownerCount: number): AuthorshipRole | null {
    if (total <= 0) return null;
    return classifyRoleByShare(ownerCount / total);
}

/** Team-size signal from the contributor count. Null when no roster was collected. */
export function classifyCollaboration(contributorCount: number): Collaboration | null {
    if (contributorCount <= 0) return null;
    if (contributorCount === 1) return 'solo';
    if (contributorCount <= 4) return 'small-team';
    return 'team';
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
    readonly contributorCount: number;
    readonly collaboration: Collaboration | null;
    readonly patched: boolean;
}

/**
 * Overwrite repository_profiles.extracted.{signals.commit_count, role_inferred}
 * with values computed from repo_commits. No-op (patched:false) when there is no
 * commit history yet (first sync before activity persisted) — the LLM's values
 * stand until the next run. One SELECT + one UPDATE; cheap and idempotent. Also
 * back-fills the profile's repository_id when it was null.
 */
/** Owner-authored vs total commit counts, keyed on repository_id when available. */
async function countCommitAuthorship(
    pool: Pool, args: PatchProfileFactsArgs, owner: string,
): Promise<{ total: number; ownerC: number }> {
    const { userId, repoFullName, repositoryId } = args;
    const where = repositoryId ? `repository_id = $1::uuid` : `user_id = $1 AND repo_full_name = $2`;
    const params = repositoryId ? [repositoryId, owner] : [userId, repoFullName, owner];
    const loginParam = repositoryId ? '$2' : '$3';
    const { rows } = await pool.query<{ total: number; owner_c: number }>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE lower(author_login) = ${loginParam})::int AS owner_c
           FROM repo_commits WHERE ${where}`,
        params,
    );
    return { total: rows[0]?.total ?? 0, ownerC: rows[0]?.owner_c ?? 0 };
}

/** Contributor count + owner-vs-total contribution sums (GitHub's own attribution). */
async function countContributors(
    pool: Pool, args: PatchProfileFactsArgs, owner: string,
): Promise<{ cnt: number; totalContrib: number; ownerContrib: number }> {
    const { userId, repoFullName, repositoryId } = args;
    const where = repositoryId ? `repository_id = $1::uuid` : `user_id = $1 AND repo_full_name = $2`;
    const params = repositoryId ? [repositoryId, owner] : [userId, repoFullName, owner];
    const loginParam = repositoryId ? '$2' : '$3';
    const { rows } = await pool.query<{ cnt: number; total_c: number; owner_c: number }>(
        `SELECT count(*)::int AS cnt,
                COALESCE(sum(contributions), 0)::int AS total_c,
                COALESCE(sum(contributions) FILTER (WHERE lower(login) = ${loginParam}), 0)::int AS owner_c
           FROM repo_contributors WHERE ${where}`,
        params,
    );
    return { cnt: rows[0]?.cnt ?? 0, totalContrib: rows[0]?.total_c ?? 0, ownerContrib: rows[0]?.owner_c ?? 0 };
}

export async function patchDeterministicProfileFacts(
    pool: Pool,
    args: PatchProfileFactsArgs,
): Promise<PatchedProfileFacts> {
    const { userId, repoFullName, repositoryId } = args;
    const owner = (repoFullName.split('/')[0] ?? '').toLowerCase();

    const { total, ownerC } = await countCommitAuthorship(pool, args, owner);
    // Contributor roster (WS2): GitHub's own per-author commit attribution — often
    // a cleaner owner-dominance signal than author_login matching, plus a team size.
    const { cnt: contributorCount, totalContrib, ownerContrib } = await countContributors(pool, args, owner);
    const collaboration = classifyCollaboration(contributorCount);

    if (total === 0) {
        return { commitCount: 0, role: null, ownerShare: 0, contributorCount, collaboration, patched: false };
    }

    // Role from the STRONGER owner-dominance signal: commit-author share OR
    // contributor share. Contributor data (when present) is GitHub's own
    // attribution and resists author_login mismatches.
    const commitShare    = ownerC / total;
    const contribShare   = totalContrib > 0 ? ownerContrib / totalContrib : 0;
    const effectiveShare = Math.max(commitShare, contribShare);
    const role           = classifyRoleByShare(effectiveShare);

    await pool.query(
        `UPDATE repository_profiles
            SET extracted = jsonb_set(
                  jsonb_set(
                    jsonb_set(
                      jsonb_set(extracted, '{signals,commit_count}', to_jsonb($3::int), true),
                      '{role_inferred}', to_jsonb($4::text), true),
                    '{signals,contributor_count}', to_jsonb($6::int), true),
                  '{collaboration}', $7::jsonb, true),
                repository_id = COALESCE(repository_id, $5::uuid),
                updated_at = now()
          WHERE user_id = $1 AND repo_full_name = $2 AND extracted IS NOT NULL`,
        [userId, repoFullName, total, role, repositoryId, contributorCount, JSON.stringify(collaboration)],
    );

    return { commitCount: total, role, ownerShare: Number(effectiveShare.toFixed(3)), contributorCount, collaboration, patched: true };
}
