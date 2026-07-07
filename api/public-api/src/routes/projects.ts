/**
 * @file projects.ts
 * @description Public-facing project case-study endpoints.
 *
 * No authentication. Two public surfaces share the same assembly code but
 * are scoped differently on purpose:
 *
 *   GET /api/projects                     — the PORTFOLIO owner's public
 *                                           project cards. Scoped by
 *                                           PORTFOLIO_OWNER_USER_ID (env),
 *                                           never by username: this is the
 *                                           single-owner portfolio grid,
 *                                           and it must be impossible for
 *                                           another user's projects to
 *                                           appear on the site. Fails
 *                                           closed (empty list) when the
 *                                           env is unset.
 *   GET /api/projects/:slug               — the owner's case study by
 *                                           slug, same owner pinning.
 *                                           404 when not the owner's, not
 *                                           public, or unknown — all
 *                                           indistinguishable.
 *   GET /public/projects/:username/:slug  — the tucaken-app share URL
 *                                           (multi-user product surface,
 *                                           /u/[username]/p/[slug]). The
 *                                           username segment resolves via
 *                                           oauth_connections.username for
 *                                           provider='github'.
 *
 * Why user id and not username for the portfolio: per-user slug
 * uniqueness (`UNIQUE(user_id, slug)`, migration 030) makes slugs
 * ambiguous across users, and `oauth_connections.username` is NOT unique
 * either (UNIQUE is on (user_id, provider); GitHub usernames can be
 * renamed and reclaimed). The internal user id is the only stable
 * isolation key, and it lives in the in-cluster BFF config — the
 * frontend never names an identity at all.
 *
 * Visibility enforcement is strict and unrecoverable on every route: a
 * project with `visibility='private'` or `'unlisted'` returns 404/empty.
 * There is no way to bypass the filter from outside the database.
 *
 * Authentication: none — these are the recruiter-facing surfaces. Rate
 * limiting happens at the upstream (Traefik) layer via the existing
 * public-api ingress; this file does not implement its own limiter.
 *
 * Caching: 5 minute s-maxage. Case studies regenerate on demand (Phase
 * 2B), but stale-by-five-minutes is acceptable for a recruiter-facing
 * page and keeps the Postgres load tiny.
 */

import { Hono } from 'hono';

import { projectCaseStudyKey, projectOwnerPublicListKey } from '@bedrock/shared';
import { loadConfig } from '../lib/config.js';
import type { Config } from '../lib/config.js';
import { getPool } from '../lib/pg.js';
import { getReadCache, READ_CACHE_DEFAULT_TTL } from '../lib/cache.js';

const projects = new Hono();

const CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=600';

/** List-cache TTL — must track s-maxage above, not the 1h default TTL. */
const PROJECT_LIST_TTL_SECONDS = 300;

/** Loose username sanity check — alphanumeric + dashes, 1–80 chars. */
const USERNAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/;
/** Slug regex from migration 030's expected shape. */
const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

type Pool = ReturnType<typeof getPool>;

interface ProjectRow {
    id:                       string;
    user_id:                  string;
    name:                     string;
    slug:                     string;
    tagline:                  string | null;
    pitch:                    string | null;
    type:                     string;
    shape:                    string;
    status:                   string;
    role_exhibited:           string;
    started_at:               Date | null;
    ended_at:                 Date | null;
    last_activity_at:         Date | null;
    updated_at:               Date;
}

interface ComponentRow { id: string; name: string; kind: string; order_index: number }
interface RepoRow      { component_id: string; repository_full_name: string; subpath: string }
interface DecisionRow {
    title:         string;
    context:       string | null;
    decision:      string | null;
    consequences:  string | null;
    confidence:    string;
    source_signals: unknown;
    order_index:   number;
}
interface HighlightRow { title: string; description: string | null; order_index: number }
interface ChallengeRow { problem: string; solution: string | null; source_signals: unknown; order_index: number }
interface StackRow     { category: string; name: string; justification: string | null; order_index: number }
interface DepthRow {
    has_tests:               boolean;
    test_coverage_signal:    string;
    has_ci:                  boolean;
    ci_maturity:             string;
    documentation_density:   string;
    has_deployment_evidence: boolean;
    deployment_url:          string | null;
    refactor_count:          number;
}
interface ArchitectureRow {
    diagram_format: string;
    diagram_source: string;
    nodes:          unknown;
    edges:          unknown;
}
interface TagRow { tag: string }

