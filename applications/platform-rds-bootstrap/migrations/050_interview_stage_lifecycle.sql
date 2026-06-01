-- 050_interview_stage_lifecycle.sql
--
-- Intent-tiered stage-prep triggering (Spec 2b). Adds the authoritative
-- current-stage pointer to job_applications, and per-stage lifecycle +
-- user-state + coach-dispatch tracking to the (previously unused) interview_stages
-- table. prep_status is a write-on-dispatch cache; the admin-api reconciles it on
-- read from the coach pipeline_runs + coaching_content.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS.

BEGIN;

-- Authoritative current interview stage for the application.
ALTER TABLE job_applications
  ADD COLUMN IF NOT EXISTS interview_stage TEXT NOT NULL DEFAULT 'applied';

-- Per-stage lifecycle + editable user state + coach dispatch link.
ALTER TABLE interview_stages
  ADD COLUMN IF NOT EXISTS user_state   JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS coach_run_id UUID,
  ADD COLUMN IF NOT EXISTS prep_status  TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS stage_status TEXT NOT NULL DEFAULT 'upcoming';

-- One row per (application, stage) — enables UPSERT on (job_application_id, stage_type).
CREATE UNIQUE INDEX IF NOT EXISTS interview_stages_app_stage_uniq
  ON interview_stages (job_application_id, stage_type);

COMMIT;
