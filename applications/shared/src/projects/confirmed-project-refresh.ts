/**
 * @format
 * confirmed-project-refresh — fix a confirmed project's components in place.
 *
 * Confirmed projects are protected from the full-replace re-cluster, so their
 * (possibly wrong, md-derived) component kinds/names never improve. This rebuilds
 * each confirmed project's components from the current grounded signals — same
 * repos, same project, but regrouped into role-correct, well-named components —
 * so a downstream case-study / resume regeneration reads accurate structure.
 *
 * The grouping (which repos belong to the project) is preserved; only the
 * component layer is rewritten, inside the caller's transaction.
 */

import type { PoolClient } from 'pg';

import type { RepoRoleSignals } from './component-kind.js';
import { regroupComponentsByKind } from './grounded-components.js';

export interface ConfirmedRefreshSummary {
    readonly projectsRefreshed: number;
    readonly componentsWritten: number;
}

/**
 * Rebuild components for every confirmed project of `userId` from `signalsById`
 * (see loadRepoRoleSignals). Runs inside the caller's transaction.
 */
export async function recomputeConfirmedProjectComponents(
    client: PoolClient,
    userId: string,
    signalsById: ReadonlyMap<string, RepoRoleSignals>,
    opts: { projectId?: string } = {},
): Promise<ConfirmedRefreshSummary> {
    // Scope to one project when given (e.g. a single-project regenerate), else
    // refresh every confirmed project for the user.
    const params: unknown[] = [userId];
    let scope = '';
    if (opts.projectId) {
        params.push(opts.projectId);
        scope = ` AND p.id = $${params.length}`;
    }
    const links = await client.query<{ project_id: string; repository_id: string }>(
        `SELECT p.id AS project_id, pr.repository_id
           FROM projects p
           JOIN project_components pc  ON pc.project_id = p.id
           JOIN project_repositories pr ON pr.project_component_id = pc.id
          WHERE p.user_id = $1 AND p.is_user_confirmed = TRUE${scope}`,
        params,
    );

    const repoIdsByProject = new Map<string, string[]>();
    for (const row of links.rows) {
        const ids = repoIdsByProject.get(row.project_id) ?? [];
        ids.push(row.repository_id);
        repoIdsByProject.set(row.project_id, ids);
    }

    let projectsRefreshed = 0;
    let componentsWritten = 0;

    for (const [projectId, repoIds] of repoIdsByProject) {
        const components = regroupComponentsByKind([...new Set(repoIds)], signalsById);

        // Replace the component layer only (links cleared first, then components).
        await client.query(
            `DELETE FROM project_repositories
              WHERE user_id = $1
                AND project_component_id IN (SELECT id FROM project_components WHERE project_id = $2)`,
            [userId, projectId],
        );
        await client.query(`DELETE FROM project_components WHERE user_id = $1 AND project_id = $2`, [userId, projectId]);

        let orderIndex = 0;
        for (const c of components) {
            const inserted = await client.query<{ id: string }>(
                `INSERT INTO project_components (user_id, project_id, name, kind, order_index)
                 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                [userId, projectId, c.name, c.kind, orderIndex++],
            );
            const componentId = inserted.rows[0]!.id;
            for (const repoId of c.repositoryIds) {
                await client.query(
                    `INSERT INTO project_repositories (user_id, project_component_id, repository_id, subpath)
                     VALUES ($1, $2, $3, '') ON CONFLICT DO NOTHING`,
                    [userId, componentId, repoId],
                );
            }
            componentsWritten++;
        }
        projectsRefreshed++;
    }

    return { projectsRefreshed, componentsWritten };
}
