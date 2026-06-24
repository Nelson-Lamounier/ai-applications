/** @format */
import type { Pool } from 'pg';

/**
 * After a successful sync, apply the Add-time intent stamped on the repo's
 * single_repo default project. build -> confirm + queue a case study; link ->
 * move the repo into the target project + queue the target's case study; clears
 * post_sync_action either way. Sets RLS context. NEVER throws into the caller --
 * a failure leaves the intent pending so the user can finish it from the UI.
 * Does NOT dispatch the case-study Job (the admin-api reconciler does).
 */
export async function applyPostSyncProjectAction(
  pool: Pool,
  userId: string,
  repoFullName: string,
): Promise<'build' | 'link' | 'none'> {
  try {
    await pool.query('BEGIN');
    await pool.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
    const { rows } = await pool.query<{ id: string; post_sync_action: string | null; post_sync_target_project_id: string | null }>(
      `SELECT p.id, p.post_sync_action, p.post_sync_target_project_id
         FROM projects p
         JOIN project_components pc ON pc.project_id = p.id
         JOIN project_repositories pr ON pr.project_component_id = pc.id
         JOIN repositories r ON r.id = pr.repository_id
        WHERE p.user_id = $1::uuid AND r.full_name = $2 AND p.shape = 'single_repo'
        ORDER BY p.created_at DESC LIMIT 1`,
      [userId, repoFullName],
    );
    const proj = rows[0];
    if (!proj || !proj.post_sync_action) { await pool.query('COMMIT'); return 'none'; }

    if (proj.post_sync_action === 'build') {
      await pool.query(
        `UPDATE projects
            SET is_user_confirmed = TRUE, case_study_status = 'pending',
                post_sync_action = NULL, post_sync_target_project_id = NULL, updated_at = NOW()
          WHERE id = $1::uuid`,
        [proj.id],
      );
      await pool.query('COMMIT');
      return 'build';
    }

    // link: move this default's repo links into the target's primary component,
    // archive the now-empty default, queue the target's case study.
    const target = proj.post_sync_target_project_id;
    if (target) {
      const comp = await pool.query<{ id: string }>(
        `SELECT id FROM project_components WHERE project_id = $1::uuid ORDER BY order_index LIMIT 1`,
        [target],
      );
      const targetComponentId = comp.rows[0]?.id;
      if (targetComponentId) {
        await pool.query(
          `UPDATE project_repositories pr
              SET project_component_id = $2::uuid
             FROM project_components pc
            WHERE pr.project_component_id = pc.id AND pc.project_id = $1::uuid`,
          [proj.id, targetComponentId],
        );
        await pool.query(
          `UPDATE projects SET status = 'archived', post_sync_action = NULL, updated_at = NOW() WHERE id = $1::uuid`,
          [proj.id],
        );
        await pool.query(
          `UPDATE projects SET case_study_status = 'pending', updated_at = NOW() WHERE id = $1::uuid AND user_id = $2::uuid`,
          [target, userId],
        );
        await pool.query('COMMIT');
        return 'link';
      }
    }
    // target missing/invalid -> just clear so we do not loop.
    await pool.query(`UPDATE projects SET post_sync_action = NULL WHERE id = $1::uuid`, [proj.id]);
    await pool.query('COMMIT');
    return 'none';
  } catch {
    await pool.query('ROLLBACK').catch(() => {});
    return 'none';
  }
}
