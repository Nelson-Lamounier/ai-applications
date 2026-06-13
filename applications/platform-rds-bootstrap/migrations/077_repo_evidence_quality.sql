-- =============================================================================
-- 077_repo_evidence_quality.sql
-- =============================================================================
-- Evidence Provenance & Data-Quality strategy, Phase 2 (docs/evidence-provenance-strategy.md).
--
-- Per-run, per-repo rollup of how well each ingested repo's extracted data served
-- the JD — the standing signal for deciding what ingestion to improve. Built from
-- the Phase-1 evidence_provenance trace + the code-derived tech inventory:
--   * cite_rate        — cited / retrieved (low = noisy ingestion, lots of dead KB)
--   * demoted_count    — passages demoted by a deterministic guard (drift / mis-attribution)
--   * code_tech_count  — distinct deterministic-layer technologies extracted (extraction richness)
--
-- One row per (pipeline_run_id, repo_full_name). Idempotent DDL; upsert on the
-- natural key so re-processing a run overwrites rather than duplicates.
-- =============================================================================

CREATE TABLE IF NOT EXISTS repo_evidence_quality (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline_run_id    UUID NOT NULL,
    user_id            UUID NOT NULL,
    repo_full_name     TEXT NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    target_role        TEXT,
    -- provenance-derived (this run)
    passages_retrieved INTEGER NOT NULL DEFAULT 0,
    passages_cited     INTEGER NOT NULL DEFAULT 0,
    demoted_count      INTEGER NOT NULL DEFAULT 0,
    cite_rate          REAL    NOT NULL DEFAULT 0,
    -- code-extraction richness (latest commit, deterministic layers)
    code_tech_count    INTEGER NOT NULL DEFAULT 0,
    UNIQUE (pipeline_run_id, repo_full_name)
);

CREATE INDEX IF NOT EXISTS idx_repo_evidence_quality_repo_time ON repo_evidence_quality (repo_full_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repo_evidence_quality_user_time ON repo_evidence_quality (user_id, created_at DESC);
