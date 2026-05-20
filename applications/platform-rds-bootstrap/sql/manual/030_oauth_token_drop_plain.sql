-- 030_oauth_token_drop_plain.sql
-- MANUAL migration — NOT picked up by the auto-bootstrap runner. Lives under
-- sql/manual/ so a fresh deploy never executes it; the runner only sweeps
-- migrations/.
--
-- Enforces NOT NULL on envelope columns, adds length checks, and drops the
-- plaintext access_token_enc column. Apply ONLY after:
--   1. Migration 029 applied in target env.
--   2. scripts/backfill-oauth-token-envelope.ts run to completion.
--   3. Verification:
--        SELECT COUNT(*) FROM oauth_connections
--        WHERE access_token_enc IS NOT NULL
--          AND access_token_ciphertext IS NULL;
--      -- must be 0
--   4. Manual RDS snapshot taken (rollback path).
--   5. Application no longer relies on the dual-read fallback in
--      RdsOAuthConnectionsRepository.decryptRow (remove that branch first).

BEGIN;

ALTER TABLE oauth_connections
    ALTER COLUMN access_token_ciphertext SET NOT NULL,
    ALTER COLUMN access_token_dek        SET NOT NULL,
    ALTER COLUMN access_token_iv         SET NOT NULL,
    ALTER COLUMN access_token_tag        SET NOT NULL;

ALTER TABLE oauth_connections
    ADD CONSTRAINT oauth_iv_length  CHECK (octet_length(access_token_iv)  = 12),
    ADD CONSTRAINT oauth_tag_length CHECK (octet_length(access_token_tag) = 16);

ALTER TABLE oauth_connections DROP COLUMN access_token_enc;

COMMIT;
