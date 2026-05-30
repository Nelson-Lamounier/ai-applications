-- =============================================================================
-- Migration 022 — Semantic response cache (RAG checklist §9)
--
-- Stores PII-scrubbed query embeddings + cached responses for the query
-- apps (chatbot, job-strategist). Lookups filter by scope + kb_tag (KB
-- version + model id) and a TTL; a reindex or model change strands old
-- rows without deleting them.
--
-- Idempotent: every statement uses IF NOT EXISTS. Plain (not CONCURRENT)
-- builds, matching the runner's single-transaction model and the rest of
-- this migration set.
-- =============================================================================

CREATE TABLE IF NOT EXISTS semantic_cache (
  id              BIGSERIAL PRIMARY KEY,
  scope           TEXT NOT NULL,
  kb_tag          TEXT NOT NULL,
  query_text      TEXT NOT NULL,
  query_embedding vector(1024) NOT NULL,
  response        JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hit_count       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_semantic_cache_hnsw
  ON semantic_cache USING hnsw (query_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_semantic_cache_scope_tag
  ON semantic_cache (scope, kb_tag, created_at);
