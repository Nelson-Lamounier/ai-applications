-- =============================================================================
-- 082_prompt_invocations_attribution.sql
-- =============================================================================
-- Granular Bedrock cost attribution: per job application, per project, and
-- per repo-sync kind (initial vs resync).
--
-- The admin Cost tab aggregates prompt_invocations spend. Until now a row could
-- only be attributed to a user, pipeline, model, import (resume_imports), and
-- repo_name. There was no way to answer "what did THIS job application cost" or
-- "what did THIS project's case study cost", and repo-sync rows could not say
-- whether the spend came from an initial ingest or a resync.
--
-- This adds three nullable columns the workers populate where the id is in scope:
--   application_id — set by the job-strategist pipeline (env.applicationId)
--   project_id     — set by the project-case-study pipeline (env.projectId)
--   sync_kind      — set by repo-sync rows: 'initial' | 'full_reindex' |
--                    'incremental' (the syncType run-ingestion already computes)
--
-- All additive + idempotent. Existing rows stay NULL (no backfill) — historical
-- spend simply has no application/project/sync attribution, which the Cost tab
-- surfaces as an "Unattributed" bucket. FK uses ON DELETE SET NULL so deleting a
-- job application or project never deletes its audit-trail cost rows.
-- =============================================================================

ALTER TABLE prompt_invocations
  ADD COLUMN IF NOT EXISTS application_id UUID REFERENCES job_applications(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS project_id     UUID REFERENCES projects(id)         ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sync_kind      TEXT;

-- Per-application / per-project cost roll-ups: id + month window.
-- INCLUDE total_cost_cents enables Index-Only Scans on the SUM aggregation.
CREATE INDEX IF NOT EXISTS idx_prompt_invocations_application
  ON prompt_invocations (application_id, invoked_at)
  INCLUDE (total_cost_cents)
  WHERE application_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prompt_invocations_project
  ON prompt_invocations (project_id, invoked_at)
  INCLUDE (total_cost_cents)
  WHERE project_id IS NOT NULL;

-- repo-sync initial-vs-resync split: repo_name + sync_kind within a month.
CREATE INDEX IF NOT EXISTS idx_prompt_invocations_sync_kind
  ON prompt_invocations (repo_name, sync_kind, invoked_at)
  WHERE sync_kind IS NOT NULL;

-- =============================================================================
-- Verification
-- =============================================================================
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'prompt_invocations'
--     AND column_name IN ('application_id', 'project_id', 'sync_kind');
