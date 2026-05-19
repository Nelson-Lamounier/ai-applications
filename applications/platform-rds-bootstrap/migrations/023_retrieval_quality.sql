-- =============================================================================
-- Migration 023 — Retrieval probe results
--
-- Adds retrieval-probe results to repo_sync_state. Mirrors the kb_quality_*
-- columns. Nullable for back-compat with runs that pre-date the retrieval
-- probe or where the probe was skipped/failed (best-effort).
--
-- Idempotent: every statement uses IF NOT EXISTS.
-- =============================================================================

ALTER TABLE repo_sync_state
    ADD COLUMN IF NOT EXISTS retrieval_score     NUMERIC(4,2),
    ADD COLUMN IF NOT EXISTS retrieval_breakdown JSONB;
