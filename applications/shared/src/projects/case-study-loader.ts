/**
 * @format
 * Load the per-project context the case-study agent needs.
 *
 * Inputs come from existing tables already populated by Phase 1 + 2A:
 *
 *   - `projects` — name, tagline, pitch, user_overrides
 *   - `project_components` — kind + name per component
 *   - `project_repositories` → `repositories` — repo metadata
 *   - `repository_profiles.extracted->'tech_stack'` — tech tags
 *   - `document_embeddings` — KB passages for context (no embedding math,
 *      just text retrieval scoped to the project's repos)
 *
 * Commits are NOT loaded from RDS — they live in GitHub. The K8s
 * entrypoint passes a `commitLoader` that wraps GitHubAdapter so the
 * orchestrator stays free of network IO.
 */
import type { Pool } from 'pg';

import type { CaseStudyContext } from './case-study-types.js';

/** Minimal commit shape — matches `RepoCommit` from the ingestion adapter. */
export interface CaseStudyCommit {
    readonly sha:        string;
    readonly authorName: string;
    readonly authoredAt: string;
    readonly message:    string;
}

/** Minimal pull-request shape — matches `RepoPullRequest`. */
export interface CaseStudyPullRequest {
    readonly number:    number;
    readonly title:     string;
    readonly body:      string | null;
    readonly state:     'open' | 'closed' | 'merged';
    readonly mergedAt:  string | null;
    readonly createdAt: string;
    readonly htmlUrl:   string;
}

/**
 * The K8s entrypoint provides a real GitHub-backed loader; tests inject
 * an in-memory map. Signature is intentionally narrow so we never tie
 * the orchestrator to the ingestion adapter's full interface.
 */
export interface CommitLoader {
    list(repoFullName: string, options: { maxCommits: number }): Promise<readonly CaseStudyCommit[]>;
}

/**
 * Optional. When supplied, the loader pulls PR metadata alongside commits
 * so the agent can cite PR numbers + titles in source_signals. Absence
 * simply leaves `context.pulls` empty.
 */
export interface PullRequestLoader {
    list(repoFullName: string, options: { maxPullRequests: number }): Promise<readonly CaseStudyPullRequest[]>;
}

interface ProjectRow {
    id:             string;
    user_id:        string;
    name:           string;
    tagline:        string | null;
    pitch:          string | null;
    user_overrides: Record<string, unknown> | null;
}

interface ComponentRow {
    id:   string;
    name: string;
    kind: string;
}

interface RepoRow {
    id:               string;
    full_name:        string;
    primary_language: string | null;
    topics:           string[] | null;
    tech_stack:       string[] | null;
    default_branch:   string | null;
}

interface KbRow {
    repo_full_name: string;
    file_path:      string | null;
    chunk_type:     string;
    content:        string;
}

/** Number of KB chunks fed to the prompt. Hard cap to bound input cost. */
const KB_CHUNK_CAP = 24;
/** Per-repo commit cap. Multiplied by the number of repos in the project. */
const COMMITS_PER_REPO = 50;
/** Per-repo PR cap. Multiplied by the number of repos in the project. */
const PULLS_PER_REPO = 25;

export interface LoadCaseStudyContextResult {
    readonly userId:  string;
    readonly context: CaseStudyContext;
}

