-- =============================================================================
-- 085_github_repo_id_cutover.sql
-- =============================================================================
-- Phase 3 cutover of the GitHub repo-rename re-key. Enforces the immutable
-- github_repo_id anchor on `repositories`. Run ONLY after the PR3 backfill has
-- verified 100% of github rows have a non-null github_repo_id. full_name stays
-- as a denormalised display label. See spec 2026-06-17-github-repo-rename-handling.
--
-- Scope: this migration enforces NOT NULL + unique on `repositories` ONLY (the
-- anchor table). The repo-scoped child tables backfill independently; a stray
-- NULL there must not abort the whole cutover, so they are left untouched here.
--
-- Reversible: drop the unique index, drop NOT NULL.
--
-- NON-DESTRUCTIVE BY DESIGN: this migration adds the canonical anchor key
-- (NOT NULL + unique on github_repo_id) but does NOT drop the legacy
-- `(user_id, provider, full_name)` unique. Both keys coexist so the system is
-- fully testable end-to-end and admin-api's existing
-- `ON CONFLICT (user_id, provider, full_name)` connect path keeps working.
-- The legacy-unique DROP is split into 086_drop_legacy_name_unique.sql, which
-- must be deployed together with / after the admin-api ON CONFLICT flip to
-- (user_id, github_repo_id). See the end-to-end runbook for ordering.
-- =============================================================================

-- Hard guard: refuse to enforce NOT NULL if any github rows are still NULL,
-- so an incomplete backfill aborts the migration loudly instead of failing midway.
-- Only provider='github' is checked — it is the only provider implemented.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM repositories WHERE provider = 'github' AND github_repo_id IS NULL) THEN
    RAISE EXCEPTION 'repositories has github rows with NULL github_repo_id - backfill incomplete; aborting cutover';
  END IF;
END $$;

ALTER TABLE repositories ALTER COLUMN github_repo_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_repositories_user_ghid
    ON repositories (user_id, github_repo_id);
