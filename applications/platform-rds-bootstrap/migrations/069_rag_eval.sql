-- =============================================================================
-- Migration 069 — RAG evaluation results
--
-- Persists golden-set RAG eval runs so quality is queryable + historical
-- (Grafana panels: last run, score trend, per-query relevance/recall, negative-
-- control leakage). Written by run-rag-eval.ts (RAG_EVAL_PERSIST=1); the
-- DeepEval / RAGAS / Bedrock-Evaluations harnesses write summary rows under their
-- own `tool` value. Fleet-level eval data — no user_id, no RLS.
-- =============================================================================

-- One row per evaluation run.
CREATE TABLE IF NOT EXISTS rag_eval_runs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Which harness produced this run.
  tool                     TEXT NOT NULL,            -- 'ts-native' | 'deepeval' | 'ragas' | 'bedrock'
  dataset_version          INTEGER,                  -- golden.json version
  generate_answers         BOOLEAN NOT NULL DEFAULT false,
  k                        INTEGER,                  -- retrieval top-k
  min_cosine               DOUBLE PRECISION,         -- cosine floor used

  -- Aggregate scores (mirror RagEvalReport).
  query_count              INTEGER NOT NULL DEFAULT 0,
  positive_count           INTEGER NOT NULL DEFAULT 0,
  negative_count           INTEGER NOT NULL DEFAULT 0,
  mean_recall_at_k         DOUBLE PRECISION,         -- null if no expectations
  mean_relevance_positive  DOUBLE PRECISION,         -- higher = better
  mean_relevance_negative  DOUBLE PRECISION,         -- lower = better (leakage)
  mean_max_cosine          DOUBLE PRECISION,

  notes                    TEXT
);

CREATE INDEX IF NOT EXISTS idx_rag_eval_runs_run_at
  ON rag_eval_runs (run_at DESC);
CREATE INDEX IF NOT EXISTS idx_rag_eval_runs_tool
  ON rag_eval_runs (tool, run_at DESC);

-- One row per golden query within a run (mirror QueryEvalResult).
CREATE TABLE IF NOT EXISTS rag_eval_results (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              UUID NOT NULL REFERENCES rag_eval_runs(id) ON DELETE CASCADE,

  query_id            TEXT NOT NULL,
  kind                TEXT NOT NULL,                 -- 'positive' | 'negative'
  recall_at_k         DOUBLE PRECISION,              -- null when no expected sources
  context_relevance   DOUBLE PRECISION NOT NULL DEFAULT 0,
  retrieved_count     INTEGER NOT NULL DEFAULT 0,
  max_cosine          DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_rag_eval_results_run
  ON rag_eval_results (run_id);

-- =============================================================================
-- Verification
--   SELECT table_name FROM information_schema.tables
--     WHERE table_schema='public' AND table_name IN ('rag_eval_runs','rag_eval_results');
-- =============================================================================
