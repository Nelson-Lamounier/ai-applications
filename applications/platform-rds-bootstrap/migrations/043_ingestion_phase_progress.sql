-- =============================================================================
-- Migration 043 — Ingestion phase progress
--
-- Generalises intra-repo progress beyond the embed phase. The onboarding UI
-- previously only moved during embedding; profile-analysis, file-fetch, and
-- enrich (the slow, silent phases) left it stuck at 0%. These columns let the
-- pipeline report the CURRENT phase + a done/total within that phase, so the
-- UI can show a labelled, continuously-advancing progress indicator.
--
--   phase        — 'analyzing' | 'fetching' | 'enriching' | 'embedding' | 'finalizing'
--   phase_done   — items completed in the current phase (NULL when indeterminate)
--   phase_total  — total items in the current phase (NULL when indeterminate)
--
-- Supersedes the embed-only embedded_count/embed_total (migration 042), which
-- are left in place but no longer written. All nullable for back-compat.
--
-- Idempotent: every statement uses IF NOT EXISTS.
-- =============================================================================

ALTER TABLE repo_sync_state
    ADD COLUMN IF NOT EXISTS phase       TEXT,
    ADD COLUMN IF NOT EXISTS phase_done  INTEGER,
    ADD COLUMN IF NOT EXISTS phase_total INTEGER;
