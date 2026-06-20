-- 098_repo_contributors.sql
--
-- Structured contributor storage (WS2 of the profile-LLM hardening). Ingestion
-- already collects commits + PRs (045) from its single GitHub scan; this adds the
-- repo's contributor roster (login + commit-contribution count) so role_inferred
-- can be computed deterministically and a collaboration / team-size signal exists
-- — instead of the LLM guessing the user's role from a 30-commit snapshot.
--
-- Idempotent: IF NOT EXISTS everywhere; the bootstrap runner re-applies every
-- .sql on each boot. UNIQUE (repository_id, login) makes resync an upsert.

BEGIN;

CREATE TABLE IF NOT EXISTS repo_contributors (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repository_id  UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    repo_full_name TEXT NOT NULL,
    login          TEXT NOT NULL,
    contributions  INTEGER NOT NULL DEFAULT 0,
    github_repo_id BIGINT,
    fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (repository_id, login)
);

CREATE INDEX IF NOT EXISTS idx_repo_contributors_lookup
    ON repo_contributors (user_id, repo_full_name, contributions DESC);

ALTER TABLE repo_contributors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_repo_contributors ON repo_contributors;
CREATE POLICY rls_repo_contributors ON repo_contributors
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON repo_contributors TO tucaken_app;

COMMIT;
