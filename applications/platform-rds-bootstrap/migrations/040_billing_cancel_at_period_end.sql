-- =============================================================================
-- Migration 025 — Cancel-at-period-end fields on users
--
-- Adds the two columns the dashboard needs to render the "Cancels on YYYY-MM-DD"
-- banner without making a synchronous call to Stripe:
--
--   cancel_at_period_end  — TRUE once the user has clicked "Cancel" but the
--                          subscription is still active until the period ends.
--                          Reverts to FALSE if they reactivate before then.
--   current_period_end    — the cliff date. Populated from every
--                          `customer.subscription.updated` webhook event.
--                          When `customer.subscription.deleted` fires we set
--                          plan='free' and clear both columns.
--
-- Idempotent: every statement uses IF NOT EXISTS.
-- =============================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS current_period_end   TIMESTAMPTZ;

-- Helpful for scheduled-downgrade audits / reports — small B-tree, only
-- non-null rows indexed.
CREATE INDEX IF NOT EXISTS idx_users_current_period_end
  ON users (current_period_end)
  WHERE current_period_end IS NOT NULL;

COMMENT ON COLUMN users.cancel_at_period_end IS
  'TRUE when subscription is set to cancel at period end. Cleared on reactivate or after Stripe transitions the user to free.';
COMMENT ON COLUMN users.current_period_end   IS
  'End of the current Stripe billing period. Used by the billing UI to show "Cancels on…" / "Renews on…".';
