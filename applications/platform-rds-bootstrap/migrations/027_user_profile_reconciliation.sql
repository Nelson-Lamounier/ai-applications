-- 027_user_profile_reconciliation.sql
-- SP4: adds Reconciliation (bidirectional résumé↔GitHub credibility gap
-- analysis) synthesis output onto the existing one-row-per-user
-- user_profile_rollup table. Nullable; same table/PK/RLS as 024–026 (no
-- policy change). Idempotent — bootstrap re-runs every .sql each deploy.

ALTER TABLE user_profile_rollup
    ADD COLUMN IF NOT EXISTS reconciliation JSONB;
