-- 029_oauth_token_envelope.sql
-- Adds envelope-encryption columns + revoked_at/suspended_at to oauth_connections.
-- Plaintext access_token_enc is kept for the transition window; the drop
-- migration lives at sql/manual/030_oauth_token_drop_plain.sql and is applied
-- by hand AFTER the backfill verifies count = 0 and after a manual RDS
-- snapshot. The auto-run bootstrap re-runs every .sql file on every deploy,
-- so every statement here is idempotent.

ALTER TABLE oauth_connections
    ADD COLUMN IF NOT EXISTS access_token_ciphertext BYTEA,
    ADD COLUMN IF NOT EXISTS access_token_dek        BYTEA,
    ADD COLUMN IF NOT EXISTS access_token_iv         BYTEA,
    ADD COLUMN IF NOT EXISTS access_token_tag        BYTEA,
    ADD COLUMN IF NOT EXISTS revoked_at              TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS suspended_at            TIMESTAMPTZ;
