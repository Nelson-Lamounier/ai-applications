-- =============================================================================
-- Migration 007 — Reverse trial + plan model
--
-- Design: 14-day reverse trial. New users start with full Pro access; on Day 14
-- the effective plan drops to free unless they have an active Stripe subscription.
--
-- Effective plan derivation (no cron needed):
--   - plan = 'pro' AND subscription_status = 'active'  → Pro (paid)
--   - plan = 'free' AND trial_ends_at > NOW()           → Trial (still active)
--   - plan = 'free' AND trial_ends_at <= NOW()          → Free (trial expired)
--   - plan = 'free' AND trial_ends_at IS NULL           → Free (no trial, e.g. admin)
--
-- Tables added:
--   plan_events    — immutable audit log of every plan transition
--   trial_nudges   — deduplicates Day 7 / Day 12 in-app nudge delivery
--   usage_quotas   — monthly per-user usage counts for free tier enforcement
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Trial + Stripe columns on users
-- -----------------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS plan                   TEXT        NOT NULL DEFAULT 'free'
    CHECK (plan IN ('free', 'pro')),
  ADD COLUMN IF NOT EXISTS trial_started_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_ends_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_customer_id      TEXT        UNIQUE,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id  TEXT        UNIQUE,
  ADD COLUMN IF NOT EXISTS subscription_status     TEXT
    CHECK (subscription_status IN ('active', 'past_due', 'canceled', 'unpaid', NULL));

-- Index for webhook lookups (Stripe → our user)
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer
  ON users (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_stripe_subscription
  ON users (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- Index for expiry sweeps (background analytics / nudge delivery)
CREATE INDEX IF NOT EXISTS idx_users_trial_ends_at
  ON users (trial_ends_at)
  WHERE trial_ends_at IS NOT NULL AND plan = 'free';

-- -----------------------------------------------------------------------------
-- 2. plan_events — immutable audit trail
--
-- Every plan transition (trial start, Stripe upgrade, cancellation, downgrade)
-- is recorded here. Never UPDATE or DELETE rows in this table.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS plan_events (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type   TEXT        NOT NULL,   -- 'trial_started' | 'upgraded' | 'canceled' | 'expired' | 'reactivated'
  from_plan    TEXT,                   -- previous plan value
  to_plan      TEXT,                   -- new plan value
  stripe_event TEXT,                   -- Stripe webhook event id, if applicable
  reason       TEXT,                   -- human-readable note (e.g. 'stripe_webhook', 'admin_override')
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plan_events_user_id
  ON plan_events (user_id, created_at DESC);

ALTER TABLE plan_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plan_events_isolation ON plan_events;
CREATE POLICY plan_events_isolation ON plan_events
  USING      (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

GRANT SELECT, INSERT ON plan_events TO tucaken_app;

-- -----------------------------------------------------------------------------
-- 3. trial_nudges — prevents duplicate nudge delivery
--
-- When the application wants to show a Day 7 or Day 12 nudge, it inserts a row
-- here (ON CONFLICT DO NOTHING). If the insert succeeds → first delivery.
-- If it conflicts → already delivered, skip.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS trial_nudges (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nudge_day    INTEGER     NOT NULL CHECK (nudge_day IN (7, 12)),
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, nudge_day)
);

CREATE INDEX IF NOT EXISTS idx_trial_nudges_user_id
  ON trial_nudges (user_id);

ALTER TABLE trial_nudges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trial_nudges_isolation ON trial_nudges;
CREATE POLICY trial_nudges_isolation ON trial_nudges
  USING      (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

GRANT SELECT, INSERT ON trial_nudges TO tucaken_app;

-- -----------------------------------------------------------------------------
-- 4. usage_quotas — monthly per-user counters for free tier enforcement
--
-- One row per (user × month × feature). The application increments the counter
-- on each usage and checks it against the free tier limit before allowing the
-- action. Reset is implicit: a new month means a new row.
--
-- Free tier limits (enforced in application code, not DB constraints):
--   'resume_generations'  — 3 per month
--   'job_applications'    — 10 per month
--   'coach_runs'          — 5 per month
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS usage_quotas (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature      TEXT        NOT NULL,   -- 'resume_generations' | 'job_applications' | 'coach_runs'
  period_month DATE        NOT NULL,   -- first day of the month: DATE_TRUNC('month', NOW())
  count        INTEGER     NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, feature, period_month)
);

CREATE INDEX IF NOT EXISTS idx_usage_quotas_user_feature
  ON usage_quotas (user_id, feature, period_month DESC);

ALTER TABLE usage_quotas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS usage_quotas_isolation ON usage_quotas;
CREATE POLICY usage_quotas_isolation ON usage_quotas
  USING      (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON usage_quotas TO tucaken_app;

-- =============================================================================
-- Verification
-- =============================================================================
-- SELECT id, email, plan, trial_started_at, trial_ends_at, subscription_status
--   FROM users ORDER BY created_at DESC LIMIT 10;
--
-- SELECT * FROM plan_events ORDER BY created_at DESC LIMIT 20;
--
-- -- Effective plan for all users:
-- SELECT
--   id, email, plan,
--   CASE
--     WHEN plan = 'pro' AND subscription_status = 'active' THEN 'pro'
--     WHEN plan = 'free' AND trial_ends_at > NOW()          THEN 'trial'
--     ELSE 'free'
--   END AS effective_plan,
--   trial_ends_at
-- FROM users ORDER BY created_at DESC;