// ---------------------------------------------------------------------------
// Case-study assembly (shared by the owner and share detail routes)
// ---------------------------------------------------------------------------

/**
 * Assemble the denormalised case-study payload for one already-authorised
 * project row. Callers own the visibility/ownership WHERE clause; this
 * function only fans out to the child tables and shapes the JSON. The
 * shape is intentionally JSON-stable — the tucaken-app `PublicCaseStudy`
 * component and the portfolio case-study page both read it as-is.
 */
async function assembleCaseStudy(pool: Pool, project: ProjectRow, username: string | null) {
    const [
        components, repositories, decisions, highlights, challenges,
        stack, depth, architecture, tags,
    ] = await Promise.all([
        pool.query<ComponentRow>(
            `SELECT id, name, kind, order_index
               FROM project_components WHERE project_id = $1 ORDER BY order_index`,
            [project.id],
        ),
        pool.query<RepoRow>(
            `SELECT pc.id AS component_id, r.full_name AS repository_full_name, pr.subpath
               FROM project_repositories pr
               JOIN project_components pc ON pc.id = pr.project_component_id
               JOIN repositories r ON r.id = pr.repository_id
              WHERE pc.project_id = $1 AND r.is_private = FALSE
              ORDER BY pc.order_index, r.full_name`,
            [project.id],
        ),
        pool.query<DecisionRow>(
            `SELECT title, context, decision, consequences, confidence, source_signals, order_index
               FROM project_decisions WHERE project_id = $1 ORDER BY order_index`,
            [project.id],
        ),
        pool.query<HighlightRow>(
            `SELECT title, description, order_index
               FROM project_highlights WHERE project_id = $1 ORDER BY order_index`,
            [project.id],
        ),
        pool.query<ChallengeRow>(
            `SELECT problem, solution, source_signals, order_index
               FROM project_challenges WHERE project_id = $1 ORDER BY order_index`,
            [project.id],
        ),
        pool.query<StackRow>(
            `SELECT category, name, justification, order_index
               FROM project_stack_items WHERE project_id = $1 ORDER BY order_index`,
            [project.id],
        ),
        pool.query<DepthRow>(
            `SELECT has_tests, test_coverage_signal, has_ci, ci_maturity,
                    documentation_density, has_deployment_evidence, deployment_url, refactor_count
               FROM project_depth_markers WHERE project_id = $1`,
            [project.id],
        ),
        pool.query<ArchitectureRow>(
            `SELECT diagram_format, diagram_source, nodes, edges
               FROM project_architecture WHERE project_id = $1`,
            [project.id],
        ),
        pool.query<TagRow>(
            `SELECT tag FROM project_tags WHERE project_id = $1 ORDER BY tag`,
            [project.id],
        ),
    ]);

    return {
        username,
        slug:           project.slug,
        name:           project.name,
        tagline:        project.tagline,
        pitch:          project.pitch,
        type:           project.type,
        shape:          project.shape,
        status:         project.status,
        roleExhibited:  project.role_exhibited,
        startedAt:      project.started_at?.toISOString()       ?? null,
        endedAt:        project.ended_at?.toISOString()         ?? null,
        lastActivityAt: project.last_activity_at?.toISOString() ?? null,
        updatedAt:      project.updated_at.toISOString(),
        components:     components.rows,
        repositories:   repositories.rows,
        decisions:      decisions.rows,
        highlights:     highlights.rows,
        challenges:     challenges.rows,
        stack:          stack.rows,
        depthMarkers:   depth.rows[0] ?? null,
        architecture:   architecture.rows[0] ?? null,
        // Dashboard-only CV material — never served publicly. The key stays
        // (as an empty array) so an older deployed UI reading
        // `.resumeBullets.length` cannot crash on a missing field.
        resumeBullets:  [],
        tags:           tags.rows.map((r) => r.tag),
    };
}

// ---------------------------------------------------------------------------
// Owner-scoped portfolio routes
// ---------------------------------------------------------------------------

/**
 * Resolve the configured portfolio owner. Fail closed with a warn: an
 * unset env must yield "nothing published", never "everyone's projects".
 */
