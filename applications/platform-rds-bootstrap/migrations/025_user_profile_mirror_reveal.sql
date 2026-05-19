-- 025_user_profile_mirror_reveal.sql
-- SP2: adds Mirror (identity paragraph) + Reveal (inferences) synthesis output
-- onto the existing one-row-per-user user_profile_rollup table. All nullable;
-- same table/PK/RLS as 024 (no policy change). Idempotent — bootstrap re-runs
-- every .sql each deploy.

ALTER TABLE user_profile_rollup
    ADD COLUMN IF NOT EXISTS mirror                 JSONB,
    ADD COLUMN IF NOT EXISTS reveal                 JSONB,
    ADD COLUMN IF NOT EXISTS synthesis_refreshed_at TIMESTAMPTZ;
