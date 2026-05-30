-- 044_enable_project_features.sql
--
-- Enable the projects clustering + case-study feature gates. The clustering
-- and case-study K8s Jobs (job-strategist/src/run-clustering.ts,
-- run-case-study.ts) read these app_config keys at startup via
-- isFeatureEnabled() and silently skip when the key is absent or disabled.
-- Without this seed they no-op even when dispatched.
--
-- Idempotent: ON CONFLICT DO UPDATE, matching the bootstrap runner's
-- re-apply-every-.sql-each-boot model (no schema_migrations table).

BEGIN;

INSERT INTO app_config (key, value) VALUES
  ('projects.clustering.enabled', '{"enabled": true}'::jsonb),
  ('projects.case_study.enabled', '{"enabled": true}'::jsonb)
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value, updated_at = NOW();

COMMIT;
