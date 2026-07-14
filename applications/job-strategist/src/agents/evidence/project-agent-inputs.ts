/** @format */
import type { Pool } from 'pg';
import { repoOfFile } from '../../ats/grounding/evidence-lane.js';
import { withUserRls } from '../../lib/rls.js';
import { loadProjectResumeBullets } from './project-evidence-block.js';

/**
 * Two-lane project pool for the Projects agent: curated (already-written)
 * resume bullets alongside repo-current facts freshly attributed from the
 * Skill Evidence Ledger by repository ID. Repository-ID attribution (not
 * name matching) is the correctness crux -- a match only attributes to a
 * project when its cited file resolves, via `repositories.full_name`, to a
 * repository ID that project actually owns (`project_repositories`). Any
 * citation that cannot be resolved to a known repository is reported in
 * `unresolvedRepos` rather than silently dropped or guessed at (fail closed).
 */

export interface CuratedBullet {
    readonly id: string;
    readonly text: string;
}

export interface RepoCurrentFact {
    readonly id: string;
    readonly skill: string;
    readonly sourceCitation: string;
    readonly repositoryId: string;
    readonly githubRepoId: number | null;
    readonly fullName: string;
}

export interface ProjectPoolEntry {
    readonly index: number;
    readonly name: string;
    readonly pitch: string;
    readonly repoUrls: string[];
    readonly curated: CuratedBullet[];
    readonly repoCurrent: RepoCurrentFact[];
}

export interface ProjectAgentInputs {
    readonly pool: ProjectPoolEntry[];
    readonly unresolvedRepos: string[];
}

export interface ProjectAgentBulletSet {
    readonly name: string;
    readonly bullets: readonly string[];
}

export interface ProjectAgentMeta {
    readonly projectId: string;
    readonly name: string;
    readonly pitch: string;
    readonly repositoryIds: readonly string[];
    readonly repoFullNames: readonly string[];
}

export interface RepoLookupRow {
    readonly id: string;
    readonly githubRepoId: number | null;
}

export interface VerifiedMatch {
    readonly skill: string;
    readonly sourceCitation: string;
    readonly evidenceFiles: readonly string[];
}

/**
 * Pure builder -- no I/O. Resolves each verified match's cited file(s) to a
 * repository row (via `repoLookup`, keyed on `owner/repo` full name), then
 * attributes it to every project whose `repositoryIds` set contains that
 * row's ID. Fail-closed: a match whose citation has no repo-scoped path, or
 * whose repo name is not in `repoLookup`, or whose resolved repo is owned by
 * no project, attributes nowhere. Only names that fail LOOKUP resolution are
 * reported in `unresolvedRepos` -- a resolved-but-unowned repo is not an
 * unresolved name, it is simply out of scope for every project's pool entry.
 */
export function buildProjectPool(
    bulletSets: readonly ProjectAgentBulletSet[],
    projectMeta: readonly ProjectAgentMeta[],
    repoLookup: ReadonlyMap<string, RepoLookupRow>,
    verifiedMatches: readonly VerifiedMatch[],
): ProjectAgentInputs {
    const unresolved = new Set<string>();

    const matchRepo = verifiedMatches.map((m) => {
        const names = new Set(
            [...m.evidenceFiles, m.sourceCitation]
                .map(repoOfFile)
                .filter((x): x is string => x !== null),
        );
        for (const n of names) {
            if (!repoLookup.has(n)) unresolved.add(n);
        }
        const resolved = [...names]
            .map((n) => ({ fullName: n, row: repoLookup.get(n) }))
            .filter((x): x is { fullName: string; row: RepoLookupRow } => x.row !== undefined);
        return { match: m, resolved };
    });

    const pool = projectMeta.map((meta, i) => {
        const bullets = bulletSets.find((s) => s.name === meta.name)?.bullets ?? [];
        const idSet = new Set(meta.repositoryIds);
        const repoCurrent: RepoCurrentFact[] = [];
        for (const { match, resolved } of matchRepo) {
            const hit = resolved.find((r) => idSet.has(r.row.id));
            if (hit) {
                repoCurrent.push({
                    id: `p${i}.r${repoCurrent.length}`,
                    skill: match.skill,
                    sourceCitation: match.sourceCitation,
                    repositoryId: hit.row.id,
                    githubRepoId: hit.row.githubRepoId,
                    fullName: hit.fullName,
                });
            }
        }
        return {
            index: i,
            name: meta.name,
            pitch: meta.pitch,
            repoUrls: meta.repoFullNames.map((f) => `github.com/${f}`),
            curated: bullets.map((text, j) => ({ id: `p${i}.b${j}`, text })),
            repoCurrent,
        };
    });

    return { pool, unresolvedRepos: [...unresolved].sort() };
}

interface ProjectRow {
    readonly id: string;
    readonly name: string;
    readonly pitch: string;
}

interface ProjectRepositoryRow {
    readonly project_id: string;
    readonly repository_id: string;
    readonly full_name: string;
    readonly github_repo_id: number | null;
}

/**
 * Load the two-lane pool for the Projects agent: documented projects +
 * their owned repository IDs (for fail-closed attribution) + the curated
 * resume bullets already written for each. Runs inside `withUserRls` -- the
 * same pgbouncer-transaction-pooling discipline as `project-evidence-block.ts`
 * (see its header comment): the `app.current_user_id` GUC must be set in the
 * SAME transaction as the SELECTs or per-user RLS silently returns 0 rows.
 */
export async function loadProjectAgentInputs(
    pool: Pool,
    userId: string,
    verifiedMatches: readonly VerifiedMatch[],
): Promise<ProjectAgentInputs> {
    const { projects, projectRepositories } = await withUserRls(pool, userId, async (client) => {
        const projectsResult = await client.query<ProjectRow>(
            `SELECT p.id, p.name, COALESCE(p.pitch, '') AS pitch
               FROM projects p
              WHERE p.user_id = $1 AND p.status <> 'archived'`,
            [userId],
        );
        const projectRepositoriesResult = await client.query<ProjectRepositoryRow>(
            `SELECT pc.project_id, pr.repository_id, r.full_name, r.github_repo_id
               FROM project_repositories pr
               JOIN project_components pc ON pc.id = pr.project_component_id
               JOIN repositories r ON r.id = pr.repository_id
              WHERE pr.user_id = $1`,
            [userId],
        );
        return { projects: projectsResult.rows, projectRepositories: projectRepositoriesResult.rows };
    });

    const bulletSets = await loadProjectResumeBullets(pool, userId);

    const repoLookup = new Map<string, RepoLookupRow>();
    const repositoryIdsByProject = new Map<string, string[]>();
    const repoFullNamesByProject = new Map<string, string[]>();
    for (const row of projectRepositories) {
        repoLookup.set(row.full_name, { id: row.repository_id, githubRepoId: row.github_repo_id });
        const ids = repositoryIdsByProject.get(row.project_id) ?? [];
        ids.push(row.repository_id);
        repositoryIdsByProject.set(row.project_id, ids);
        const names = repoFullNamesByProject.get(row.project_id) ?? [];
        names.push(row.full_name);
        repoFullNamesByProject.set(row.project_id, names);
    }

    const projectMeta: ProjectAgentMeta[] = projects.map((p) => ({
        projectId: p.id,
        name: p.name,
        pitch: p.pitch,
        repositoryIds: repositoryIdsByProject.get(p.id) ?? [],
        repoFullNames: repoFullNamesByProject.get(p.id) ?? [],
    }));

    return buildProjectPool(bulletSets, projectMeta, repoLookup, verifiedMatches);
}
