-- =============================================================================
-- Migration 012 — resume_imports: add updated_at column
--
-- Migration 010 created resume_imports without an updated_at column.
-- The resume-import-processor calls updateImportStatus() which sets
-- updated_at = NOW() on every state transition; without the column the
-- Job failed with a PIPELINE_ERROR (column does not exist).
--
-- Applied live on 2026-05-03 via kubectl exec into pgbouncer:
--   ALTER TABLE resume_imports ADD COLUMN updated_at TIMESTAMPTZ;
--   UPDATE resume_imports SET updated_at = created_at WHERE updated_at IS NULL;
--
-- This migration codifies the live fix so fresh environments pick it up.
-- Both statements are idempotent.
-- =============================================================================

ALTER TABLE resume_imports
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE resume_imports
  SET updated_at = created_at
  WHERE updated_at IS NULL;
