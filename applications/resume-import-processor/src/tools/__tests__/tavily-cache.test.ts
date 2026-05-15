import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { CachedSearchTool, normaliseQuery } from '../tavily-cache.js';
import type { SearchResult, WebSearchTool } from '../tavily.js';
import type { Pool } from 'pg';

const SAMPLE: SearchResult[] = [
  { title: 'Role guide', url: 'https://x', content: 'context', score: 0.9 },
];

type QueryImpl = (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;

function makePool(impl: QueryImpl) {
  const query = jest.fn<QueryImpl>().mockImplementation(impl);
  return { pool: { query } as unknown as Pool, query };
}

function makeInner(results: SearchResult[]) {
  const search = jest.fn<() => Promise<SearchResult[]>>().mockResolvedValue(results);
  return { tool: { search } as unknown as WebSearchTool, search };
}

describe('normaliseQuery', () => {
  it('lowercases, collapses whitespace, trims', () => {
    expect(normaliseQuery('  Senior   Engineer  AT Google ')).toBe('senior engineer at google');
  });
});

describe('CachedSearchTool', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns cached results without calling the inner tool on a hit', async () => {
    const { pool, query } = makePool(async (sql) =>
      sql.includes('SELECT results') ? { rows: [{ results: SAMPLE }] } : { rows: [] },
    );
    const { tool: inner, search } = makeInner([]);

    const out = await new CachedSearchTool(inner, pool).search('q', 4);

    expect(out).toEqual(SAMPLE);
    expect(search).not.toHaveBeenCalled();
    // SELECT + fire-and-forget hit_count UPDATE
    const sqls = query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('SELECT results'))).toBe(true);
    expect(sqls.some((s) => s.includes('hit_count = hit_count + 1'))).toBe(true);
  });

  it('calls the inner tool and UPSERTs on a miss with non-empty results', async () => {
    const { pool, query } = makePool(async () => ({ rows: [] }));
    const { tool: inner, search } = makeInner(SAMPLE);

    const out = await new CachedSearchTool(inner, pool).search('Software Engineer', 4);

    expect(out).toEqual(SAMPLE);
    expect(search).toHaveBeenCalledWith('Software Engineer', 4);
    const sqls = query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('INSERT INTO tavily_cache'))).toBe(true);
  });

  it('does NOT cache empty results from the inner tool', async () => {
    const { pool, query } = makePool(async () => ({ rows: [] }));
    const { tool: inner } = makeInner([]);

    const out = await new CachedSearchTool(inner, pool).search('obscure co', 4);

    expect(out).toEqual([]);
    const sqls = query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('INSERT INTO tavily_cache'))).toBe(false);
  });

  it('keys differ by maxResults so a different N is a miss', async () => {
    const seen: string[] = [];
    const { pool } = makePool(async (sql, params) => {
      if (sql.includes('SELECT results')) seen.push(params[0] as string);
      return { rows: [] };
    });
    const { tool: inner } = makeInner(SAMPLE);
    const cache = new CachedSearchTool(inner, pool);

    await cache.search('same query', 4);
    await cache.search('same query', 8);

    expect(seen[0]).not.toEqual(seen[1]); // different sha256 keys
  });

  it('propagates inner tool errors without caching', async () => {
    const { pool, query } = makePool(async () => ({ rows: [] }));
    const search = jest.fn(async () => { throw new Error('tavily 500'); });
    const inner = { search } as unknown as WebSearchTool;

    await expect(new CachedSearchTool(inner, pool).search('q', 4)).rejects.toThrow('tavily 500');
    const sqls = query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('INSERT INTO tavily_cache'))).toBe(false);
  });
});
