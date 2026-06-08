-- =============================================================================
-- Migration 070 — repo_sync_state.last_sync_type
--
-- Records how the most recent ingestion classified the run so the dashboard can
-- show which repos were an initial sync vs a full re-index vs an incremental
-- (push-based) delta. Written by run-ingestion.ts after the repo is marked
-- 'complete'. Pairs with the ingestion_runs_total{sync_type} Prometheus label
-- for the fleet view.
-- =============================================================================

ALTER TABLE repo_sync_state
  ADD COLUMN IF NOT EXISTS last_sync_type TEXT;   -- 'initial' | 'full_reindex' | 'incremental'

-- =============================================================================
-- Verification
--   SELECT repo_full_name, last_sync_type, last_synced_at
--     FROM repo_sync_state ORDER BY last_synced_at DESC NULLS LAST LIMIT 20;
-- =============================================================================
