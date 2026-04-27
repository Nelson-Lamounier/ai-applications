/**
 * @file tags.ts
 * @description Tags route for the public-api service.
 *
 * Returns all unique tags from published articles by aggregating the
 * `articles.tags` text[] column in Postgres. Each unique tag is returned
 * once, with an article count for the frontend tag-filter UI.
 */

import { Hono } from 'hono';
import { getPool } from '../lib/pg.js';
import { loadConfig } from '../lib/config.js';

const tags = new Hono();

/** Cache-Control — tags change infrequently, 10-minute edge cache. */
const CACHE_CONTROL = 'public, s-maxage=600, stale-while-revalidate=120';

/** Shape of a tag summary returned to the frontend. */
interface TagSummary {
  tag: string;
  count: number;
}

/**
 * GET /api/tags
 *
 * Returns an array of unique tags with article counts, sorted alphabetically.
 * Only tags from published articles are included.
 *
 * @returns JSON `{ tags: [{ tag, count }] }` sorted alphabetically.
 */
tags.get('/api/tags', async (c) => {
  const cfg  = loadConfig();
  const pool = getPool(cfg);

  const result = await pool.query<{ tag: string; count: string }>(
    `SELECT UNNEST(tags) AS tag, COUNT(*) AS count
       FROM articles
      WHERE status = 'published' AND tags IS NOT NULL
      GROUP BY tag
      ORDER BY tag ASC`,
  );

  const summary: TagSummary[] = result.rows.map((r) => ({
    tag:   r.tag,
    count: parseInt(r.count, 10),
  }));

  c.header('Cache-Control', CACHE_CONTROL);
  return c.json({ tags: summary });
});

export default tags;
