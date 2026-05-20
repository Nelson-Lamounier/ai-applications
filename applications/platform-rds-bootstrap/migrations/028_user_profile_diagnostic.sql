-- 028_user_profile_diagnostic.sql
-- SP5: adds Diagnostic (composite Resume-Readiness score + sub-scores +
-- blockers + best-effort LLM explanation) output onto the existing one-row-
-- per-user user_profile_rollup table. Nullable; same table/PK/RLS as
-- 024–027 (no policy change). Idempotent — bootstrap re-runs every .sql
-- each deploy.

ALTER TABLE user_profile_rollup
    ADD COLUMN IF NOT EXISTS diagnostic JSONB;
