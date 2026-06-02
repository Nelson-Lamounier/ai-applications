-- 059_ai_scanned_commits.sql — idempotency marker for the AI extraction pass.
-- Records that run-tech-extract completed the AI pass for a (user, repo, commit),
-- INDEPENDENT of whether any ai_evidence rows were found. Without this, repos with
-- zero AI-practice artifacts (the majority) would be re-downloaded + re-scanned on every re-sync.
-- match_count is informational (0 = scanned, found nothing). RLS per user, mirrors 055.
-- Idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS ai_scanned_commits (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_full_name TEXT NOT NULL,
  commit_sha     TEXT NOT NULL,
  match_count    INT  NOT NULL DEFAULT 0,
  scanned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, repo_full_name, commit_sha)
);

ALTER TABLE ai_scanned_commits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_scanned_commits_user_isolation ON ai_scanned_commits;
CREATE POLICY ai_scanned_commits_user_isolation ON ai_scanned_commits
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

COMMIT;
