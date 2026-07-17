-- Migration 122 - unified_parity_runs: per-layer evidence parity for the
-- UNIFIED_INGESTION shadow gate (spec P1). The legacy technology_parity_runs
-- table is decommissioned L1-vs-LLM machinery and cannot express this.
BEGIN;

CREATE TABLE IF NOT EXISTS unified_parity_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL,
    repo_full_name  TEXT NOT NULL,
    commit_sha      TEXT NOT NULL,
    source_layer    TEXT NOT NULL,
    legacy_count    INT  NOT NULL,
    unified_count   INT  NOT NULL,
    intersection_count INT NOT NULL,
    legacy_only_examples  JSONB NOT NULL DEFAULT '[]',
    unified_only_examples JSONB NOT NULL DEFAULT '[]',
    ran_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_unified_parity_runs_repo
    ON unified_parity_runs (user_id, repo_full_name, ran_at DESC);

ALTER TABLE unified_parity_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_unified_parity_runs ON unified_parity_runs;
CREATE POLICY rls_unified_parity_runs ON unified_parity_runs
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON unified_parity_runs TO tucaken_app;

COMMIT;
