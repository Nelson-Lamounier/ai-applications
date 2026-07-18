/** @format */
import type { Pool } from 'pg';
import { withUserRls } from '@bedrock/shared';

/**
 * After a successful sync, apply the Add-time intent stamped on the repo's
 * single_repo default project. build -> confirm + queue a case study; link ->
 * move the repo into the target project + queue the target's case study; clears
 * post_sync_action either way. Runs through the shared `withUserRls` helper, so
 * RLS is actually enforced (SET LOCAL ROLE tucaken_app + set_config, same
 * pooled client for the whole transaction). NEVER throws into the caller --
 * a failure leaves the intent pending so the user can finish it from the UI.
 * Does NOT dispatch the case-study Job (the admin-api reconciler does).
 */
export async function applyPostSyncProjectAction(
  pool: Pool,
  userId: string,
  repoFullName: string,
): Promise<'build' | 'link' | 'none'> {
  try {
    return await withUserRls(pool, userId, async (client) => {
      const { rows } = await client.query<{ id: string; post_sync_action: string | null; post_sync_target_project_id: string | null }>(
        `SELECT p.id, p.post_sync_action, p.post_sync_target_project_id
           FROM projects p
           JOIN project_components pc ON pc.project_id = p.id
           JOIN project_repositories pr ON pr.project_component_id = pc.id
           JOIN repositories r ON r.id = pr.repository_id
          WHERE p.user_id = $1::uuid AND r.full_name = $2 AND p.shape = 'single_repo'
            AND p.status <> 'archived'
          ORDER BY p.created_at DESC LIMIT 1`,
        [userId, repoFullName],
      );
      const proj = rows[0];
      if (!proj?.post_sync_action) return 'none';

      if (proj.post_sync_action === 'build') {
        await client.query(
          `UPDATE projects
              SET is_user_confirmed = TRUE, case_study_status = 'pending',
                  post_sync_action = NULL, post_sync_target_project_id = NULL, updated_at = NOW()
            WHERE id = $1::uuid`,
          [proj.id],
        );
        return 'build';
      }

      // link: move this default's repo links into the target's primary component,
      // archive the now-empty default, queue the target's case study.
      const target = proj.post_sync_target_project_id;
      if (target) {
        const comp = await client.query<{ id: string }>(
          `SELECT id FROM project_components WHERE project_id = $1::uuid ORDER BY order_index LIMIT 1`,
          [target],
        );
        const targetComponentId = comp.rows[0]?.id;
        if (targetComponentId) {
          await client.query(
            `UPDATE project_repositories pr
                SET project_component_id = $2::uuid
               FROM project_components pc
              WHERE pr.project_component_id = pc.id AND pc.project_id = $1::uuid`,
            [proj.id, targetComponentId],
          );
          await client.query(
            `UPDATE projects SET status = 'archived', post_sync_action = NULL, post_sync_target_project_id = NULL, updated_at = NOW() WHERE id = $1::uuid`,
            [proj.id],
          );
          await client.query(
            `UPDATE projects SET case_study_status = 'pending', updated_at = NOW() WHERE id = $1::uuid AND user_id = $2::uuid`,
            [target, userId],
          );
          return 'link';
        }
      }
      // target missing/invalid -> just clear so we do not loop.
      await client.query(`UPDATE projects SET post_sync_action = NULL WHERE id = $1::uuid`, [proj.id]);
      return 'none';
    });
  } catch {
    return 'none';
  }
}
