-- 068_application_user_annotations.sql — per-application user annotations. Idempotent.
--
-- Adds an application-level JSONB column to store user annotations on insight items
-- (e.g. verified/partial matches, skills gaps). Keyed by item id; each item carries its
-- section + label and a list of timestamped notes. Application-level (not per-stage) so the
-- Notes tab can render a single breakdown across sections, and to avoid the full-replace
-- clobber that two concurrent interview_stages.user_state writers would cause.
--
-- No RLS policy is added here: job_applications already enforces owner-scoped RLS, and
-- annotations are written through the same withUser(...) role/current_user_id context as the
-- existing status/stage updates. Default '{}' keeps older rows valid.

BEGIN;

ALTER TABLE job_applications
  ADD COLUMN IF NOT EXISTS user_annotations JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
