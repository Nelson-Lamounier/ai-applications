-- =============================================================================
-- Migration 003 — Cognito user provisioning + schema integrity fixes
--
-- Run order: after 001 (initial DDL) and 002 (if any).
-- Idempotent: all statements use IF NOT EXISTS / IF EXISTS guards or are
-- wrapped in DO blocks that check pg_catalog before acting.
--
-- Changes:
--   1. users           — add cognito_sub TEXT UNIQUE for Cognito identity link
--   2. document_embeddings — fix user_id TEXT → UUID, add FK + referential integrity
--   3. repo_sync_state     — fix user_id TEXT → UUID, add FK + referential integrity
--   4. Create tucaken_app role (low-privilege, no table ownership)
--   5. Enable Row-Level Security on all user-scoped tables
--   6. Create isolation policies (requires app.current_user_id session variable)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. users — Cognito identity column
-- -----------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN IF NOT EXISTS cognito_sub TEXT;

-- Unique index (deferred so existing NULL rows don't conflict with each other)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_cognito_sub
  ON users (cognito_sub)
  WHERE cognito_sub IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. document_embeddings — fix user_id TEXT → UUID
--
-- IMPORTANT: This cast will fail if any existing user_id values are not valid
-- UUID strings. Verify first:
--   SELECT user_id FROM document_embeddings WHERE user_id !~ '^[0-9a-f-]{36}$';
-- If rows exist with non-UUID values, truncate or migrate them before running.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  -- Only run the cast if the column is still TEXT
  IF (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'document_embeddings' AND column_name = 'user_id'
  ) = 'text' THEN

    -- Drop the natural-key unique index (references user_id, must be dropped before type change)
    DROP INDEX IF EXISTS idx_embeddings_natural_key;

    -- Cast TEXT → UUID
    ALTER TABLE document_embeddings
      ALTER COLUMN user_id TYPE UUID USING user_id::uuid;

    -- Restore the unique index with the UUID column
    CREATE UNIQUE INDEX idx_embeddings_natural_key
      ON document_embeddings (user_id, repo_full_name, file_path, chunk_index);

    -- Add FK — ON DELETE CASCADE so embeddings are cleaned up with the user
    ALTER TABLE document_embeddings
      ADD CONSTRAINT fk_embeddings_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

    RAISE NOTICE 'document_embeddings.user_id converted TEXT → UUID';
  ELSE
    RAISE NOTICE 'document_embeddings.user_id already UUID — skipping';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 3. repo_sync_state — fix user_id TEXT → UUID
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'repo_sync_state' AND column_name = 'user_id'
  ) = 'text' THEN

    -- Drop composite PK (includes user_id)
    ALTER TABLE repo_sync_state DROP CONSTRAINT IF EXISTS repo_sync_state_pkey;

    -- Cast TEXT → UUID
    ALTER TABLE repo_sync_state
      ALTER COLUMN user_id TYPE UUID USING user_id::uuid;

    -- Restore composite PK
    ALTER TABLE repo_sync_state
      ADD PRIMARY KEY (user_id, repo_full_name);

    -- Add FK — ON DELETE CASCADE so sync state is cleaned up with the user
    ALTER TABLE repo_sync_state
      ADD CONSTRAINT fk_sync_state_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

    RAISE NOTICE 'repo_sync_state.user_id converted TEXT → UUID';
  ELSE
    RAISE NOTICE 'repo_sync_state.user_id already UUID — skipping';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 4. tucaken_app role — low-privilege application user
--
-- The admin-api pod connects as this role (not as the superuser/owner).
-- Grants are idempotent — safe to re-run after new tables are added.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tucaken_app') THEN
    -- Password intentionally omitted here — set it separately:
    --   ALTER ROLE tucaken_app WITH PASSWORD '<from-secrets-manager>';
    CREATE ROLE tucaken_app WITH LOGIN NOINHERIT NOCREATEDB NOCREATEROLE;
    RAISE NOTICE 'Role tucaken_app created';
  ELSE
    RAISE NOTICE 'Role tucaken_app already exists — skipping CREATE';
  END IF;
END
$$;

-- Grant DML on existing tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tucaken_app;
-- Grant DML on any future tables created by the owner
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tucaken_app;
-- Grant sequence usage (needed for gen_random_uuid() default columns)
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO tucaken_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO tucaken_app;

-- -----------------------------------------------------------------------------
-- 5. Row-Level Security — enable on all user-scoped tables
--
-- RLS is enforced by the database engine regardless of application logic.
-- Non-user-scoped tables (articles, app_config) are excluded — public content.
-- -----------------------------------------------------------------------------

