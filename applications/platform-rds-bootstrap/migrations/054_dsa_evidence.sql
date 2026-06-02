-- 054_dsa_evidence.sql — dedicated, RLS-isolated lane for real-work DSA pattern evidence.
-- Standalone: FK to dsa_topics(canonical_name) only. Never enters technology_ontology /
-- technology_evidence, so skill-graph + KB-quality consumers are unaffected (v1.5 fork, 2026-06-02).
-- Mirrors technology_evidence RLS (034): per-user isolation via app.current_user_id.
-- Idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS dsa_evidence (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_full_name TEXT NOT NULL,
  commit_sha     TEXT NOT NULL,
  dsa_topic      TEXT NOT NULL REFERENCES dsa_topics(canonical_name),
  signal         TEXT NOT NULL,        -- which detector fired: networkx_import | heap | tree_type | memoization | comparator
  raw_name       TEXT NOT NULL,        -- matched token, e.g. 'networkx'
  file_path      TEXT NOT NULL,
  line_start     INT,
  confidence     REAL NOT NULL,        -- per-signal 0.70-0.80
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dsa_evidence_user_repo ON dsa_evidence (user_id, repo_full_name);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dsa_evidence
  ON dsa_evidence (user_id, repo_full_name, commit_sha, dsa_topic, file_path, line_start);

ALTER TABLE dsa_evidence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dsa_evidence_user_isolation ON dsa_evidence;
CREATE POLICY dsa_evidence_user_isolation ON dsa_evidence
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

COMMIT;