export async function loadCaseStudyContext(
    pool: Pool,
    projectId: string,
    commitLoader: CommitLoader,
    pullRequestLoader?: PullRequestLoader,
): Promise<LoadCaseStudyContextResult> {
    const project = await pool.query<ProjectRow>(
        `SELECT id, user_id, name, tagline, pitch, user_overrides
         FROM projects WHERE id = $1`,
        [projectId],
    );
    if (project.rows.length === 0) {
        throw new Error(`project not found: ${projectId}`);
    }
    const p = project.rows[0];

    const components = (await pool.query<ComponentRow>(
        `SELECT id, name, kind FROM project_components
         WHERE project_id = $1 ORDER BY order_index`,
        [projectId],
    )).rows;

    const repos = (await pool.query<RepoRow>(
        `SELECT
            r.id              AS id,
            r.full_name       AS full_name,
            r.primary_language AS primary_language,
            r.topics          AS topics,
            COALESCE(
                ARRAY(
                    SELECT jsonb_array_elements_text(
                        COALESCE(rp.extracted -> 'tech_stack', '[]'::jsonb)
                    )
                ),
                '{}'::text[]
            )                 AS tech_stack,
            r.default_branch  AS default_branch
         FROM project_repositories pr
         JOIN project_components pc ON pc.id = pr.project_component_id
         JOIN repositories r ON r.id = pr.repository_id
         LEFT JOIN repository_profiles rp
           ON rp.user_id = r.user_id AND rp.repo_full_name = r.full_name
         WHERE pc.project_id = $1
         ORDER BY r.full_name`,
        [projectId],
    )).rows;

    const kb = (await pool.query<KbRow>(
        `SELECT
            de.repo_full_name AS repo_full_name,
            de.file_path      AS file_path,
            'document'        AS chunk_type,
            de.content        AS content
         FROM document_embeddings de
         WHERE de.user_id::text = $1::text
           AND de.repo_full_name = ANY($2::text[])
         ORDER BY de.last_synced_at DESC
         LIMIT $3`,
        [p.user_id, repos.map((r) => r.full_name), KB_CHUNK_CAP],
    )).rows;

    const commits: CaseStudyContext['commits'][number][] = [];
    for (const repo of repos) {
        const repoCommits = await commitLoader.list(repo.full_name, { maxCommits: COMMITS_PER_REPO });
        for (const c of repoCommits) {
            commits.push({
                repoFullName: repo.full_name,
                sha:          c.sha,
                authoredAt:   c.authoredAt,
                authorName:   c.authorName,
                message:      c.message,
            });
        }
    }
    // Most-recent first across the merged list.
    commits.sort((a, b) => b.authoredAt.localeCompare(a.authoredAt));

    const pulls: CaseStudyContext['pulls'][number][] = [];
    if (pullRequestLoader) {
        for (const repo of repos) {
            // Per-repo failures must not nuke the whole context — PR
            // listing requires extra GitHub scope (`pull_requests:read`)
            // which a freshly-connected installation may not yet grant.
            let repoPulls: readonly CaseStudyPullRequest[] = [];
            try {
                repoPulls = await pullRequestLoader.list(repo.full_name, { maxPullRequests: PULLS_PER_REPO });
            } catch (err) {
                console.warn(`[case-study-loader] PR listing failed for ${repo.full_name}; continuing without PR evidence`, err);
            }
            for (const p of repoPulls) {
                pulls.push({
                    repoFullName: repo.full_name,
                    number:       p.number,
                    title:        p.title,
                    body:         p.body,
                    state:        p.state,
                    mergedAt:     p.mergedAt,
                    htmlUrl:      p.htmlUrl,
                });
            }
        }
        // Newest first across the merged list — mergedAt for merged PRs,
        // createdAt is a stable fallback for open ones.
        pulls.sort((a, b) =>
            (b.mergedAt ?? '').localeCompare(a.mergedAt ?? '')
            || b.number - a.number,
        );
    }

    return {
        userId: p.user_id,
        context: {
            projectId:     p.id,
            projectName:   p.name,
            tagline:       p.tagline,
            pitch:         p.pitch,
            userOverrides: p.user_overrides ?? {},
            components,
            repositories: repos.map((r) => ({
                id:               r.id,
                fullName:         r.full_name,
                primaryLanguage:  r.primary_language,
                topics:           r.topics ?? [],
                techStack:        r.tech_stack ?? [],
                defaultBranch:    r.default_branch,
            })),
            commits,
            pulls,
            kbChunks: kb.map((row) => ({
                repoFullName: row.repo_full_name,
                filePath:     row.file_path,
                chunkType:    row.chunk_type,
                content:      row.content,
            })),
        },
    };
}