ALTER TABLE users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_connections   ENABLE ROW LEVEL SECURITY;
ALTER TABLE repositories        ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE repo_sync_state     ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_applications    ENABLE ROW LEVEL SECURITY;
ALTER TABLE resumes             ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_stages    ENABLE ROW LEVEL SECURITY;
ALTER TABLE coaching_content    ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_runs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys            ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_audit_log ENABLE ROW LEVEL SECURITY;

-- Superuser/table-owner bypasses RLS by default — keep it that way for
-- bootstrap jobs and migrations. The tucaken_app role does NOT bypass.

-- -----------------------------------------------------------------------------
-- 6. RLS policies — user isolation via session variable
--
-- The application sets: SET LOCAL app.current_user_id = '<users.id UUID>'
-- at the start of every transaction (see withUser() in admin-api/src/lib/pg.ts).
--
-- current_setting('app.current_user_id', true) returns NULL (not an error)
-- when the variable is not set — the USING clause then evaluates to false,
-- blocking all rows. This is the safe default.
-- -----------------------------------------------------------------------------

-- Helper: extract the current user's UUID from the session variable
-- Returns NULL if not set (policy blocks the row)

-- users — each user sees only their own profile row
DROP POLICY IF EXISTS users_isolation           ON users;
CREATE POLICY users_isolation ON users
  USING      (id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (id = current_setting('app.current_user_id', true)::uuid);

-- oauth_connections
DROP POLICY IF EXISTS oauth_connections_isolation ON oauth_connections;
CREATE POLICY oauth_connections_isolation ON oauth_connections
  USING      (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

-- repositories
DROP POLICY IF EXISTS repositories_isolation ON repositories;
CREATE POLICY repositories_isolation ON repositories
  USING      (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

-- document_embeddings
DROP POLICY IF EXISTS document_embeddings_isolation ON document_embeddings;
CREATE POLICY document_embeddings_isolation ON document_embeddings
  USING      (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

-- repo_sync_state
DROP POLICY IF EXISTS repo_sync_state_isolation ON repo_sync_state;
CREATE POLICY repo_sync_state_isolation ON repo_sync_state
  USING      (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

-- job_applications
DROP POLICY IF EXISTS job_applications_isolation ON job_applications;
CREATE POLICY job_applications_isolation ON job_applications
  USING      (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

-- resumes
DROP POLICY IF EXISTS resumes_isolation ON resumes;
CREATE POLICY resumes_isolation ON resumes
  USING      (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

-- interview_stages — scoped via job_application FK (not direct user_id)
DROP POLICY IF EXISTS interview_stages_isolation ON interview_stages;
CREATE POLICY interview_stages_isolation ON interview_stages
  USING (
    job_application_id IN (
      SELECT id FROM job_applications
       WHERE user_id = current_setting('app.current_user_id', true)::uuid
    )
  )
  WITH CHECK (
    job_application_id IN (
      SELECT id FROM job_applications
       WHERE user_id = current_setting('app.current_user_id', true)::uuid
    )
  );

-- coaching_content — same pattern as interview_stages
DROP POLICY IF EXISTS coaching_content_isolation ON coaching_content;
CREATE POLICY coaching_content_isolation ON coaching_content
  USING (
    job_application_id IN (
      SELECT id FROM job_applications
       WHERE user_id = current_setting('app.current_user_id', true)::uuid
    )
  )
  WITH CHECK (
    job_application_id IN (
      SELECT id FROM job_applications
       WHERE user_id = current_setting('app.current_user_id', true)::uuid
    )
  );

-- pipeline_runs
DROP POLICY IF EXISTS pipeline_runs_isolation ON pipeline_runs;
CREATE POLICY pipeline_runs_isolation ON pipeline_runs
  USING      (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

-- api_keys
DROP POLICY IF EXISTS api_keys_isolation ON api_keys;
CREATE POLICY api_keys_isolation ON api_keys
  USING      (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

-- ingestion_audit_log
DROP POLICY IF EXISTS ingestion_audit_log_isolation ON ingestion_audit_log;
CREATE POLICY ingestion_audit_log_isolation ON ingestion_audit_log
  USING      (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

-- =============================================================================
-- Post-migration verification queries (run manually to confirm)
-- =============================================================================
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_name IN ('document_embeddings','repo_sync_state')
--    AND column_name = 'user_id';
--
-- SELECT tablename, rowsecurity FROM pg_tables
--  WHERE schemaname = 'public' AND tablename NOT IN ('articles','app_config');
--
-- SELECT schemaname, tablename, policyname FROM pg_policies ORDER BY tablename;
