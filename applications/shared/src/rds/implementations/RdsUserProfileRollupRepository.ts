/**
 * @format
 * RdsUserProfileRollupRepository — reads all of a user's repository_profiles
 * rows (RLS-scoped) and upserts the precomputed user_profile_rollup row.
 * Scope/aggregation lives in computeUserProfileRollup (pure); this class is
 * only data access. Mirrors RepositoryProfileRepository's connect + BEGIN +
 * set_config RLS idiom.
 */
import type { Pool } from 'pg';
import type { IUserProfileRollupRepository } from '../interfaces/IUserProfileRollupRepository.js';
import type {
    ProfileAggInput,
    UserProfileRollupResult,
} from '../profile/computeUserProfileRollup.js';

export class RdsUserProfileRollupRepository implements IUserProfileRollupRepository {
    constructor(private readonly pool: Pool) {}

    async listProfilesForRollup(userId: string): Promise<ProfileAggInput[]> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
            const { rows } = await client.query<ProfileAggInput>(
                `SELECT
                     repo_full_name                                            AS "repoFullName",
                     classification                                            AS "classification",
                     is_hidden                                                 AS "isHidden",
                     extraction_status                                         AS "extractionStatus",
                     NULLIF(extracted->'signals'->>'primary_language', '')     AS "primaryLanguage",
                     COALESCE((extracted->'signals'->>'commit_count')::int, 0) AS "commitCount",
                     extracted->'signals'->>'last_active_at'                   AS "lastActiveAt",
                     COALESCE(extracted->>'domain', '')                        AS "domain",
                     COALESCE(extracted->>'complexity', '')                    AS "complexity",
                     COALESCE(extracted->>'role_inferred', '')                 AS "roleInferred",
                     COALESCE(extracted->'tech_stack', '[]'::jsonb)            AS "techStack"
                   FROM repository_profiles
                  WHERE user_id = $1::uuid`,
                [userId],
            );
            await client.query('COMMIT');
            return rows.map(r => ({
                ...r,
                isHidden:    Boolean(r.isHidden),
                commitCount: Number(r.commitCount ?? 0),
                techStack:   Array.isArray(r.techStack) ? r.techStack : [],
            }));
        } catch (err) {
            // Best-effort: do not shadow the original error if ROLLBACK fails.
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    async upsert(userId: string, result: UserProfileRollupResult): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
            await client.query(
                `INSERT INTO user_profile_rollup (
                     user_id, project_repo_count, total_repo_count,
                     methodology_version, rollup, refreshed_at
                 ) VALUES ($1::uuid, $2, $3, $4, $5::jsonb, now())
                 ON CONFLICT (user_id) DO UPDATE SET
                     project_repo_count  = EXCLUDED.project_repo_count,
                     total_repo_count    = EXCLUDED.total_repo_count,
                     methodology_version = EXCLUDED.methodology_version,
                     rollup              = EXCLUDED.rollup,
                     refreshed_at        = EXCLUDED.refreshed_at`,
                [
                    userId,
                    result.projectRepoCount,
                    result.totalRepoCount,
                    result.methodologyVersion,
                    JSON.stringify(result.rollup),
                ],
            );
            await client.query('COMMIT');
        } catch (err) {
            // Best-effort: do not shadow the original error if ROLLBACK fails.
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }
}
