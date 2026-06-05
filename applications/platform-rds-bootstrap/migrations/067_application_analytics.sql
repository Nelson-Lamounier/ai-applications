-- 067_application_analytics.sql — per-stage outcome + feedback capture. Idempotent.
--
-- Conventions (verified against existing RLS tables 064_story_candidates / 054_dsa_evidence /
-- 034_technology_graph): owner-scoped RLS uses user_id UUID REFERENCES users(id), the
-- current_setting('app.current_user_id', true)::uuid cast, and BOTH USING + WITH CHECK.
-- gen_random_uuid() is the pgvector/PG13+ built-in already used throughout (no pgcrypto
-- extension declared anywhere — see bootstrap.ts job_applications). job_applications.id is UUID,
-- so the FK type matches. interview_stages already has an `outcome TEXT` column (bootstrap.ts) —
-- the ADD COLUMN IF NOT EXISTS below is a harmless no-op kept for idempotent self-documentation.

BEGIN;

ALTER TABLE interview_stages
  ADD COLUMN IF NOT EXISTS outcome          TEXT,
  ADD COLUMN IF NOT EXISTS outcome_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS application_stage_feedback (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_application_id        UUID NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stage_type                TEXT NOT NULL,
  user_category             TEXT,
  user_note                 TEXT,
  company_feedback          TEXT,
  company_feedback_verbatim BOOLEAN NOT NULL DEFAULT false,
  prep_self_rating          SMALLINT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS asf_app_stage_uniq ON application_stage_feedback (job_application_id, stage_type);
CREATE INDEX IF NOT EXISTS asf_user_idx ON application_stage_feedback (user_id);

ALTER TABLE application_stage_feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS asf_owner ON application_stage_feedback;
CREATE POLICY asf_owner ON application_stage_feedback
  USING      (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

COMMIT;
