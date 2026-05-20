-- 027_oauth_token_envelope.sql
-- Adds envelope-encryption columns + revoked_at/suspended_at to oauth_connections.
-- Plaintext access_token_enc is kept for the transition window; dropped by 028
-- after backfill verification.

BEGIN;

ALTER TABLE oauth_connections
    ADD COLUMN access_token_ciphertext BYTEA,
    ADD COLUMN access_token_dek        BYTEA,
    ADD COLUMN access_token_iv         BYTEA,
    ADD COLUMN access_token_tag        BYTEA,
    ADD COLUMN revoked_at              TIMESTAMPTZ,
    ADD COLUMN suspended_at            TIMESTAMPTZ;

COMMIT;
