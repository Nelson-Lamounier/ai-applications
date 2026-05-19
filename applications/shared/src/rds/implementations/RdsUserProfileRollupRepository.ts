/**
 * @format
 * RdsUserProfileRollupRepository — reads all of a user's repository_profiles
 * rows (RLS-scoped) and upserts the precomputed user_profile_rollup row.
 * Scope/aggregation lives in computeUserProfileRollup (pure); this class is
 * only data access. Mirrors RepositoryProfileRepository's connect + BEGIN +
 * set_config RLS idiom.
 */
import type { Pool } from 'pg';
import type { IUserProfileRollupRepository, MirrorJson, RevealJson, DirectionJson, ReconciliationJson, RollupRow } from '../interfaces/IUserProfileRollupRepository.js';
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

    async upsert(
        userId: string,
        result: UserProfileRollupResult,
        mirror?: MirrorJson,
        reveal?: RevealJson,
        direction?: DirectionJson,
        reconciliation?: ReconciliationJson,
    ): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
            // Stamp synthesis_refreshed_at when any synthesis output (mirror, reveal, or
            // direction) is supplied. A rollup-only refresh passes null for all three;
            // COALESCE in ON CONFLICT then preserves the prior values instead of clobbering.
            const mirrorVal    = mirror == null ? null : JSON.stringify(mirror);
            const revealVal    = reveal == null ? null : JSON.stringify(reveal);
            const directionVal = direction == null ? null : JSON.stringify(direction);
            const reconciliationVal = reconciliation == null ? null : JSON.stringify(reconciliation);
            const synthTs   = (mirror == null && reveal == null && direction == null && reconciliation == null) ? null : new Date();
            await client.query(
                `INSERT INTO user_profile_rollup (
                     user_id, project_repo_count, total_repo_count,
                     methodology_version, rollup, refreshed_at,
                     mirror, reveal, synthesis_refreshed_at, direction, reconciliation
                 ) VALUES ($1::uuid, $2, $3, $4, $5::jsonb, now(), $6::jsonb, $7::jsonb, $8, $9::jsonb, $10::jsonb)
                 ON CONFLICT (user_id) DO UPDATE SET
                     project_repo_count     = EXCLUDED.project_repo_count,
                     total_repo_count       = EXCLUDED.total_repo_count,
                     methodology_version    = EXCLUDED.methodology_version,
                     rollup                 = EXCLUDED.rollup,
                     refreshed_at           = EXCLUDED.refreshed_at,
                     mirror                 = COALESCE(EXCLUDED.mirror, user_profile_rollup.mirror),
                     reveal                 = COALESCE(EXCLUDED.reveal, user_profile_rollup.reveal),
                     synthesis_refreshed_at = COALESCE(EXCLUDED.synthesis_refreshed_at, user_profile_rollup.synthesis_refreshed_at),
                     direction              = COALESCE(EXCLUDED.direction, user_profile_rollup.direction),
                     reconciliation         = COALESCE(EXCLUDED.reconciliation, user_profile_rollup.reconciliation)`,
                [
                    userId,
                    result.projectRepoCount,
                    result.totalRepoCount,
                    result.methodologyVersion,
                    JSON.stringify(result.rollup),
                    mirrorVal,
                    revealVal,
                    synthTs,
                    directionVal,
                    reconciliationVal,
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

    async getRollup(userId: string): Promise<RollupRow | null> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
            const { rows } = await client.query(
                `SELECT rollup, mirror, reveal, direction, reconciliation, refreshed_at, synthesis_refreshed_at
                   FROM user_profile_rollup
                  WHERE user_id = $1::uuid`,
                [userId],
            );
            await client.query('COMMIT');
            if (rows.length === 0) return null;
            const row = rows[0];
            return {
                rollup:               row.rollup,
                mirror:               (row.mirror as MirrorJson | null) ?? null,
                reveal:               (row.reveal as RevealJson | null) ?? null,
                direction:            (row.direction as DirectionJson | null) ?? null,
                reconciliation:       (row.reconciliation as ReconciliationJson | null) ?? null,
                refreshedAt:          (row.refreshed_at as Date | null)?.toISOString() ?? '',
                synthesisRefreshedAt: (row.synthesis_refreshed_at as Date | null)?.toISOString() ?? null,
            };
        } catch (err) {
            // Best-effort: do not shadow the original error if ROLLBACK fails.
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }
}
