-- 105_premium_plan_tier.sql
-- Add the 'premium' subscription tier.
--   1. Widen the users.plan CHECK constraint to allow 'premium'.
--   2. effective_plan is app-computed only (CASE in SELECT, not materialised) - no view/column redefinition needed.
-- Idempotent: guarded so re-running is a no-op. Never edits a historical migration.

DO $$
BEGIN
  -- Drop the existing plan CHECK constraint whatever its generated name.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'users'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%plan%'
      AND pg_get_constraintdef(oid) ILIKE '%free%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%premium%'
  ) THEN
    EXECUTE (
      SELECT 'ALTER TABLE users DROP CONSTRAINT ' || quote_ident(conname)
      FROM pg_constraint
      WHERE conrelid = 'users'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%plan%'
        AND pg_get_constraintdef(oid) ILIKE '%free%'
        AND pg_get_constraintdef(oid) NOT ILIKE '%premium%'
      LIMIT 1
    );
  END IF;
END $$;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_check;

ALTER TABLE users
  ADD CONSTRAINT users_plan_check CHECK (plan IN ('free', 'pro', 'premium'));
