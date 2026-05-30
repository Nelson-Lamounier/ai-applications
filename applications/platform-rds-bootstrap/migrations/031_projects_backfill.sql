-- 031_projects_backfill.sql
--
-- Backfill default single-repo projects for every pre-existing repository.
--
-- For each `repositories` row that has no corresponding
-- `project_repositories` link yet, create exactly one project + one
-- component + one link. New users created after this migration follow the
-- same path through the onboarding orchestrator (Phase 4 work).
--
-- Idempotency: the WHERE NOT EXISTS clause filters out repos that were
-- already backfilled, so re-runs on every bootstrap are a no-op. The
-- per-row INSERTs are wrapped in a single transaction; partial failure
-- rolls back cleanly without leaving orphaned projects.
--
-- Slug derivation: lower-cased `provider/full_name`, with non-[a-z0-9]
-- runs collapsed to a single dash and leading/trailing dashes stripped.
-- Because `repositories.full_name` already includes the owner prefix and
-- the table has UNIQUE(user_id, provider, full_name), the resulting
-- per-user slug is unique by construction — no suffix loop needed.

BEGIN;

WITH candidates AS (
    SELECT
        r.id                                        AS repository_id,
        r.user_id                                   AS user_id,
        r.full_name                                 AS full_name,
        r.added_at                                  AS added_at,
        r.indexed_at                                AS indexed_at,
        split_part(r.full_name, '/', 2)             AS repo_short_name,
        regexp_replace(
            regexp_replace(LOWER(r.full_name), '[^a-z0-9]+', '-', 'g'),
            '(^-+|-+$)', '', 'g'
        )                                           AS slug,
        gen_random_uuid()                           AS project_id,
        gen_random_uuid()                           AS component_id
    FROM repositories r
    WHERE NOT EXISTS (
        SELECT 1
        FROM project_repositories pr
        WHERE pr.repository_id = r.id
    )
),
inserted_projects AS (
    INSERT INTO projects (
        id, user_id, slug, name, shape, is_ai_suggested, is_user_confirmed,
        status, role_exhibited, visibility,
        started_at, last_activity_at
    )
    SELECT
        c.project_id,
        c.user_id,
        c.slug,
        COALESCE(NULLIF(c.repo_short_name, ''), c.full_name),
        'single_repo',
        FALSE,
        FALSE,
        'active',
        'sole_builder',
        'private',
        c.added_at,
        c.indexed_at
    FROM candidates c
    ON CONFLICT (user_id, slug) DO NOTHING
    RETURNING id, user_id
),
inserted_components AS (
    INSERT INTO project_components (id, user_id, project_id, name, kind, order_index)
    SELECT
        c.component_id,
        c.user_id,
        c.project_id,
        'Main',
        'shared',
        0
    FROM candidates c
    WHERE c.project_id IN (SELECT id FROM inserted_projects)
    RETURNING id, project_id
)
INSERT INTO project_repositories (user_id, project_component_id, repository_id, subpath)
SELECT
    c.user_id,
    c.component_id,
    c.repository_id,
    ''
FROM candidates c
WHERE c.component_id IN (SELECT id FROM inserted_components)
ON CONFLICT (project_component_id, repository_id, subpath) DO NOTHING;

COMMIT;
