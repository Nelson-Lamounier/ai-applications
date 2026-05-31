-- 048_repo_file_state.sql
--
-- Per-file git blob-SHA state for incremental resync. listFiles already returns
-- the blob SHA per file (git tree API); persisting it lets resync fetch only
-- files whose blob SHA changed, instead of re-fetching every file. The
-- last_synced_commit_sha watermark on repo_sync_state is the cheap "anything
-- changed at all" gate. Per-user RLS (this is the user's repo tree). Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS repo_file_state (
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repo_full_name TEXT NOT NULL,
    file_path      TEXT NOT NULL,
    blob_sha       TEXT NOT NULL,
    size_bytes     INTEGER NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, repo_full_name, file_path)
);

CREATE INDEX IF NOT EXISTS idx_repo_file_state_repo
    ON repo_file_state (user_id, repo_full_name);

ALTER TABLE repo_file_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_repo_file_state ON repo_file_state;
CREATE POLICY rls_repo_file_state ON repo_file_state
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON repo_file_state TO tucaken_app;

ALTER TABLE repo_sync_state
    ADD COLUMN IF NOT EXISTS last_synced_commit_sha TEXT;

COMMIT;
