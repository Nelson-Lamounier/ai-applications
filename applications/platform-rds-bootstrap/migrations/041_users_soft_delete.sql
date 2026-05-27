-- =============================================================================
-- Migration 026 — Soft-delete (account termination) on users
--
-- Implements the 30-day grace deletion model:
--
--   deleted_at        — NULL  ⇒ active account.
--                     — value ⇒ user clicked "Delete account" at that time.
--                              All admin-api routes return 410 Gone after
--                              this is set; Cognito user is also disabled so
--                              re-login is impossible.
--   deletion_reason   — optional free-text the user provided in the confirm
--                              form (analytics / churn analysis).
--
-- A daily sweep job (see scripts/account-sweep.ts) finds rows where
--   deleted_at < NOW() - INTERVAL '30 days'
-- and hard-deletes them: DELETE FROM users (children CASCADE),
-- AdminDeleteUser on Cognito, optionally delete Stripe customer + S3 objects.
--
-- During the grace window users can restore by emailing support — a small
-- internal tool (out of scope here) clears deleted_at and re-enables Cognito.
--
-- Idempotent: every statement uses IF NOT EXISTS.
-- =============================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deletion_reason TEXT;

-- Sweep job lookup: only deleted rows are interesting, keep the index tiny.
CREATE INDEX IF NOT EXISTS idx_users_deleted_at
  ON users (deleted_at)
  WHERE deleted_at IS NOT NULL;

COMMENT ON COLUMN users.deleted_at      IS
  'Set when the user clicks "Delete account". 410 Gone returned by admin-api for any further request. Hard-deleted by the daily sweep after 30 days.';
COMMENT ON COLUMN users.deletion_reason IS
  'Free-text reason captured at deletion time. Used for churn analytics; not displayed back to the user.';
