-- =============================================================================
-- 083_retrieval_probe_history.sql
-- =============================================================================
-- Append-only history of the ingestion retrieval probe.
--
-- repo_sync_state.retrieval_score / retrieval_breakdown hold only the LATEST
-- probe result — every sync overwrites them, so there is no way to compare a
-- repo's retrieval quality across syncs (e.g. pure-vector vs hybrid, before vs
-- after a chunking change). This table records one row per probe run so quality
-- is longitudinal: each sync appends, nothing is lost.
--
-- retrieval_mode distinguishes the retrieval strategy in force at probe time
-- ('vector' | 'hybrid'), so a same-repo A/B is recoverable from history rather
-- than requiring a side-by-side eval run.
--
-- Mirrors repo_evidence_quality (077): plain user-scoped analytics table, no RLS
-- (written by the ingestion worker via the owner role; read by admin surfaces).
-- =============================================================================

CREATE TABLE IF NOT EXISTS retrieval_probe_history (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repo_full_name      TEXT NOT NULL,
    probed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    sync_type           TEXT,          -- initial | full_reindex | incremental
    retrieval_mode      TEXT,          -- vector | hybrid (strategy at probe time)
    sampled             INTEGER,
    recall_at_3         NUMERIC(4,3),
    mrr                 NUMERIC(4,3),
    mean_top_similarity NUMERIC(5,4),
    score               NUMERIC(4,3),
    breakdown           JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_retrieval_probe_history_repo_time
    ON retrieval_probe_history (user_id, repo_full_name, probed_at DESC);
