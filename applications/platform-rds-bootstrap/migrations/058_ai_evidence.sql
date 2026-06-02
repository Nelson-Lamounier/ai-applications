-- 058_ai_evidence.sql — dedicated, RLS-isolated lane for real-work AI-engineering practice evidence.
-- Standalone: FK to ai_topics(canonical_name) only. Never enters technology_ontology /
-- technology_evidence (lane-ownership: tech-extract owns "uses X"; ai_evidence owns "built X capability").
-- Mirrors 054_dsa_evidence RLS. Idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS ai_evidence (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_full_name TEXT NOT NULL,
  commit_sha     TEXT NOT NULL,
  ai_topic       TEXT NOT NULL REFERENCES ai_topics(canonical_name),
  signal         TEXT NOT NULL,        -- which detector fired: prompt_caching | mcp_integration | grounding | eval_harness | cost_engineering
  raw_name       TEXT NOT NULL,        -- matched token, e.g. 'cachePoint'
  file_path      TEXT NOT NULL,
  line_start     INT NOT NULL,         -- always 1-indexed; NOT NULL so the uq_ index dedup holds (NULL != NULL in PG)
  confidence     REAL NOT NULL,        -- per-signal 0.70-0.80
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_evidence_user_repo ON ai_evidence (user_id, repo_full_name);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_evidence
  ON ai_evidence (user_id, repo_full_name, commit_sha, ai_topic, file_path, line_start);

ALTER TABLE ai_evidence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_evidence_user_isolation ON ai_evidence;
CREATE POLICY ai_evidence_user_isolation ON ai_evidence
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

COMMIT;
