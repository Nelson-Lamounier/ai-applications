-- 064_story_candidates.sql — S8: artifact-anchored story-mining lane.
-- Candidate DevOps/AI interview stories mined deterministically from repo_commits /
-- repo_pull_requests with a TWO-ARTIFACT honesty bar (git revert = revert+original commit;
-- merged PR = structured issue close + quantified metric). NO LLM, NO keyword-only matches.
-- RLS per user (mirrors 045 repo_commits). No explicit GRANT — default privileges cover
-- tucaken_app (verified). Idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS story_candidates (
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_full_name TEXT        NOT NULL,
  story_type     TEXT        NOT NULL,   -- 'incident' | 'optimization'
  anchor_key     TEXT        NOT NULL,   -- dedup key (revert sha / pr number)
  anchors        JSONB       NOT NULL,   -- the two corroborating artifacts
  confidence     REAL        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, repo_full_name, story_type, anchor_key)
);

CREATE INDEX IF NOT EXISTS idx_story_candidates_user_repo ON story_candidates (user_id, repo_full_name);

ALTER TABLE story_candidates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_story_candidates ON story_candidates;
CREATE POLICY rls_story_candidates ON story_candidates
  USING      (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

COMMIT;
