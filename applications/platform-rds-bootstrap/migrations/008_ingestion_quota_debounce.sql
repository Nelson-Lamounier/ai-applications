-- =============================================================================
-- Migration 008 — Ingestion quota debounce column
--
-- Adds last_sync_triggered_at to repo_sync_state so the push webhook handler
-- can enforce a 30-minute cooldown between auto-triggered re-index jobs for
-- the same repo. Prevents K8s Job floods on PR squash merges or force-pushes.
--
-- usage_quotas (migration 007) already tracks monthly per-user counters.
-- The 'ingestion_jobs' feature key is consumed at the application layer —
-- no schema change required there.
-- =============================================================================

ALTER TABLE repo_sync_state
  ADD COLUMN IF NOT EXISTS last_sync_triggered_at TIMESTAMPTZ;

-- Index so the debounce query (WHERE user_id=$1 AND repo_full_name=$2) is fast.
CREATE INDEX IF NOT EXISTS idx_sync_state_triggered
  ON repo_sync_state (user_id, repo_full_name, last_sync_triggered_at DESC)
  WHERE last_sync_triggered_at IS NOT NULL;

-- =============================================================================
-- Verification
-- =============================================================================
-- SELECT repo_full_name, sync_status, last_sync_triggered_at
--   FROM repo_sync_state ORDER BY last_sync_triggered_at DESC NULLS LAST LIMIT 20;
