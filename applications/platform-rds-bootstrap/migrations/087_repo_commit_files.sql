-- 087_repo_commit_files.sql
--
-- Per-commit change stats + per-file diffs, so "old vs new code" retrieval and
-- grounded change-impact narration become possible. The list-commits endpoint
-- used at ingestion omits stats and file lists; these are filled from the
-- per-commit detail endpoint (/commits/{sha}) for NEW commits (incremental) and
-- on forceReindex (backfill).
--
-- Patch-based, not snapshot-based: we store the unified diff hunk per file, not
-- full prior file content. "Previous state" is reconstructable from the current
-- chunk plus the patch. Patches are size-capped at fetch time; an over-cap or
-- binary file stores stats with patch NULL and patch_truncated = true.
--
-- Idempotent: IF NOT EXISTS everywhere; the bootstrap runner re-applies every
-- .sql on each boot. UNIQUE keys make resync an upsert (no dupes). RLS-protected
-- on app.current_user_id, matching repo_commits (migration 045).

BEGIN;

-- Per-commit aggregate stats (nullable until the detail endpoint is fetched).
ALTER TABLE repo_commits ADD COLUMN IF NOT EXISTS additions        INTEGER;
ALTER TABLE repo_commits ADD COLUMN IF NOT EXISTS deletions        INTEGER;
ALTER TABLE repo_commits ADD COLUMN IF NOT EXISTS files_changed    INTEGER;
ALTER TABLE repo_commits ADD COLUMN IF NOT EXISTS stats_fetched_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS repo_commit_files (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repository_id     UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    repo_full_name    TEXT NOT NULL,
    github_repo_id    BIGINT,
    commit_sha        TEXT NOT NULL,
    file_path         TEXT NOT NULL,
    -- GitHub file status: added|removed|modified|renamed|copied|changed|unchanged
    status            TEXT NOT NULL,
    previous_filename TEXT,
    additions         INTEGER NOT NULL DEFAULT 0,
    deletions         INTEGER NOT NULL DEFAULT 0,
    changes           INTEGER NOT NULL DEFAULT 0,
    patch             TEXT,                       -- unified diff hunk; NULL if capped/binary
    patch_truncated   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (repository_id, commit_sha, file_path)
);

-- "diffs touching file X" — the join path for old-vs-new retrieval.
CREATE INDEX IF NOT EXISTS idx_repo_commit_files_path
    ON repo_commit_files (user_id, repo_full_name, file_path);
-- all files for a given commit.
CREATE INDEX IF NOT EXISTS idx_repo_commit_files_sha
    ON repo_commit_files (repository_id, commit_sha);

ALTER TABLE repo_commit_files ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_repo_commit_files ON repo_commit_files;
CREATE POLICY rls_repo_commit_files ON repo_commit_files
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON repo_commit_files TO tucaken_app;

COMMIT;
