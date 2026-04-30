-- =============================================================================
-- Migration 005 — Multi-provider identity model
--
-- Problem: users.cognito_sub (single TEXT UNIQUE) can only link one Cognito
-- identity per user. Google, GitHub, and email/password each produce a
-- different Cognito sub — the same person using two providers crashes with a
-- duplicate-email constraint violation.
--
-- Solution: extract identity anchoring into a dedicated user_identities table.
-- Each row maps one Cognito sub (one provider sign-in) to a users.id. A single
-- user can have many identity rows (Google + GitHub + email/password).
--
-- Changes:
--   1. users — add auth_provider TEXT (tracks initial signup method for display)
--   2. user_identities — new join table replacing cognito_sub on users
--   3. Migrate existing cognito_sub rows into user_identities
--   4. Drop cognito_sub column and its unique index from users
--   5. RLS policy on user_identities
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. users — record how the account was first created (display only)
-- -----------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT;

-- -----------------------------------------------------------------------------
-- 2. user_identities — one row per (user × provider) pair
--
-- cognito_sub  — Cognito's stable `sub` claim. For federated users this is
--                still a UUID (Cognito issues its own sub regardless of
--                provider); the provider field captures which IdP was used.
-- provider     — 'google' | 'github' | 'email' — matches the Cognito identity
--                provider name lowercased.
-- provider_user_id — the external provider's own user ID (Google UID,
--                GitHub numeric ID). NULL for native email/password users.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_identities (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cognito_sub      TEXT        NOT NULL,
  provider         TEXT        NOT NULL,
  provider_user_id TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cognito_sub),
  UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_user_identities_user_id
  ON user_identities (user_id);

-- -----------------------------------------------------------------------------
-- 3. Migrate existing cognito_sub values from users → user_identities
--
-- We don't know the original provider for existing rows, so we infer from
-- the sub format:
--   Google_*   → 'google'
--   GitHub_*   → 'github'
--   anything else → 'email' (native Cognito UUID)
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'users' AND column_name = 'cognito_sub'
  ) THEN
    INSERT INTO user_identities (user_id, cognito_sub, provider, created_at)
    SELECT
      id,
      cognito_sub,
      CASE
        WHEN cognito_sub ILIKE 'Google_%'  THEN 'google'
        WHEN cognito_sub ILIKE 'GitHub_%'  THEN 'github'
        ELSE 'email'
      END,
      created_at
    FROM users
    WHERE cognito_sub IS NOT NULL
    ON CONFLICT (cognito_sub) DO NOTHING;

    -- Back-fill auth_provider from inferred provider
    UPDATE users u
       SET auth_provider = ui.provider
      FROM user_identities ui
     WHERE ui.user_id = u.id
       AND u.auth_provider IS NULL;

    RAISE NOTICE 'Migrated % cognito_sub rows to user_identities',
      (SELECT count(*) FROM user_identities);
  ELSE
    RAISE NOTICE 'cognito_sub column not found — skipping migration';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 4. Drop cognito_sub from users
--
-- user_identities is now the single source of truth for sub → user mapping.
-- The unique index on cognito_sub is dropped automatically with the column.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'users' AND column_name = 'cognito_sub'
  ) THEN
    DROP INDEX IF EXISTS idx_users_cognito_sub;
    ALTER TABLE users DROP COLUMN cognito_sub;
    RAISE NOTICE 'Dropped users.cognito_sub';
  ELSE
    RAISE NOTICE 'users.cognito_sub already dropped — skipping';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 5. RLS — user_identities is user-scoped
-- -----------------------------------------------------------------------------

ALTER TABLE user_identities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_identities_isolation ON user_identities;
CREATE POLICY user_identities_isolation ON user_identities
  USING      (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

-- Grant tucaken_app access to the new table
GRANT SELECT, INSERT, UPDATE, DELETE ON user_identities TO tucaken_app;

-- =============================================================================
-- Verification
-- =============================================================================
-- SELECT u.email, u.auth_provider, ui.provider, ui.cognito_sub
--   FROM users u JOIN user_identities ui ON ui.user_id = u.id
--  ORDER BY u.email;
--
-- SELECT * FROM pg_policies WHERE tablename = 'user_identities';
