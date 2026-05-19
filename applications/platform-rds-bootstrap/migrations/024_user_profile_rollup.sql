-- 024_user_profile_rollup.sql
-- Per-user aggregate over repository_profiles (SP0 — Profile Aggregation
-- Foundation). One row per user, refreshed best-effort at the end of each
-- ingestion job. Headline aggregates use only classification='project',
-- NOT is_hidden, extraction_status='completed' — applied in
-- computeUserProfileRollup (shared), not in SQL.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS; ENABLE ROW LEVEL SECURITY is
-- idempotent; policy wrapped in DROP POLICY IF EXISTS first (same convention
-- as migrations 003 / 021). Safe to re-run on every bootstrap.

CREATE TABLE IF NOT EXISTS user_profile_rollup (
    user_id             UUID         PRIMARY KEY
                                     REFERENCES users(id) ON DELETE CASCADE,
    project_repo_count  INTEGER      NOT NULL DEFAULT 0,
    total_repo_count    INTEGER      NOT NULL DEFAULT 0,
    methodology_version INTEGER      NOT NULL DEFAULT 1,
    rollup              JSONB        NOT NULL DEFAULT '{}',
    refreshed_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE user_profile_rollup ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_user_profile_rollup ON user_profile_rollup;
CREATE POLICY rls_user_profile_rollup ON user_profile_rollup
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
