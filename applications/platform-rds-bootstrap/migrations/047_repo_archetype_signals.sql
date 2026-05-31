-- =============================================================================
-- Migration 047 — Repo archetype signals
--
-- Persists the archetype-classification signal set derived from a repository's
-- FULL file tree during ingestion. document_embeddings.file_path only covers
-- the filtered/embedded subset, so path-based signals (has_iac, has_ci,
-- has_notebooks, has_ios_dir, …) cannot be recovered from it. Ingestion has
-- the complete tree in memory (RepoIngestionOrchestrator.listFiles) and writes
-- the derived 46-signal map here; the case-study archetype classifier reads it.
--
--   archetype_signals — JSONB { "<signal_name>": boolean, ... } (the 46-key
--                       vocabulary produced by deriveRepoSignals). NULL until
--                       the repo is (re)synced by ingestion that computes it.
--
-- Nullable for back-compat: an un-resynced repo simply yields no archetype
-- calibration (the classifier degrades to null → today's behavior).
--
-- Idempotent: IF NOT EXISTS.
-- =============================================================================

ALTER TABLE repo_sync_state
    ADD COLUMN IF NOT EXISTS archetype_signals JSONB;
