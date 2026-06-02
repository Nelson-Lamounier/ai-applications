/**
 * @format
 * Persistence for the per-project System Tour (S7a) — table
 * `project_system_tours` (migration 063). One tour per project
 * (`project_id` UNIQUE); the row carries the full `SystemTour` payload as
 * JSONB plus the case-study `content_hash` used for cache/idempotency.
 *
 * RLS parity with the other `project_*` / DSA-lane tables: every call opens
 * a transaction and stamps the current user with
 * `SELECT set_config('app.current_user_id', $1, true)` so the
 * `rls_project_system_tours` policy
 * (`USING user_id = current_setting('app.current_user_id', true)::uuid`)
 * authorises the write/read. COMMIT on success, ROLLBACK on error, release
 * the client in `finally`. Mirrors `RdsDsaEvidenceRepository`.
 */
import type { Pool } from 'pg';

import type { SystemTour } from './system-tour-types.js';

export class RdsSystemTourRepository {
    constructor(private readonly pool: Pool) {}

    /**
     * Insert-or-update the single tour for a project. Idempotent via the
     * `project_id` UNIQUE constraint: a re-run with the same project replaces
     * the content + hash and bumps `generated_at`.
     */
    async upsert(
        userId: string,
        projectId: string,
        tour: SystemTour,
        contentHash: string,
    ): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(
                `SELECT set_config('app.current_user_id', $1, true)`,
                [userId],
            );
            await client.query(
                `INSERT INTO project_system_tours (user_id, project_id, content, content_hash)
                 VALUES ($1::uuid, $2::uuid, $3, $4)
                 ON CONFLICT (project_id) DO UPDATE
                   SET content      = EXCLUDED.content,
                       content_hash = EXCLUDED.content_hash,
                       generated_at = now()`,
                [userId, projectId, JSON.stringify(tour), contentHash],
            );
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    /** User-scoped fetch of a project's tour, or null when none exists. */
    async getForProject(
        userId: string,
        projectId: string,
    ): Promise<SystemTour | null> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(
                `SELECT set_config('app.current_user_id', $1, true)`,
                [userId],
            );
            const { rows } = await client.query<{ content: unknown }>(
                `SELECT content FROM project_system_tours
                  WHERE user_id = $1::uuid AND project_id = $2::uuid
                  LIMIT 1`,
                [userId, projectId],
            );
            await client.query('COMMIT');
            const raw = rows[0]?.content;
            if (raw == null) return null;
            // The pg driver returns JSONB as a parsed object, but tolerate a
            // string in case a column/driver hands back raw text.
            return (typeof raw === 'string' ? JSON.parse(raw) : raw) as SystemTour;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }
}
