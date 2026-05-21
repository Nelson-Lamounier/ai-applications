/**
 * @file projects.ts
 * @description Public-facing project case-study endpoint.
 *
 * Single route, no authentication. The migration spec calls for
 * `/public/projects/:slug`, but per-user slug uniqueness (`UNIQUE(user_id,
 * slug)` from migration 030) means two users could legitimately share a
 * slug. We therefore expose `/public/projects/:username/:slug` to match
 * the tucaken-app route shape `/u/[username]/p/[slug]` exactly; the
 * username segment resolves through `oauth_connections.username` for
 * provider='github' (the only public identity in the system today).
 *
 * Routes:
 *
 *   GET /public/projects/:username/:slug — returns the assembled case
 *                                          study JSON. 404 unless
 *                                          `visibility='public'`.
 *
 * Visibility enforcement is strict and unrecoverable: a project with
 * `visibility='private'` or `'unlisted'` returns 404 here. There is no
 * way to bypass the filter from outside the database.
 *
 * Authentication: none — this is the recruiter-facing share URL. The
 * single route is rate-limited at the upstream (Traefik) layer via the
 * existing public-api ingress; this file does not implement its own
 * limiter.
 *
 * Caching: 5 minute s-maxage. Case studies regenerate on demand (Phase
 * 2B), but stale-by-five-minutes is acceptable for a recruiter-share
 * link and keeps the Postgres load tiny.
 */

import { Hono } from 'hono';

import { loadConfig } from '../lib/config.js';
import { getPool } from '../lib/pg.js';

const projects = new Hono();

const CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=600';

/** Loose username sanity check — alphanumeric + dashes, 1–80 chars. */
const USERNAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/;
/** Slug regex from migration 030's expected shape. */
const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

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
interface ResumeBulletRow { angle: string; bullets: string[] }
interface TagRow { tag: string }

/**
 * GET /public/projects/:username/:slug
 *
 * Returns a denormalised case-study object suitable for direct
 * server-side rendering. The shape is intentionally JSON-stable — the
 * tucaken-app `PublicCaseStudy` component will read it as-is.
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

    const [
        components, repositories, decisions, highlights, challenges,
        stack, depth, architecture, resumeBullets, tags,
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
        pool.query<ResumeBulletRow>(
            `SELECT angle, bullets
               FROM project_resume_bullets WHERE project_id = $1`,
            [project.id],
        ),
        pool.query<TagRow>(
            `SELECT tag FROM project_tags WHERE project_id = $1 ORDER BY tag`,
            [project.id],
        ),
    ]);

    const payload = {
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
        resumeBullets:  resumeBullets.rows,
        tags:           tags.rows.map((r) => r.tag),
    };

    c.header('Cache-Control', CACHE_CONTROL);
    return c.json(payload);
});

export default projects;
