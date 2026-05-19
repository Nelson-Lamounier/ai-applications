-- 026_user_profile_direction.sql
-- SP3: adds Direction (role-archetype fit + seniority + whatToDeepen) synthesis
-- output onto the existing one-row-per-user user_profile_rollup table.
-- Nullable; same table/PK/RLS as 024/025 (no policy change). Idempotent —
-- bootstrap re-runs every .sql each deploy.

ALTER TABLE user_profile_rollup
    ADD COLUMN IF NOT EXISTS direction JSONB;
