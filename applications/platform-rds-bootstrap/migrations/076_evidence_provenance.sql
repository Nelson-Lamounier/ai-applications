-- =============================================================================
-- 076_evidence_provenance.sql
-- =============================================================================
-- Evidence Provenance & Data-Quality strategy, Phase 1 (docs/evidence-provenance-strategy.md).
--
-- Append-only trace of what the research/coach agents RETRIEVED and USED from the
-- ingested repository KB, per pipeline run. One row per (run, retrieved passage):
-- where it came from (repo/file), its retrieval quality (cosine/rerank/floor), and
-- whether it was cited into a verified/partial match or demoted by a deterministic
-- guard (vendor-provenance / code-truth drift). Makes "what did each agent use from
-- which repo/file, and was it correct" a cross-run SQL query instead of a 92 KB JSONB
-- blob — the foundation for tracking + improving ingestion extraction.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS. gen_random_uuid() is the PG13+
-- built-in already used throughout (no pgcrypto needed).
-- =============================================================================

CREATE TABLE IF NOT EXISTS evidence_provenance (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline_run_id   UUID NOT NULL,
    user_id           UUID NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- JD scope (trend evidence usage by role/company)
    target_role       TEXT,
    target_company    TEXT,
    -- which agent consumed the evidence
    agent             TEXT NOT NULL CHECK (agent IN ('research', 'coach')),
    -- where the evidence came from
    repo_full_name    TEXT NOT NULL,
    file_path         TEXT NOT NULL,
    -- retrieval quality
    cosine            REAL,
    rerank            REAL,
    passed_floor      BOOLEAN,
    -- how the evidence was used downstream
    usage_status      TEXT NOT NULL
        CHECK (usage_status IN ('retrieved', 'cited_verified', 'cited_partial', 'demoted')),
    -- when demoted, which deterministic guard fired
    demotion_reason   TEXT
        CHECK (demotion_reason IN ('vendor_provenance', 'code_truth'))
);

-- Trend + drill-down access paths.
CREATE INDEX IF NOT EXISTS idx_evidence_provenance_user_time   ON evidence_provenance (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_provenance_run         ON evidence_provenance (pipeline_run_id);
CREATE INDEX IF NOT EXISTS idx_evidence_provenance_repo        ON evidence_provenance (repo_full_name);
CREATE INDEX IF NOT EXISTS idx_evidence_provenance_usage       ON evidence_provenance (usage_status);
