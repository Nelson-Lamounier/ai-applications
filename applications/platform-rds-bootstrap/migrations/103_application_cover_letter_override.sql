-- 103_application_cover_letter_override.sql -- per-application cover-letter override. Idempotent.
--
-- The tailored cover letter is immutable pipeline output (pipeline_runs.metadata.analysis.coverLetter).
-- To let a user edit it without mutating pipeline provenance, store an override JSON on the
-- application; the detail read prefers the override when non-null. Shape matches the CoverLetter
-- type { greeting, paragraphs[], signoff{name,email,linkedin,github} }. Default 'null' = no override.
--
-- No new RLS policy: job_applications already enforces owner-scoped RLS, and writes go through the
-- same withUser(...) role/current_user_id context as status/annotation updates.

BEGIN;

ALTER TABLE job_applications
  ADD COLUMN IF NOT EXISTS cover_letter_override JSONB NOT NULL DEFAULT 'null'::jsonb;

COMMIT;
