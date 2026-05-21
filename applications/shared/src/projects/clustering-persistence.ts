/**
 * @format
 * Persist clustering proposals into the projects domain.
 *
 * For each multi-repo proposal:
 *
 *   1. Insert a row into `projects` with
 *      `is_ai_suggested=true, is_user_confirmed=false`, plus the proposal's
 *      reasoning + confidence and the pipeline_run_id that produced it.
 *   2. Insert one row into `project_components` per component, mapping the
 *      component's `kind` and a stable order_index.
 *   3. Link the component's repos via `project_repositories`.
 *
 * Rules enforced here:
 *
 *   - Never overwrite confirmed projects. Any repository already linked to
 *     a `projects` row with `is_user_confirmed=true` is skipped — that
 *     repo's confirmed grouping wins until the user dismisses it.
 *   - Repos that already participate in an *unconfirmed* AI proposal from a
 *     prior run are unlinked from that older proposal before the new
 *     proposal links them. The old empty proposal is then deleted so the
 *     review UI only sees current suggestions.
 *   - Per-user slugs come from the proposal name; on collision we append
 *     a short hex suffix from the new project id so the unique constraint
 *     never trips.
 *
 * All writes happen inside a single transaction. RLS is bypassed by the
 * connecting role (superuser / migration role); the worker is trusted
 * because it's invoked as a K8s Job, not from a user request.
 */
import type { PoolClient } from 'pg';

import type {
    ClusteringComponent,
    ClusteringProposal,
    ClusteringResult,
} from './types.js';

export interface PersistClusteringInput {
    readonly userId:            string;
    readonly pipelineRunId:     string;
    readonly result:            ClusteringResult;
}

export interface PersistClusteringSummary {
    readonly proposalsInserted:    number;
    readonly componentsInserted:   number;
    readonly linksInserted:        number;
    readonly proposalsSkipped:     number;
    readonly priorProposalsCleared: number;
}

function slugify(input: string): string {
    return input
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'project';
}

async function fetchConfirmedRepoIds(
    client: PoolClient,
    userId: string,
): Promise<Set<string>> {
    const r = await client.query<{ repository_id: string }>(
        `SELECT DISTINCT pr.repository_id
         FROM project_repositories pr
         JOIN projects p ON p.id = (
             SELECT project_id FROM project_components WHERE id = pr.project_component_id
         )
         WHERE p.user_id = $1 AND p.is_user_confirmed = TRUE`,
        [userId],
    );
    return new Set(r.rows.map((row) => row.repository_id));
}

/**
 * Remove this user's unconfirmed AI proposals (and their components +
 * links) so a fresh clustering run is the only AI-suggested state. Returns
 * the number of proposals cleared.
 */
async function clearPriorProposals(
    client: PoolClient,
    userId: string,
): Promise<number> {
    const r = await client.query(
        `DELETE FROM projects
         WHERE user_id = $1
           AND is_ai_suggested = TRUE
           AND is_user_confirmed = FALSE
           AND shape <> 'single_repo'`,
        [userId],
    );
    return r.rowCount ?? 0;
}

async function uniqueSlugForUser(
    client: PoolClient,
    userId: string,
    candidate: string,
    fallbackProjectId: string,
): Promise<string> {
    const r = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM projects WHERE user_id = $1 AND slug = $2) AS exists`,
        [userId, candidate],
    );
    if (!r.rows[0].exists) return candidate;
    const suffix = fallbackProjectId.replace(/-/g, '').slice(0, 6);
    return `${candidate}-${suffix}`.slice(0, 90);
}

async function insertProposal(
    client: PoolClient,
    userId: string,
    pipelineRunId: string,
    proposal: ClusteringProposal,
): Promise<{ projectId: string; componentRows: { id: string; component: ClusteringComponent }[] }> {
    const baseSlug = slugify(proposal.name);
    const projectId = (await client.query<{ id: string }>(
        `SELECT gen_random_uuid() AS id`,
    )).rows[0].id;
    const slug = await uniqueSlugForUser(client, userId, baseSlug, projectId);

    await client.query(
        `INSERT INTO projects (
            id, user_id, slug, name, shape, is_ai_suggested, is_user_confirmed,
            status, role_exhibited, visibility,
            proposal_pipeline_run_id, proposal_reasoning, proposal_confidence
         )
         VALUES ($1, $2, $3, $4, 'multi_repo', TRUE, FALSE,
                 'active', 'sole_builder', 'private',
                 $5, $6, $7)`,
        [
            projectId, userId, slug, proposal.name,
            pipelineRunId, proposal.reasoning, proposal.confidence,
        ],
    );

    const componentRows: { id: string; component: ClusteringComponent }[] = [];
    for (let i = 0; i < proposal.components.length; i++) {
        const c = proposal.components[i];
        const componentId = (await client.query<{ id: string }>(
            `INSERT INTO project_components (user_id, project_id, name, kind, order_index)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [userId, projectId, c.name, c.kind, i],
        )).rows[0].id;
        componentRows.push({ id: componentId, component: c });
    }
    return { projectId, componentRows };
}

async function linkRepositoriesToComponent(
    client: PoolClient,
    userId: string,
    componentId: string,
    repositoryIds: readonly string[],
): Promise<number> {
    let linked = 0;
    for (const repositoryId of repositoryIds) {
        const r = await client.query(
            `INSERT INTO project_repositories (user_id, project_component_id, repository_id, subpath)
             VALUES ($1, $2, $3, '')
             ON CONFLICT (project_component_id, repository_id, subpath) DO NOTHING`,
            [userId, componentId, repositoryId],
        );
        linked += r.rowCount ?? 0;
    }
    return linked;
}

/**
 * Apply a clustering result to the projects schema. Returns counts useful
 * for the pipeline metadata + structured logs.
 */
export async function persistClusteringResult(
    client: PoolClient,
    input: PersistClusteringInput,
): Promise<PersistClusteringSummary> {
    await client.query('BEGIN');
    try {
        const confirmedRepoIds = await fetchConfirmedRepoIds(client, input.userId);
        const priorProposalsCleared = await clearPriorProposals(client, input.userId);

        let proposalsInserted    = 0;
        let proposalsSkipped     = 0;
        let componentsInserted   = 0;
        let linksInserted        = 0;

        for (const proposal of input.result.proposals) {
            // Filter out repos that are already part of a confirmed project.
            const filteredComponents = proposal.components
                .map((c) => ({
                    ...c,
                    repositoryIds: c.repositoryIds.filter((id) => !confirmedRepoIds.has(id)),
                }))
                .filter((c) => c.repositoryIds.length > 0);

            const remainingRepoCount = filteredComponents.reduce(
                (n, c) => n + c.repositoryIds.length, 0,
            );
            if (remainingRepoCount < 2) {
                proposalsSkipped++;
                continue;
            }

            const { componentRows } = await insertProposal(
                client,
                input.userId,
                input.pipelineRunId,
                { ...proposal, components: filteredComponents },
            );
            proposalsInserted++;
            componentsInserted += componentRows.length;

            for (const { id: componentId, component } of componentRows) {
                linksInserted += await linkRepositoriesToComponent(
                    client, input.userId, componentId, component.repositoryIds,
                );
            }
        }

        await client.query('COMMIT');
        return {
            proposalsInserted,
            componentsInserted,
            linksInserted,
            proposalsSkipped,
            priorProposalsCleared,
        };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    }
}
