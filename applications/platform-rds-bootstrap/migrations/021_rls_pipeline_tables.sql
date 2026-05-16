-- =============================================================================
-- Migration 021 — RLS for the resume-import pipeline tables
--
-- Closes the audit gap: these user-scoped tables had no RLS while every other
-- user table (migrations 003/005/007/014/015) did. Same pattern as 003:
-- ENABLE RLS + an isolation policy keyed on the app.current_user_id GUC.
-- current_setting(...,true) returns NULL when unset → policy false → fail
-- closed (zero rows / blocked write). Superuser/owner still bypass (bootstrap
-- Job, admin analytics paths) — intended.
--
-- Idempotent: ENABLE ROW LEVEL SECURITY is idempotent; policies are wrapped
-- in DROP POLICY IF EXISTS first (same convention as migration 003).
-- =============================================================================

ALTER TABLE resume_imports             ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_career_history        ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience_embeddings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_invocations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE resume_import_corrections  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS resume_imports_isolation            ON resume_imports;
CREATE POLICY resume_imports_isolation ON resume_imports
  USING      (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS user_career_history_isolation       ON user_career_history;
CREATE POLICY user_career_history_isolation ON user_career_history
  USING      (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS experience_embeddings_isolation     ON experience_embeddings;
CREATE POLICY experience_embeddings_isolation ON experience_embeddings
  USING      (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

-- NOTE: also written by article/strategist/ingestion Jobs — those callers use
-- the owner connection and bypass RLS. Safe while they remain superuser-routed.
DROP POLICY IF EXISTS prompt_invocations_isolation        ON prompt_invocations;
CREATE POLICY prompt_invocations_isolation ON prompt_invocations
  USING      (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS resume_import_corrections_isolation ON resume_import_corrections;
CREATE POLICY resume_import_corrections_isolation ON resume_import_corrections
  USING      (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

-- =============================================================================
-- Verification
-- =============================================================================
-- SELECT relname, relrowsecurity FROM pg_class
--   WHERE relname IN ('resume_imports','user_career_history',
--     'experience_embeddings','prompt_invocations','resume_import_corrections');
-- SELECT polname, tablename FROM pg_policies WHERE policyname LIKE '%_isolation';
