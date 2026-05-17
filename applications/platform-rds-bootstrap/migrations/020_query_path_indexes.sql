-- =============================================================================
-- Migration 020 — Indexes for admin-api hot query paths
--
-- Closes five index gaps found in the production-deployment audit. Each
-- index matches a query the admin-api runs per request; without them these
-- are sequential scans that worsen linearly as the tables grow.
--
-- Idempotent: every statement uses CREATE INDEX IF NOT EXISTS. Plain (not
-- CONCURRENT) builds to match the runner's single-transaction execution
-- model and the rest of this migration set; current table sizes make the
-- brief ACCESS EXCLUSIVE lock acceptable.
-- =============================================================================

-- 1. Resume → application lookups.
--    GET /applications/:slug joins the latest resume by application; the
--    only existing index is the partial one-active-per-user unique index.
CREATE INDEX IF NOT EXISTS idx_resumes_user_job_app
  ON resumes (user_id, job_application_id)
  WHERE job_application_id IS NOT NULL;

-- 2. Strategist run lookup.
--    admin-api: WHERE pipeline_type='strategist' AND reference_id=$1
--               AND status='complete' ORDER BY created_at DESC LIMIT 1
--    reference_id leads (high-selectivity equality); created_at DESC lets
--    the LIMIT 1 be served from the index without a sort.
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_reference
  ON pipeline_runs (reference_id, pipeline_type, status, created_at DESC);

-- 3. Application list ordering.
--    Lists are RLS-scoped to the user then `ORDER BY created_at DESC LIMIT n`.
--    Existing idx_job_apps_user is (user_id, kanban_status) — no help for
--    the sort. This composite serves the ordered, user-scoped scan.
CREATE INDEX IF NOT EXISTS idx_job_apps_user_created
  ON job_applications (user_id, created_at DESC);

-- 4. Coaching content FK.
--    coaching_content.job_application_id is a NOT NULL FK with no index;
--    the detail endpoint and cascade deletes both probe it.
CREATE INDEX IF NOT EXISTS idx_coaching_content_job_app
  ON coaching_content (job_application_id);

-- =============================================================================
-- Verification
-- =============================================================================
-- SELECT indexname, indexdef FROM pg_indexes
--   WHERE indexname IN (
--     'idx_resumes_user_job_app',
--     'idx_pipeline_runs_reference',
--     'idx_job_apps_user_created',
--     'idx_coaching_content_job_app'
--   );