function ownerUserId(cfg: Config): string | undefined {
    if (!cfg.portfolioOwnerUserId) {
        console.warn('[projects] PORTFOLIO_OWNER_USER_ID is not set — owner-scoped project routes return nothing');
        return undefined;
    }
    return cfg.portfolioOwnerUserId;
}

// Card-level rows for the list endpoint. Children (tags/stack/repos) are
// fetched with `project_id = ANY($1)` batch queries and grouped in JS —
// the list is portfolio-scale (single digits), so three flat queries beat
// per-project fan-out or JSON aggregation for readability.
interface ListProjectRow {
    id:                string;
    slug:              string;
    name:              string;
    tagline:           string | null;
    type:              string;
    shape:             string;
    role_exhibited:    string;
    case_study_status: string | null;
    started_at:        Date | null;
    last_activity_at:  Date | null;
    updated_at:        Date;
}
interface ListTagRow   { project_id: string; tag: string }
interface ListStackRow { project_id: string; category: string; name: string; order_index: number }
interface ListRepoRow  { project_id: string; repository_full_name: string }

/**
 * GET /api/projects
 *
 * Card list for the portfolio /projects grid: every `visibility='public'`,
 * non-archived project OF THE CONFIGURED OWNER, with the fields a card
 * needs (tagline, tags, stack, public repo names, caseStudyStatus). Uses
 * the same visibility gate as the detail routes, so no listed card can
 * 404 on click.
 */
projects.get('/api/projects', async (c) => {
    const cfg  = loadConfig();
    const pool = getPool(cfg);

    const owner = ownerUserId(cfg);
    if (!owner) {
        c.header('Cache-Control', CACHE_CONTROL);
        return c.json({ items: [], count: 0 });
    }

    // Explicit 300s: matches CACHE_CONTROL's s-maxage. The configured default
    // TTL is an hour in production, which turned a visibility flip into an
    // hour of stale-empty grid — publish latency must track the HTTP cache.
    const payload = await getReadCache().getOrCompute(
        projectOwnerPublicListKey(owner),
        PROJECT_LIST_TTL_SECONDS,
        async () => {
            const projectRows = await pool.query<ListProjectRow>(
                `SELECT p.id, p.slug, p.name, p.tagline, p.type, p.shape,
                        p.role_exhibited, p.case_study_status,
                        p.started_at, p.last_activity_at, p.updated_at
                   FROM projects p
                  WHERE p.user_id = $1
                    AND p.visibility = 'public'
                    AND p.status <> 'archived'
                  ORDER BY p.last_activity_at DESC NULLS LAST, p.name`,
                [owner],
            );
            if (projectRows.rows.length === 0) return { items: [], count: 0 };

            const ids = projectRows.rows.map((r) => r.id);
            const [tags, stack, repos] = await Promise.all([
                pool.query<ListTagRow>(
                    `SELECT project_id, tag
                       FROM project_tags WHERE project_id = ANY($1) ORDER BY tag`,
                    [ids],
                ),
                pool.query<ListStackRow>(
                    `SELECT project_id, category, name, order_index
                       FROM project_stack_items WHERE project_id = ANY($1) ORDER BY order_index`,
                    [ids],
                ),
                // Same is_private filter as the detail assembly: a private
                // repo linked to a public project must not leak its name.
                pool.query<ListRepoRow>(
                    `SELECT DISTINCT pc.project_id, r.full_name AS repository_full_name
                       FROM project_repositories pr
                       JOIN project_components pc ON pc.id = pr.project_component_id
                       JOIN repositories r ON r.id = pr.repository_id
                      WHERE pc.project_id = ANY($1) AND r.is_private = FALSE`,
                    [ids],
                ),
            ]);

            const byProject = <T extends { project_id: string }>(rows: T[]) => {
                const m = new Map<string, T[]>();
                for (const row of rows) {
                    const list = m.get(row.project_id) ?? [];
                    list.push(row);
                    m.set(row.project_id, list);
                }
                return m;
            };
            const tagsBy  = byProject(tags.rows);
            const stackBy = byProject(stack.rows);
            const reposBy = byProject(repos.rows);

            const items = projectRows.rows.map((p) => ({
                slug:            p.slug,
                name:            p.name,
                tagline:         p.tagline,
                type:            p.type,
                shape:           p.shape,
                roleExhibited:   p.role_exhibited,
                caseStudyStatus: p.case_study_status,
                startedAt:       p.started_at?.toISOString()       ?? null,
                lastActivityAt:  p.last_activity_at?.toISOString() ?? null,
                updatedAt:       p.updated_at.toISOString(),
                tags:            (tagsBy.get(p.id)  ?? []).map((t) => t.tag),
                stack:           (stackBy.get(p.id) ?? []).map((s) => ({ category: s.category, name: s.name })),
                repositories:    (reposBy.get(p.id) ?? []).map((r) => r.repository_full_name).sort(),
            }));
            return { items, count: items.length };
        },
        'project_public_list',
    );

    c.header('Cache-Control', CACHE_CONTROL);
    return c.json(payload);
});

