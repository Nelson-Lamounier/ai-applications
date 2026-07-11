-- 114_portfolio_owner_fn.sql -- RLS-safe owner lookup for app roles. Idempotent.
--
-- The users table has RLS: each role sees only its own row via
-- `id = current_setting('app.current_user_id')` (migration 003). The chatbot
-- Lambdas run as the RLS-subject `tucaken_app` role and cannot read the owner
-- row directly — chicken-and-egg: they don't know the owner id to set the
-- context. This SECURITY DEFINER function runs as its owner (the privileged
-- migration role, which bypasses RLS) and returns ONLY the single, non-sensitive
-- portfolio-owner id (migration 113). So app roles resolve the owner without
-- weakening user isolation, and without a per-service PORTFOLIO_OWNER_USER_ID env.

BEGIN;

CREATE OR REPLACE FUNCTION portfolio_owner_id()
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
  AS $$ SELECT id FROM users WHERE is_portfolio_owner = true LIMIT 1 $$;

GRANT EXECUTE ON FUNCTION portfolio_owner_id() TO tucaken_app;

COMMIT;
