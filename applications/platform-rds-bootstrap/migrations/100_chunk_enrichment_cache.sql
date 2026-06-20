-- 100_chunk_enrichment_cache.sql
--
-- Content-hash enrichment dedup (WS5). Chunk enrichment was the one LLM lane with
-- no skip-unchanged gate: a force-reindex re-enriched every chunk via Haiku even
-- when the content was byte-identical to a prior run (~$3.49/repo, verified live).
-- This cache maps a chunk's content_hash -> its enriched skills, keyed per user +
-- model. Before any Haiku call the enricher looks up the hash; on a hit it copies
-- the cached skills (identical content -> identical skills) instead of re-invoking.
-- Populated as chunks are enriched, so it survives a reindex and makes a re-run of
-- an unchanged repo near-free.
--
-- model_id scopes the entry so a model change re-enriches rather than serving stale
-- skills. Idempotent: CREATE TABLE IF NOT EXISTS. RLS per the project guardrail.

BEGIN;

CREATE TABLE IF NOT EXISTS chunk_enrichment_cache (
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content_hash TEXT        NOT NULL,
    skills       TEXT[]      NOT NULL DEFAULT '{}',
    model_id     TEXT        NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, content_hash)
);

ALTER TABLE chunk_enrichment_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_chunk_enrichment_cache ON chunk_enrichment_cache;
CREATE POLICY rls_chunk_enrichment_cache ON chunk_enrichment_cache
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON chunk_enrichment_cache TO tucaken_app;

COMMIT;