/**
 * GET /api/projects/:slug
 *
 * The owner's case study by slug, pinned to PORTFOLIO_OWNER_USER_ID.
 * Unknown slug, another user's slug, non-public visibility, and unset
 * owner env are all a bare 404 — indistinguishable by design.
 */
projects.get('/api/projects/:slug', async (c) => {
    const slug = c.req.param('slug');
    if (!SLUG_REGEX.test(slug)) return c.json({ error: 'Not found' }, 404);

    const cfg  = loadConfig();
    const pool = getPool(cfg);

    const owner = ownerUserId(cfg);
    if (!owner) return c.json({ error: 'Not found' }, 404);

    // LEFT JOIN: the payload carries the owner's github username for shape
    // parity with the share route, but a disconnected oauth row must not
    // hide an otherwise-public project.
    const projectResult = await pool.query<ProjectRow & { username: string | null }>(
        `SELECT p.id, p.user_id, p.name, p.slug, p.tagline, p.pitch, p.type, p.shape,
                p.status, p.role_exhibited,
                p.started_at, p.ended_at, p.last_activity_at, p.updated_at,
                oc.username
           FROM projects p
           LEFT JOIN oauth_connections oc
             ON oc.user_id = p.user_id AND oc.provider = 'github'
          WHERE p.user_id = $1
            AND p.visibility = 'public'
            AND p.status <> 'archived'
            AND p.slug = $2
          LIMIT 1`,
        [owner, slug],
    );
    const project = projectResult.rows[0];
    if (!project) return c.json({ error: 'Not found' }, 404);

    const payload = await getReadCache().getOrCompute(
        projectCaseStudyKey(project.id),
        READ_CACHE_DEFAULT_TTL,
        () => assembleCaseStudy(pool, project, project.username),
        'project_case_study',
    );

    c.header('Cache-Control', CACHE_CONTROL);
    return c.json(payload);
});

// ---------------------------------------------------------------------------
// Tucaken share route (multi-user surface)
// ---------------------------------------------------------------------------

/**
 * GET /public/projects/:username/:slug
 *
 * The tucaken-app share URL. Multi-user by design: any user's PUBLIC
 * case study resolves here via their github username. The portfolio does
 * NOT use this route — it uses the owner-pinned /api/projects surface.
 */
projects.get('/public/projects/:username/:slug', async (c) => {
    const username = c.req.param('username');
    const slug     = c.req.param('slug');
    if (!USERNAME_REGEX.test(username)) return c.json({ error: 'Not found' }, 404);
    if (!SLUG_REGEX.test(slug))         return c.json({ error: 'Not found' }, 404);

    const cfg  = loadConfig();
    const pool = getPool(cfg);

    const projectResult = await pool.query<ProjectRow>(
        `SELECT p.id, p.user_id, p.name, p.slug, p.tagline, p.pitch, p.type, p.shape,
                p.status, p.role_exhibited,
                p.started_at, p.ended_at, p.last_activity_at, p.updated_at
           FROM projects p
           JOIN oauth_connections oc
             ON oc.user_id = p.user_id AND oc.provider = 'github'
          WHERE p.visibility = 'public'
            AND p.status <> 'archived'
            AND p.slug = $1
            AND oc.username = $2
          LIMIT 1`,
        [slug, username],
    );
    const project = projectResult.rows[0];
    if (!project) return c.json({ error: 'Not found' }, 404);

    const payload = await getReadCache().getOrCompute(
        projectCaseStudyKey(project.id),
        READ_CACHE_DEFAULT_TTL,
        () => assembleCaseStudy(pool, project, username),
        'project_case_study',
    );

    c.header('Cache-Control', CACHE_CONTROL);
    return c.json(payload);
});

export default projects;
