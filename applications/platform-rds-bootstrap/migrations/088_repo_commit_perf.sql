-- 088_repo_commit_perf.sql
--
-- Measured performance metrics tied to a commit SHA — the ONLY honest source of
-- a "% faster/slower" figure. A CI benchmark step (or manual entry) records a
-- metric value at a SHA; the application computes the percentage change between
-- two SHAs' values deterministically. No value here, no percentage emitted.
--
-- This is what makes the grounded change-impact narration safe: the LLM may
-- narrate these measured numbers but can never invent one (see
-- docs/superpowers/specs/2026-06-17-commit-diff-grounded-impact.md).
--
-- Idempotent: IF NOT EXISTS; UNIQUE makes re-ingest an upsert. RLS-protected on
-- app.current_user_id, mirroring repo_commits (045) / repo_commit_files (087).

BEGIN;

CREATE TABLE IF NOT EXISTS repo_commit_perf (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repository_id  UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    repo_full_name TEXT NOT NULL,
    github_repo_id BIGINT,
    commit_sha     TEXT NOT NULL,
    -- e.g. 'p95_latency_ms', 'throughput_rps', 'bundle_kb', 'cold_start_ms'
    metric_name    TEXT NOT NULL,
    value          NUMERIC NOT NULL,
    unit           TEXT NOT NULL,
    -- provenance of the measurement — never an LLM. e.g. 'ci-benchmark', 'manual'
    source         TEXT NOT NULL,
    measured_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (repository_id, commit_sha, metric_name)
);

CREATE INDEX IF NOT EXISTS idx_repo_commit_perf_lookup
    ON repo_commit_perf (user_id, repo_full_name, commit_sha);

ALTER TABLE repo_commit_perf ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_repo_commit_perf ON repo_commit_perf;
CREATE POLICY rls_repo_commit_perf ON repo_commit_perf
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON repo_commit_perf TO tucaken_app;

COMMIT;
