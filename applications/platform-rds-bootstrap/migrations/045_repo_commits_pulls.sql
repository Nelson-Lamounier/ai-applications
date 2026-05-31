-- 045_repo_commits_pulls.sql
--
-- Structured per-commit and per-PR storage so case-study generation can read
-- commit/PR evidence from the DB instead of re-fetching from GitHub. Ingestion
-- (and sync/resync) is the single GitHub scan; these tables are the source of
-- truth, and the existing weekly commit prose-chunks in document_embeddings are
-- derived from the same fetch.
--
-- Idempotent: IF NOT EXISTS everywhere; the bootstrap runner re-applies every
-- .sql on each boot. UNIQUE keys make resync an upsert (no dupes).

BEGIN;

CREATE TABLE IF NOT EXISTS repo_commits (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repository_id  UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    repo_full_name TEXT NOT NULL,
    sha            TEXT NOT NULL,
    author_name    TEXT NOT NULL,
    author_login   TEXT,
    authored_at    TIMESTAMPTZ NOT NULL,
    message        TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (repository_id, sha)
);

CREATE INDEX IF NOT EXISTS idx_repo_commits_lookup
    ON repo_commits (user_id, repo_full_name, authored_at DESC);

ALTER TABLE repo_commits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_repo_commits ON repo_commits;
CREATE POLICY rls_repo_commits ON repo_commits
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON repo_commits TO tucaken_app;

CREATE TABLE IF NOT EXISTS repo_pull_requests (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repository_id  UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    repo_full_name TEXT NOT NULL,
    number         INTEGER NOT NULL,
    title          TEXT NOT NULL,
    body           TEXT,
    state          TEXT NOT NULL
                   CHECK (state IN ('open', 'closed', 'merged')),
    author_login   TEXT,
    created_at_gh  TIMESTAMPTZ NOT NULL,
    merged_at      TIMESTAMPTZ,
    html_url       TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (repository_id, number)
);

CREATE INDEX IF NOT EXISTS idx_repo_pulls_lookup
    ON repo_pull_requests (user_id, repo_full_name, merged_at DESC NULLS LAST);

ALTER TABLE repo_pull_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_repo_pull_requests ON repo_pull_requests;
CREATE POLICY rls_repo_pull_requests ON repo_pull_requests
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON repo_pull_requests TO tucaken_app;

COMMIT;
