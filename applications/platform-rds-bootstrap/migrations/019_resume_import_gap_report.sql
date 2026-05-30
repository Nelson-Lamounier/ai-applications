-- =============================================================================
-- Migration 019 — resume_imports gap-analysis report
--
-- Phase 1 (the import Job) now produces a user-facing gap-analysis report:
-- per-role covered vs missing responsibilities, suggested additions, ATS
-- keywords, skills gap and narrative feedback. It is written once, before
-- the import transitions to 'ready_for_review'.
--
-- gap_report is nullable: gap analysis failure is non-fatal — the review
-- screen must work without it. gap_report_generated_at is the artifact-ready
-- signal the admin-api progress endpoint exposes (gapReportReady) so the
-- frontend can fetch the report exactly once instead of polling for it.
-- =============================================================================

ALTER TABLE resume_imports
  ADD COLUMN IF NOT EXISTS gap_report              JSONB,
  ADD COLUMN IF NOT EXISTS gap_report_generated_at TIMESTAMPTZ;

-- =============================================================================
-- Verification
-- =============================================================================
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'resume_imports'
--     AND column_name IN ('gap_report', 'gap_report_generated_at');
