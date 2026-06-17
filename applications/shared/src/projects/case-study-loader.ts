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
 *   - `repo_commits` — commit evidence (sha, author, authored_at, message)
 *   - `repo_pull_requests` — PR evidence (number, title, body, state, urls)
 *
 * Commits + PRs are now read directly from RDS (`repo_commits` /
 * `repo_pull_requests`, populated by ingestion). No GitHub network IO
 * happens here, so the loader takes only the pool + projectId.
 */
import type { Pool } from 'pg';

import type { CaseStudyContext } from './case-study-types.js';
import { packContext } from './case-study-context-budget.js';
import { RdsProjectOntologyRepository } from '../rds/implementations/RdsProjectOntologyRepository.js';
import { classifyArchetype } from './archetype-classifier.js';
import { pickStage } from './derive-stage.js';
import { deriveDepthMarkers } from './case-study-depth.js';

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
    id:                  string;
    user_id:            string;
    name:               string;
    tagline:            string | null;
    pitch:              string | null;
    product_description: string | null;
    user_overrides:     Record<string, unknown> | null;
    type:               string;
    shape:              string;
}

interface ComponentRow {
    id:   string;
    name: string;
    kind: string;
}

interface RepoRow {
    id:               string;
    full_name:        string;
    description:      string | null;
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
/** Cap on most-changed files surfaced as file-level evidence to the agent. */
const FILE_CHANGE_CAP = 30;
/** Max chars of root-README prose taken per repo for product context. */
const README_CHARS_PER_REPO = 1_400;
/** Global cap on the assembled productContext string. */
const PRODUCT_CONTEXT_CHARS = 4_000;

interface ReadmeRow {
    repo_full_name: string;
    content:        string;
}

/** Reassemble root-README prose per repo (rows arrive ordered by chunk_index),
 *  capped per repo. Extracted to keep the loader's complexity bounded. */
function assembleReadmeMap(rows: readonly ReadmeRow[]): Map<string, string> {
    const byRepo = new Map<string, string>();
    for (const row of rows) {
        const existing = byRepo.get(row.repo_full_name) ?? '';
        if (existing.length >= README_CHARS_PER_REPO) continue;
        byRepo.set(row.repo_full_name, (existing + '\n' + row.content).slice(0, README_CHARS_PER_REPO));
    }
    return byRepo;
}

/**
 * Assemble the ground-truth product-purpose context, in precedence order:
 *   1. the user's product_description override (authoritative, verbatim)
 *   2. otherwise: each repo's GitHub description + the head of its root README
 *
 * Returns null when no source carries any product prose — the agent then keeps
 * today's code-only framing rather than inventing a purpose. Pure given inputs.
 */
function buildProductContext(
    override: string | null,
    repos: ReadonlyArray<{ fullName: string; description: string | null }>,
    readmeByRepo: ReadonlyMap<string, string>,
): string | null {
    const trimmed = override?.trim();
    if (trimmed) return trimmed.slice(0, PRODUCT_CONTEXT_CHARS);

    const parts: string[] = [];
    for (const r of repos) {
        const desc = r.description?.trim();
        const readme = readmeByRepo.get(r.fullName)?.trim();
        if (!desc && !readme) continue;
        const block = [`### ${r.fullName}`, desc, readme].filter(Boolean).join('\n');
        parts.push(block);
    }
    if (parts.length === 0) return null;
    return parts.join('\n\n').slice(0, PRODUCT_CONTEXT_CHARS);
}
/**
 * Global ceiling (estimated tokens) for the serialised context. Sonnet's
 * window is ~200k; budgeting context to 120k leaves generous headroom for
 * the system prompt + tool schema + the structured output (raised to 32k).
 * Commits + PRs are read in full from RDS; this bounds how much actually
 * reaches the prompt once a project spans multiple repos.
 */
const CONTEXT_TOKEN_BUDGET = 120_000;

export interface LoadCaseStudyContextResult {
    readonly userId:  string;
    readonly context: CaseStudyContext;
}

/**
 * Code-grounded evidence for the case study: deterministic DepthMarkers from
 * fileClass lane counts + archetype signals, plus the most-changed files from
 * the ingested commit diffs. Kept separate from the main loader to bound its
 * complexity.
 */
async function loadCodeGroundedEvidence(
    pool: Pool,
    userId: string,
    repoNames: string[],
    archetype: Record<string, boolean>,
    commits: ReadonlyArray<{ message: string }>,
): Promise<Pick<CaseStudyContext, 'depthMarkers' | 'fileChangeEvidence'>> {
    const laneRows = (await pool.query<{ fc: string; cnt: string }>(
        `SELECT de.metadata->>'fileClass' AS fc, count(*) AS cnt
           FROM document_embeddings de
          WHERE de.user_id::text = $1::text
            AND de.repo_full_name = ANY($2::text[])
            AND de.metadata->>'fileClass' IS NOT NULL
          GROUP BY de.metadata->>'fileClass'`,
        [userId, repoNames],
    )).rows;
    const laneCounts: Record<string, number> = {};
    for (const row of laneRows) laneCounts[row.fc] = Number(row.cnt);

    const refactorCount = commits.filter((c) => /\brefactor/i.test(c.message)).length;
    const depthMarkers = deriveDepthMarkers({ laneCounts, archetype, refactorCount });

    const fileRows = (await pool.query<{ repo_full_name: string; file_path: string; additions: string; deletions: string; changes: string }>(
        `SELECT repo_full_name, file_path,
                sum(additions) AS additions, sum(deletions) AS deletions, sum(changes) AS changes
           FROM repo_commit_files
          WHERE user_id = $1 AND repo_full_name = ANY($2::text[])
          GROUP BY repo_full_name, file_path
          ORDER BY (sum(additions) + sum(deletions)) DESC
          LIMIT $3`,
        [userId, repoNames, FILE_CHANGE_CAP],
    )).rows;
    const fileChangeEvidence = fileRows.map((r) => ({
        repoFullName: r.repo_full_name,
        filePath:     r.file_path,
        additions:    Number(r.additions),
        deletions:    Number(r.deletions),
        changes:      Number(r.changes),
    }));

    return { depthMarkers, fileChangeEvidence };
}

export async function loadCaseStudyContext(
    pool: Pool,
    projectId: string,
): Promise<LoadCaseStudyContextResult> {
    const project = await pool.query<ProjectRow>(
        `SELECT id, user_id, name, tagline, pitch, product_description, user_overrides, type, shape
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
            r.description     AS description,
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

    const repoNames = repos.map((r) => r.full_name);

    // Pre-derived archetype signals persisted by ingestion. Merge across the
    // project's repos: a signal is true if true for ANY member repo.
    const sigRows = (await pool.query<{ archetype_signals: Record<string, boolean> | null }>(
        `SELECT archetype_signals FROM repo_sync_state
          WHERE user_id = $1 AND repo_full_name = ANY($2::text[])`,
        [p.user_id, repoNames],
    )).rows;
    const mergedSignals: Record<string, boolean> = {};
    for (const row of sigRows) {
        for (const [k, v] of Object.entries(row.archetype_signals ?? {})) {
            if (v) mergedSignals[k] = true;
        }
    }

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
        [p.user_id, repoNames, KB_CHUNK_CAP],
    )).rows;

    // Root-README prose per repo — the human "what/why/who" the code evidence
    // can't carry. Ordered by chunk_index so the intro (chunk 0) leads; capped
    // per repo. file_path is the repo-root README (no directory prefix).
    const readmeRows = (await pool.query<ReadmeRow>(
        `SELECT repo_full_name, content
           FROM document_embeddings
          WHERE user_id::text = $1::text
            AND repo_full_name = ANY($2::text[])
            AND lower(file_path) IN ('readme.md', 'readme')
          ORDER BY repo_full_name, chunk_index ASC`,
        [p.user_id, repoNames],
    )).rows;
    const readmeByRepo = assembleReadmeMap(readmeRows);
    const productContext = buildProductContext(
        p.product_description,
        repos.map((r) => ({ fullName: r.full_name, description: r.description })),
        readmeByRepo,
    );

    // Commit evidence now lives in RDS (`repo_commits`, populated by
    // ingestion). Newest first across all member repos.
    const commitRows = (await pool.query<{ repo_full_name: string; sha: string; author_name: string; authored_at: Date | string; message: string }>(
        `SELECT repo_full_name, sha, author_name, authored_at, message
           FROM repo_commits
          WHERE user_id = $1 AND repo_full_name = ANY($2::text[])
          ORDER BY authored_at DESC`,
        [p.user_id, repoNames],
    )).rows;
    const commits = commitRows.map((r) => ({
        repoFullName: r.repo_full_name,
        sha:          r.sha,
        authoredAt:   r.authored_at instanceof Date ? r.authored_at.toISOString() : String(r.authored_at),
        authorName:   r.author_name,
        message:      r.message,
    }));

    // PR evidence likewise from RDS (`repo_pull_requests`). Newest merged
    // first; open/unmerged PRs sort last via NULLS LAST.
    const pullRows = (await pool.query<{ repo_full_name: string; number: number; title: string; body: string | null; state: string; merged_at: Date | string | null; html_url: string }>(
        `SELECT repo_full_name, number, title, body, state, merged_at, html_url
           FROM repo_pull_requests
          WHERE user_id = $1 AND repo_full_name = ANY($2::text[])
          ORDER BY merged_at DESC NULLS LAST`,
        [p.user_id, repoNames],
    )).rows;
    const pulls = pullRows.map((r) => ({
        repoFullName: r.repo_full_name,
        number:       r.number,
        title:        r.title,
        body:         r.body,
        state:        r.state as 'open' | 'closed' | 'merged',
        mergedAt:     r.merged_at ? (r.merged_at instanceof Date ? r.merged_at.toISOString() : String(r.merged_at)) : null,
        htmlUrl:      r.html_url,
    }));

    const { depthMarkers, fileChangeEvidence } = await loadCodeGroundedEvidence(
        pool, p.user_id, repoNames, mergedSignals, commits,
    );

    const rawContext: CaseStudyContext = {
        projectId:     p.id,
        projectName:   p.name,
        tagline:       p.tagline,
        pitch:         p.pitch,
        productContext,
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
        depthMarkers,
        fileChangeEvidence,
    };

    // Bound the prompt to a global token ceiling. Without this, a multi_repo
    // project (2+ repos × COMMITS_PER_REPO commits + KB chunks, unbounded
    // per-item text) serialised to ~213k input tokens — near Sonnet's window —
    // and drove the model past its output cap (stopReason='max_tokens'),
    // failing the run. CONTEXT_TOKEN_BUDGET leaves ample room for the
    // structured output below the context limit. Packing runs here (not in the
    // agent) so the orchestrator's input-hash and the prompt see identical,
    // already-bounded content.
    // ── Archetype/stage calibration (additive; absent fields = no change) ──
    const ontology   = new RdsProjectOntologyRepository(pool);
    const archetypes = await ontology.listArchetypes();
    const classified = classifyArchetype(mergedSignals, p.type, archetypes);

    let calibration: Partial<Pick<CaseStudyContext,
        'archetype' | 'stage' | 'prioritySections' | 'deemphasizedSections'>> = {};

    if (classified) {
        const def = archetypes.find((a) => a.id === classified.archetypeId) ?? null;
        const seniorityRow = await pool.query<{ direction: { seniority?: Array<{ area: string; level: string }> } | null }>(
            `SELECT direction FROM user_profile_rollup WHERE user_id = $1`,
            [p.user_id],
        );
        const seniority = seniorityRow.rows[0]?.direction?.seniority ?? [];
        const stage = pickStage(seniority);
        const overlay = stage ? await ontology.getStageOverlay(classified.archetypeId, stage) : null;

        calibration = {
            archetype: def ? { id: def.id, name: def.name } : { id: classified.archetypeId, name: classified.archetypeId },
            stage,
            prioritySections: overlay?.prioritySections ?? def?.expectedSections ?? [],
            deemphasizedSections: overlay?.deemphasizedSections ?? [],
        };
        // The computed archetype/stage are surfaced via `context.archetype`/
        // `context.stage` and persisted atomically with the case study inside
        // persistCaseStudy's transaction — not written here on the pool.
    }

    const context = packContext({ ...rawContext, ...calibration }, { maxTokens: CONTEXT_TOKEN_BUDGET });

    return { userId: p.user_id, context };
}
