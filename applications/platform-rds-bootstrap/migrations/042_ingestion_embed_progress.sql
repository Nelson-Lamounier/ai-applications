-- =============================================================================
-- Migration 042 — Ingestion embed progress
--
-- Adds intra-repo embedding progress to repo_sync_state so the onboarding UI
-- can show real movement (embedded / total) while a repo is 'syncing', instead
-- of sitting at 0% until the whole repo flips to 'complete'.
--
-- Both nullable: rows that pre-date this migration, or runs that never reach
-- the embed phase, simply have NULL (UI falls back to the binary 0/100 view).
--
-- Idempotent: every statement uses IF NOT EXISTS.
-- =============================================================================

ALTER TABLE repo_sync_state
    ADD COLUMN IF NOT EXISTS embedded_count INTEGER,
    ADD COLUMN IF NOT EXISTS embed_total    INTEGER;
