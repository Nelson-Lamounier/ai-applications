-- 107_tier_config.sql
-- Single-row editable subscription tier configuration (display copy, Stripe
-- price mapping, per-tier entitlements). Read by admin-api; admin-gated write.
-- The CHECK (id = 1) constraint enforces a single canonical row.
CREATE TABLE IF NOT EXISTS tier_config (
  id          SMALLINT     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  config      JSONB        NOT NULL,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_by  UUID         REFERENCES users(id)
);
