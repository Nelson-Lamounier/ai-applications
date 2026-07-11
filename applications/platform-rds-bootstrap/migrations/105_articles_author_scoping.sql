-- =============================================================================
-- Migration 105 — Article ownership hardening (author_id NOT NULL + RLS)
--
-- Context: the admin-api article read/mutation paths were not owner-scoped, so
-- any admin-group user could see/edit another user's articles (including
-- in-progress pipeline placeholders, which the client surfaced as bell
-- notifications). The application-level fix scopes every query by
-- `author_id = current user` (admin-api/src/routes/articles.ts). This migration
-- is the defence-in-depth layer: it forbids owner-less rows and adds RLS keyed
-- on author_id, matching the pattern established in migration 021.
--
-- !!! DO NOT APPLY UNTIL THE PUBLIC-API DB ROLE IS VERIFIED !!!
-- The `articles` table is ALSO read by the public-api service for the public
-- portfolio (status='published' AND destinations @> {portfolio}). RLS with a
-- fail-closed policy returns ZERO rows to any connection that does not set the
-- `app.current_user_id` GUC. That is only safe if public-api connects as the
-- table owner / a BYPASSRLS role (as the bootstrap Job and admin analytics do).
-- If public-api uses a plain role, enabling RLS here will BREAK public article
-- serving. Verify the live public-api DB role first; if it is not owner/
-- BYPASSRLS, either route public reads through the owner role or REMOVE the
-- RLS section below and keep only the NOT NULL + index hardening.
--
-- Idempotent: SET NOT NULL / ENABLE RLS are idempotent; the policy is wrapped
-- in DROP POLICY IF EXISTS; the index uses IF NOT EXISTS.
-- =============================================================================

-- Speeds up the new owner-scoped reads (WHERE author_id = $1).
CREATE INDEX IF NOT EXISTS idx_articles_author_id ON articles (author_id);

-- -----------------------------------------------------------------------------
-- Owner-less rows are now illegal. Fail LOUD if any exist rather than guessing
-- an owner — a human must backfill (assign to the true author) or delete them
-- before this migration can complete. Owner-less rows are already invisible via
-- the application-level owner filter, so this only formalises the invariant.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  orphan_count integer;
BEGIN
  SELECT COUNT(*) INTO orphan_count FROM articles WHERE author_id IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'Cannot set articles.author_id NOT NULL: % row(s) have a NULL author_id. Backfill or delete them first.',
      orphan_count;
  END IF;
END $$;

ALTER TABLE articles ALTER COLUMN author_id SET NOT NULL;

-- -----------------------------------------------------------------------------
-- RLS — see the DO-NOT-APPLY warning above. current_setting(...,true) returns
-- NULL when the GUC is unset → policy false → fail closed (zero rows / blocked
-- write). Superuser/owner connections (bootstrap Job, admin analytics, and —
-- REQUIRED — public-api) bypass RLS.
-- -----------------------------------------------------------------------------
ALTER TABLE articles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS articles_isolation ON articles;
CREATE POLICY articles_isolation ON articles
  USING      (author_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (author_id = current_setting('app.current_user_id', true)::uuid);

-- =============================================================================
-- Verification
-- =============================================================================
-- SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'articles';
-- SELECT polname, tablename FROM pg_policies WHERE policyname = 'articles_isolation';
-- SELECT COUNT(*) FROM articles WHERE author_id IS NULL;  -- expect 0
