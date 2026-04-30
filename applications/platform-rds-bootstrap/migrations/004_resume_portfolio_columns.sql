-- =============================================================================
-- Migration 004 — Resume portfolio columns + decoupling from application lifecycle
--
-- Promotes is_active and label from content_json JSONB blobs into proper
-- first-class columns so they can be indexed, queried, and enforced at the
-- database level.
--
-- Changes:
--   1. resumes — add is_active BOOLEAN column, partial unique index
--   2. resumes — add label TEXT column
--   3. resumes — migrate existing is_active / label values out of content_json
--   4. resumes — clean up migrated keys from content_json
--
-- After migration, routes/resumes.ts creates resumes with a real user_id and
-- any AI-generated tailored resume can be promoted to the active portfolio CV.
-- Deleting a job application sets job_application_id = NULL (ON DELETE SET NULL
-- already in DDL) — the resume survives.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. is_active column
-- -----------------------------------------------------------------------------

ALTER TABLE resumes ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT FALSE;

-- Migrate existing JSONB boolean into the new column
UPDATE resumes
   SET is_active = TRUE
 WHERE (content_json->>'is_active')::boolean IS TRUE
   AND is_active = FALSE;

-- Partial unique index: at most one active resume per user.
-- Enforces the invariant atomically — no application-level race conditions.
CREATE UNIQUE INDEX IF NOT EXISTS idx_resumes_one_active_per_user
  ON resumes (user_id)
  WHERE is_active = TRUE;

-- -----------------------------------------------------------------------------
-- 2. label column
-- -----------------------------------------------------------------------------

ALTER TABLE resumes ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT '';

-- Migrate existing JSONB label into the new column
UPDATE resumes
   SET label = content_json->>'label'
 WHERE content_json->>'label' IS NOT NULL
   AND label = '';

-- -----------------------------------------------------------------------------
-- 3. Strip migrated keys from content_json to avoid double source-of-truth
--
-- Removes is_active and label keys from all content_json blobs.
-- jsonb - 'key' returns the blob with that key removed (non-destructive if key absent).
-- -----------------------------------------------------------------------------

UPDATE resumes
   SET content_json = content_json - 'is_active' - 'label'
 WHERE content_json ? 'is_active'
    OR content_json ? 'label';

-- =============================================================================
-- Verification (run manually to confirm)
-- =============================================================================
-- SELECT id, label, is_active, job_application_id, user_id FROM resumes ORDER BY generated_at DESC;
-- SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'resumes';
