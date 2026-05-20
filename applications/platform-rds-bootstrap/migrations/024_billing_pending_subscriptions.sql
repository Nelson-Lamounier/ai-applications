-- =============================================================================
-- Migration 024 — Pending subscriptions (guest-checkout race buffer)
--
-- Stripe Embedded Checkout supports guest payments (no authenticated user at
-- checkout time). The `checkout.session.completed` webhook then arrives before
-- the user has signed up, so we cannot write `stripe_customer_id` directly to
-- `users` yet.
--
-- Strategy:
--   1. Webhook receives guest session → INSERT INTO pending_subscriptions.
--   2. User completes sign-up → admin-api's user-provision middleware does
--      JOIN pending_subscriptions ON email = NEW.email; if a row exists,
--      stamp stripe_customer_id + stripe_subscription_id + plan onto users,
--      then DELETE the pending row.
--
-- Email is normalised to lower-case at insert and unique — the same buyer
-- email cannot have two pending rows (later sessions overwrite).
--
-- Idempotent: every statement uses IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS pending_subscriptions (
    email                   TEXT        NOT NULL PRIMARY KEY,
    stripe_customer_id      TEXT        NOT NULL,
    stripe_subscription_id  TEXT        NOT NULL,
    plan                    TEXT        NOT NULL
        CHECK (plan IN ('pro', 'premium')),
    subscription_status     TEXT        NOT NULL DEFAULT 'active'
        CHECK (subscription_status IN ('active', 'trialing', 'past_due', 'unpaid')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One row per customer is enough; if the webhook re-fires for the same
    -- customer (e.g. customer.subscription.updated before signup) we update
    -- in place via INSERT … ON CONFLICT DO UPDATE.
    UNIQUE (stripe_customer_id)
);

COMMENT ON TABLE pending_subscriptions IS
  'Holds Stripe subscriptions for guest checkouts until the buyer signs up. '
  'Drained by user-provision middleware on first authenticated request.';

-- Lookup index for the signup-time JOIN. Email is already PRIMARY KEY so
-- the implicit B-tree index covers the equality lookup; no extra index.

-- Housekeeping: rows older than 30 days suggest the buyer never signed up.
-- A scheduled job (not provided here) can:
--   DELETE FROM pending_subscriptions WHERE created_at < NOW() - INTERVAL '30 days';
-- and refund the Stripe subscription via the API. Defer until product
-- direction is decided.
