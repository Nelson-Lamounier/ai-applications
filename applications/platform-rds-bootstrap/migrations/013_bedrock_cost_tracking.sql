-- =============================================================================
-- Migration 013 — Bedrock per-user cost tracking
--
-- 1. Extend prompt_invocations with import_id and repo_name so resume-import
--    and repo-sync calls can be linked to their source jobs.
-- 2. Add user_token_budgets for per-user monthly soft limits.
-- =============================================================================

-- 1. Extend prompt_invocations
ALTER TABLE prompt_invocations
  ADD COLUMN IF NOT EXISTS import_id UUID REFERENCES resume_imports(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS repo_name TEXT;

CREATE INDEX IF NOT EXISTS idx_prompt_invocations_import_id
  ON prompt_invocations (import_id)
  WHERE import_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prompt_invocations_repo_name
  ON prompt_invocations (repo_name)
  WHERE repo_name IS NOT NULL;

-- Monthly spend lookups: user_id + month.
-- INCLUDE total_cost_cents enables Index-Only Scans on the SUM aggregation.
CREATE INDEX IF NOT EXISTS idx_prompt_invocations_user_month
  ON prompt_invocations (user_id, invoked_at)
  INCLUDE (total_cost_cents);

-- 2. Per-user monthly budget
CREATE TABLE IF NOT EXISTS user_token_budgets (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  monthly_limit_cents  INTEGER  NOT NULL DEFAULT 500,
  alert_threshold_pct  SMALLINT NOT NULL DEFAULT 80,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- Verification
-- =============================================================================
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'prompt_invocations'
--     AND column_name IN ('import_id', 'repo_name');
-- SELECT table_name FROM information_schema.tables
--   WHERE table_name = 'user_token_budgets';
