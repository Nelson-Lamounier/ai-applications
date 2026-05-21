-- 030_projects.sql
--
-- Projects → Multi-Repo Case-Study migration (Phase 1 schema).
--
-- Adds the `projects` table and nine child tables that sit ABOVE
-- `repositories`. A project is the unit a user describes in interviews
-- (often spanning several repos); existing per-repo extraction stays in
-- `repository_profiles`.
--
-- Scope of this file: schema, indexes, RLS, GRANTs only. Data backfill of
-- single-repo default projects lives in 031_projects_backfill.sql.
--
-- Conventions:
--   - UUIDv4 PKs via gen_random_uuid() (codebase-wide; uuidv7 is a
--     separate RFC).
--   - vector(1024) for the project-level summary embedding to match the
--     Titan Embed v2 dimension used everywhere else.
--   - TEXT + CHECK for enums (idempotent; CREATE TYPE has no IF NOT EXISTS).
--   - Every row carries `user_id` denormalised so RLS policies stay flat
--     and cheap — mirrors `repository_profile_embeddings` (migration 014).
--   - IF NOT EXISTS / IF EXISTS / OR REPLACE on everything; the runner
--     re-applies every .sql on every bootstrap (no schema_migrations
--     tracking table today).
--   - One concern per file (per ROLLBACK.md). Backfill is split out.

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- Reusable updated_at trigger function (reused by 014/015). Defined here
-- with OR REPLACE so this file is self-contained; harmless re-definition
-- if the function already exists from a prior boot.
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ──────────────────────────────────────────────────────────────────────────
-- Table: projects
-- The interview unit. Lives above repositories.
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug                TEXT            NOT NULL,
    name                TEXT            NOT NULL,
    tagline             TEXT,
    pitch               TEXT,
    type                TEXT            NOT NULL DEFAULT 'side_project'
                                        CHECK (type IN (
                                          'side_project','open_source','production_saas',
                                          'client_work','internal_tool','learning_project')),
    shape               TEXT            NOT NULL DEFAULT 'single_repo'
                                        CHECK (shape IN ('single_repo','multi_repo','monorepo_subset')),
    status              TEXT            NOT NULL DEFAULT 'active'
                                        CHECK (status IN ('active','stable','dormant','archived')),
    role_exhibited      TEXT            NOT NULL DEFAULT 'sole_builder'
                                        CHECK (role_exhibited IN ('sole_builder','lead','contributor','maintainer')),
    visibility          TEXT            NOT NULL DEFAULT 'private'
                                        CHECK (visibility IN ('private','unlisted','public')),
    started_at          TIMESTAMPTZ,
    ended_at            TIMESTAMPTZ,
    last_activity_at    TIMESTAMPTZ,
    is_ai_suggested     BOOLEAN         NOT NULL DEFAULT FALSE,
    is_user_confirmed   BOOLEAN         NOT NULL DEFAULT FALSE,
    summary_embedding   vector(1024),
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    UNIQUE (user_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_projects_user_id
    ON projects (user_id);

CREATE INDEX IF NOT EXISTS idx_projects_user_status
    ON projects (user_id, status);

CREATE INDEX IF NOT EXISTS idx_projects_user_type
    ON projects (user_id, type);

CREATE INDEX IF NOT EXISTS idx_projects_public_slug
    ON projects (slug)
    WHERE visibility = 'public';

CREATE INDEX IF NOT EXISTS idx_projects_summary_embedding_hnsw
    ON projects USING hnsw (summary_embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

DROP TRIGGER IF EXISTS set_updated_at ON projects;
CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_projects ON projects;
CREATE POLICY rls_projects ON projects
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON projects TO tucaken_app;

-- Public-case-study readers bypass auth; the application enforces
-- `visibility='public'` at the route layer (Phase 3).

-- ──────────────────────────────────────────────────────────────────────────
-- Table: project_components
-- Logical sections of a project (frontend / backend / infra / ...).
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_components (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id          UUID            NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name                TEXT            NOT NULL,
    kind                TEXT            NOT NULL
                                        CHECK (kind IN (
                                          'frontend','backend','infra','mobile',
                                          'data','ml','docs','shared')),
    order_index         INTEGER         NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_components_project_id
    ON project_components (project_id, order_index);

CREATE INDEX IF NOT EXISTS idx_project_components_user_id
    ON project_components (user_id);

ALTER TABLE project_components ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_project_components ON project_components;
CREATE POLICY rls_project_components ON project_components
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON project_components TO tucaken_app;

-- ──────────────────────────────────────────────────────────────────────────
-- Table: project_repositories
-- Many-to-many link between components and repositories. `subpath` carves
-- out a monorepo subset (e.g. "apps/web") so a single repo can contribute
-- to multiple projects without ambiguity.
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_repositories (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_component_id UUID           NOT NULL REFERENCES project_components(id) ON DELETE CASCADE,
    repository_id       UUID            NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    subpath             TEXT            NOT NULL DEFAULT '',
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    UNIQUE (project_component_id, repository_id, subpath)
);

CREATE INDEX IF NOT EXISTS idx_project_repositories_component
    ON project_repositories (project_component_id);

CREATE INDEX IF NOT EXISTS idx_project_repositories_repository
    ON project_repositories (repository_id);

CREATE INDEX IF NOT EXISTS idx_project_repositories_user_id
    ON project_repositories (user_id);

ALTER TABLE project_repositories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_project_repositories ON project_repositories;
CREATE POLICY rls_project_repositories ON project_repositories
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON project_repositories TO tucaken_app;

-- ──────────────────────────────────────────────────────────────────────────
-- Table: project_tags
-- Free-form tags. Composite PK to dedupe per project.
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_tags (
    project_id          UUID            NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id             UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tag                 TEXT            NOT NULL,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_project_tags_tag
    ON project_tags (user_id, tag);

ALTER TABLE project_tags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_project_tags ON project_tags;
CREATE POLICY rls_project_tags ON project_tags
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON project_tags TO tucaken_app;

-- ──────────────────────────────────────────────────────────────────────────
-- Table: project_stack_items
-- AI-drafted, user-editable stack with per-item justification. Optional
-- link to the component that uses the item.
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_stack_items (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id          UUID            NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    category            TEXT            NOT NULL
                                        CHECK (category IN (
                                          'language','framework','database',
                                          'infrastructure','observability',
                                          'ci_cd','external_service')),
    name                TEXT            NOT NULL,
    used_in_component_id UUID           REFERENCES project_components(id) ON DELETE SET NULL,
    justification       TEXT,
    order_index         INTEGER         NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_stack_items_project_id
    ON project_stack_items (project_id, order_index);

CREATE INDEX IF NOT EXISTS idx_project_stack_items_category
    ON project_stack_items (project_id, category);

CREATE INDEX IF NOT EXISTS idx_project_stack_items_user_id
    ON project_stack_items (user_id);

ALTER TABLE project_stack_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_project_stack_items ON project_stack_items;
CREATE POLICY rls_project_stack_items ON project_stack_items
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON project_stack_items TO tucaken_app;

-- ──────────────────────────────────────────────────────────────────────────
-- Table: project_decisions
-- ADR-style entries. source_signals records the commits / PRs / files
-- that justify the inference (reused later by BedrockGroundingVerifier).
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_decisions (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id          UUID            NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title               TEXT            NOT NULL,
    context             TEXT,
    decision            TEXT,
    consequences        TEXT,
    source_signals      JSONB           NOT NULL DEFAULT '[]',
    confidence          TEXT            NOT NULL DEFAULT 'medium'
                                        CHECK (confidence IN ('high','medium','low')),
    is_user_confirmed   BOOLEAN         NOT NULL DEFAULT FALSE,
    order_index         INTEGER         NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_decisions_project_id
    ON project_decisions (project_id, order_index);

CREATE INDEX IF NOT EXISTS idx_project_decisions_user_id
    ON project_decisions (user_id);

CREATE INDEX IF NOT EXISTS idx_project_decisions_unconfirmed
    ON project_decisions (user_id, project_id)
    WHERE is_user_confirmed = FALSE;

DROP TRIGGER IF EXISTS set_updated_at ON project_decisions;
CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON project_decisions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE project_decisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_project_decisions ON project_decisions;
CREATE POLICY rls_project_decisions ON project_decisions
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON project_decisions TO tucaken_app;

-- ──────────────────────────────────────────────────────────────────────────
-- Table: project_highlights
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_highlights (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id          UUID            NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title               TEXT            NOT NULL,
    description         TEXT,
    order_index         INTEGER         NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_highlights_project_id
    ON project_highlights (project_id, order_index);

CREATE INDEX IF NOT EXISTS idx_project_highlights_user_id
    ON project_highlights (user_id);

ALTER TABLE project_highlights ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_project_highlights ON project_highlights;
CREATE POLICY rls_project_highlights ON project_highlights
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON project_highlights TO tucaken_app;

-- ──────────────────────────────────────────────────────────────────────────
-- Table: project_challenges
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_challenges (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id          UUID            NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    problem             TEXT            NOT NULL,
    solution            TEXT,
    source_signals      JSONB           NOT NULL DEFAULT '[]',
    order_index         INTEGER         NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_challenges_project_id
    ON project_challenges (project_id, order_index);

CREATE INDEX IF NOT EXISTS idx_project_challenges_user_id
    ON project_challenges (user_id);

ALTER TABLE project_challenges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_project_challenges ON project_challenges;
CREATE POLICY rls_project_challenges ON project_challenges
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON project_challenges TO tucaken_app;

-- ──────────────────────────────────────────────────────────────────────────
-- Table: project_resume_bullets
-- One row per (project, angle). `bullets` is a JSONB array of strings.
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_resume_bullets (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id          UUID            NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    angle               TEXT            NOT NULL
                                        CHECK (angle IN (
                                          'backend','frontend','infrastructure',
                                          'fullstack','data_ml','product_leadership')),
    bullets             JSONB           NOT NULL DEFAULT '[]',
    generated_at        TIMESTAMPTZ     NOT NULL DEFAULT now(),
    UNIQUE (project_id, angle)
);

CREATE INDEX IF NOT EXISTS idx_project_resume_bullets_user_id
    ON project_resume_bullets (user_id);

ALTER TABLE project_resume_bullets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_project_resume_bullets ON project_resume_bullets;
CREATE POLICY rls_project_resume_bullets ON project_resume_bullets
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON project_resume_bullets TO tucaken_app;

-- ──────────────────────────────────────────────────────────────────────────
-- Table: project_depth_markers
-- Single row per project summarising recruiter-visible engineering depth
-- signals.
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_depth_markers (
    id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id               UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE UNIQUE,
    has_tests                BOOLEAN     NOT NULL DEFAULT FALSE,
    test_coverage_signal     TEXT        NOT NULL DEFAULT 'none'
                                         CHECK (test_coverage_signal IN ('none','light','moderate','strong')),
    has_ci                   BOOLEAN     NOT NULL DEFAULT FALSE,
    ci_maturity              TEXT        NOT NULL DEFAULT 'none'
                                         CHECK (ci_maturity IN ('none','basic','deploys_to_prod','multi_env')),
    documentation_density    TEXT        NOT NULL DEFAULT 'none'
                                         CHECK (documentation_density IN ('none','readme_only','docs_dir','comprehensive')),
    has_deployment_evidence  BOOLEAN     NOT NULL DEFAULT FALSE,
    deployment_url           TEXT,
    refactor_count           INTEGER     NOT NULL DEFAULT 0,
    computed_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_depth_markers_user_id
    ON project_depth_markers (user_id);

ALTER TABLE project_depth_markers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_project_depth_markers ON project_depth_markers;
CREATE POLICY rls_project_depth_markers ON project_depth_markers
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON project_depth_markers TO tucaken_app;

-- ──────────────────────────────────────────────────────────────────────────
-- Table: project_architecture
-- One row per project. Mermaid first; SVG-from-scratch is a Phase 5 follow-up.
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_architecture (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id      UUID            NOT NULL REFERENCES projects(id) ON DELETE CASCADE UNIQUE,
    diagram_format  TEXT            NOT NULL DEFAULT 'mermaid'
                                    CHECK (diagram_format IN ('mermaid','svg')),
    diagram_source  TEXT            NOT NULL DEFAULT '',
    nodes           JSONB           NOT NULL DEFAULT '[]',
    edges           JSONB           NOT NULL DEFAULT '[]',
    generated_at    TIMESTAMPTZ     NOT NULL DEFAULT now(),
    is_user_edited  BOOLEAN         NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_project_architecture_user_id
    ON project_architecture (user_id);

ALTER TABLE project_architecture ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_project_architecture ON project_architecture;
CREATE POLICY rls_project_architecture ON project_architecture
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON project_architecture TO tucaken_app;

COMMIT;
