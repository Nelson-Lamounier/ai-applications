-- =============================================================================
-- Migration 018 — resume_imports 'confirmed' state
--
-- The import pipeline was split: the resume-import Job now stops at
-- 'ready_for_review' and exits. Enrichment + embeddings moved to a separate
-- resume-enrichment Job that admin-api dispatches only after the user reviews
-- and confirms their extracted career history.
--
-- New state machine:
--   awaiting_upload → queued → parsing → extracting_career
--     → ready_for_review            (import Job exits here)
--     → confirmed                   (user confirmed; admin-api sets this and
--                                    dispatches the resume-enrichment Job)
--     → enriching                   (enrichment Job running)
--     → completed | failed
--
-- status is free TEXT (no enum / CHECK constraint), so the new value needs no
-- column change. Only the active-imports partial index is widened so that an
-- import stuck in 'confirmed' (enrichment Job failed to start) is visible to
-- the same monitoring query that surfaces other in-flight states.
-- =============================================================================

DROP INDEX IF EXISTS idx_resume_imports_status_active;

CREATE INDEX idx_resume_imports_status_active
  ON resume_imports (status)
  WHERE status IN ('queued', 'parsing', 'extracting_career', 'confirmed', 'enriching');

-- =============================================================================
-- Verification
-- =============================================================================
-- SELECT indexdef FROM pg_indexes
--   WHERE indexname = 'idx_resume_imports_status_active';
