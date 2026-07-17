-- Migration 121 - repo_facts: per-repo materialised fact sheet (spec P0, UC1/UC2)
BEGIN;

CREATE TABLE IF NOT EXISTS repo_facts (
    user_id        UUID NOT NULL,
    repo_full_name TEXT NOT NULL,
    github_repo_id BIGINT,
    role           TEXT NOT NULL CHECK (role IN ('frontend','backend','infra','mobile','data','ml','docs','shared')),
    classification TEXT,
    facts          JSONB NOT NULL,
    fact_version   INT  NOT NULL DEFAULT 1,
    computed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, repo_full_name)
);
CREATE INDEX IF NOT EXISTS idx_repo_facts_role ON repo_facts (user_id, role);

ALTER TABLE repo_facts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_repo_facts ON repo_facts;
CREATE POLICY rls_repo_facts ON repo_facts
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON repo_facts TO tucaken_app;

COMMIT;
