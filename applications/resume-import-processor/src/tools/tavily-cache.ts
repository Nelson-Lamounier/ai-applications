/**
 * @format
 * Postgres-backed cache layer for any WebSearchTool.
 *
 * Role-research queries repeat heavily across users and Tavily bills per
 * search, so non-empty result sets are memoised in the tavily_cache table
 * (migration 017) keyed on a normalised query + maxResults, with a 7-day TTL
 * enforced at read time.
 *
 * Only non-empty results are cached: an empty/failed search may be a transient
 * Tavily issue or an obscure-company miss that a later query-fallback resolves,
 * so caching "no results" would poison recovery.
 *
 * Decorator pattern — wraps an inner WebSearchTool and is itself a
 * WebSearchTool, so callers swap `new TavilySearchTool(key)` for
 * `new CachedSearchTool(new TavilySearchTool(key), pool)` with no other change.
 */
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { PiiScrubber } from '@bedrock/shared';
import type { SearchResult, WebSearchTool } from './tavily.js';

const piiScrubber = new PiiScrubber();

const TTL_DAYS = 7;

/** Lowercase, collapse internal whitespace, trim. Keeps the cache key stable
 *  across cosmetic query differences ("  Senior  Engineer " vs "senior engineer"). */
export function normaliseQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, ' ').trim();
}

function cacheKey(query: string, maxResults: number): string {
  return crypto
    .createHash('sha256')
    .update(`${normaliseQuery(query)}::${maxResults}`)
    .digest('hex');
}

export class CachedSearchTool implements WebSearchTool {
  constructor(
    private readonly inner: WebSearchTool,
    private readonly pool: Pool,
  ) {}

  async search(query: string, maxResults = 5, signal?: AbortSignal): Promise<SearchResult[]> {
    const { tavilyCacheTotal } = await import('../metrics.js');
    const q = piiScrubber.scrub(query).redacted;
    const key = cacheKey(q, maxResults);

    const cached = await this.pool.query<{ results: SearchResult[] }>(
      `SELECT results FROM tavily_cache
        WHERE query_hash = $1
          AND fetched_at > NOW() - ($2 || ' days')::interval`,
      [key, String(TTL_DAYS)],
    );

    if (cached.rows[0]) {
      tavilyCacheTotal().inc({ result: 'hit' });
      // Fire-and-forget hit accounting — must not add latency or fail the search.
      this.pool
        .query(`UPDATE tavily_cache SET hit_count = hit_count + 1 WHERE query_hash = $1`, [key])
        .catch(() => {});
      return cached.rows[0].results;
    }

    tavilyCacheTotal().inc({ result: 'miss' });
    const results = await this.inner.search(q, maxResults, signal);

    // Only cache non-empty result sets. Empty stays uncached so a retry or
    // future query-fallback can recover. UPSERT refreshes a stale row in place.
    if (results.length > 0) {
      await this.pool.query(
        `INSERT INTO tavily_cache (query_hash, query_text, max_results, results, fetched_at, hit_count)
         VALUES ($1, $2, $3, $4::jsonb, NOW(), 0)
         ON CONFLICT (query_hash) DO UPDATE
            SET results    = EXCLUDED.results,
                query_text = EXCLUDED.query_text,
                fetched_at = NOW(),
                hit_count  = 0`,
        [key, normaliseQuery(q), maxResults, JSON.stringify(results)],
      );
    }

    return results;
  }
}
