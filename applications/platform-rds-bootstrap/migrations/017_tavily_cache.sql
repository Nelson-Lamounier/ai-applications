-- =============================================================================
-- Migration 017 — Tavily search result cache
--
-- Role-research queries repeat heavily across users ("Software Engineer at
-- Google responsibilities", "Customer Service Representative ...") and Tavily
-- bills per search. This table memoises non-empty result sets keyed on a
-- normalised query + max_results, with a TTL enforced at read time.
--
-- Only non-empty result sets are cached. Empty/failed searches are NOT stored
-- so that a later run can recover (the empty may have been a transient Tavily
-- issue or an obscure-company miss that a query-fallback later resolves).
--
-- TTL: 7 days, checked in the read query (WHERE fetched_at > NOW() - INTERVAL).
-- Stale rows are overwritten on the next miss for the same key (UPSERT), so no
-- background sweeper is required; an optional janitor can prune by fetched_at.
-- =============================================================================

CREATE TABLE IF NOT EXISTS tavily_cache (
  -- sha256 hex of `${normalisedQuery}::${maxResults}`. PK so the read path is
  -- a single index probe and the write path is an idempotent UPSERT.
  query_hash   TEXT PRIMARY KEY,

  -- The normalised query text, retained for debugging and cache-analytics
  -- ("what are we caching?"). Not used as a lookup key.
  query_text   TEXT NOT NULL,
  max_results  SMALLINT NOT NULL,

  -- Array of { title, url, content, score } objects exactly as returned by
  -- the search tool. JSONB so retrieval is a single column read.
  results      JSONB NOT NULL,

  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hit_count    INTEGER     NOT NULL DEFAULT 0
);

-- Janitor query support: "delete rows older than 7 days".
CREATE INDEX IF NOT EXISTS idx_tavily_cache_fetched_at
  ON tavily_cache (fetched_at);

-- =============================================================================
-- Verification
-- =============================================================================
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'tavily_cache' ORDER BY ordinal_position;
-- SELECT indexname FROM pg_indexes WHERE tablename = 'tavily_cache';
