-- 113_users_is_portfolio_owner.sql -- single portfolio owner as data, not env. Idempotent.
--
-- Replaces the PORTFOLIO_OWNER_USER_ID env-per-service with a DB flag, so the
-- owner identity lives in one place. Services resolve the owner via
-- SELECT id FROM users WHERE is_portfolio_owner. The chatbot is single-tenant:
-- the public chatbot serves ONLY this user's embeddings, so the flag is
-- security-relevant — the partial unique index guarantees AT MOST ONE owner, so
-- a bad write can never redirect the public chatbot to another user's data.
--
-- Backfill: the current owner (1d4c645a) — the same id the chatbot Lambdas and
-- admin-api settings route already used via env.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_portfolio_owner BOOLEAN NOT NULL DEFAULT false;

-- At most one owner, enforced by the DB (partial unique index on the true rows).
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_single_portfolio_owner
  ON users (is_portfolio_owner)
  WHERE is_portfolio_owner;

UPDATE users
   SET is_portfolio_owner = true, updated_at = NOW()
 WHERE id = '1d4c645a-447e-4b5b-924d-19a3c75a84db'
   AND is_portfolio_owner = false;

COMMIT;
