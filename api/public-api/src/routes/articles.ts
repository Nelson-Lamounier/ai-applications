/**
 * @file articles.ts
 * @description Article routes for the public-api service.
 *
 * Exposes read-only article data from the platform Postgres database to the
 * Next.js frontend. All routes are unauthenticated and cacheable by CloudFront.
 *
 * ## Caching Strategy
 *
 * All responses include `Cache-Control: s-maxage=300` to allow CloudFront
 * to serve cached responses at the edge for up to 5 minutes, reducing
 * database reads for the high-traffic public listing.
 */

import { Hono } from 'hono';
import { getPool } from '../lib/pg.js';
import { loadConfig } from '../lib/config.js';

const articles = new Hono();

/** Cache-Control header applied to all article responses. */
const CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=60';

/** Row shape returned by the listing query (lightweight projection). */
interface PublicArticleRow {
  slug:         string;
  title:        string;
  excerpt:      string | null;
  published_at: Date | null;
  tags:         string[] | null;
  cover_image:  string | null;
}

/** Row shape for the single-article detail query. */
interface ArticleDetailRow extends PublicArticleRow {
  content_md:   string;
  ai_generated: boolean;
  ai_model:     string | null;
  created_at:   Date;
  updated_at:   Date;
}

/**
 * GET /api/articles
 *
 * Returns all published articles ordered by publish date (newest first).
 *
 * @returns JSON `{ items, count }` array of lightweight article objects.
 */
articles.get('/api/articles', async (c) => {
  const cfg  = loadConfig();
  const pool = getPool(cfg);

  const result = await pool.query<PublicArticleRow>(
    `SELECT slug, title, excerpt, published_at, tags, cover_image
       FROM articles
      WHERE status = 'published'
      ORDER BY published_at DESC NULLS LAST`,
  );

  const items = result.rows.map((r) => ({
    slug:        r.slug,
    title:       r.title,
    excerpt:     r.excerpt,
    publishedAt: r.published_at,
    tags:        r.tags ?? [],
    coverImage:  r.cover_image,
    // readingTime omitted — was a DynamoDB-only field. If the frontend depends on it,
    // compute from content_md length or accept its absence.
  }));
  c.header('Cache-Control', CACHE_CONTROL);
  return c.json({ items, count: items.length });
});

/**
 * GET /api/articles/:slug
 *
 * Returns a single published article by URL slug.
 *
 * @param slug - The article URL slug (e.g. `my-article-title`).
 * @returns The article object, or 404 if not found / not published.
 */
articles.get('/api/articles/:slug', async (c) => {
  const slug = c.req.param('slug');
  const cfg  = loadConfig();
  const pool = getPool(cfg);

  const result = await pool.query<ArticleDetailRow>(
    `SELECT slug, title, excerpt, content_md, tags, ai_generated, ai_model,
            cover_image, published_at, created_at, updated_at
       FROM articles
      WHERE slug = $1 AND status = 'published'`,
    [slug],
  );

  if (result.rows.length === 0) {
    return c.json({ error: 'Article not found', slug }, 404);
  }

  const row = result.rows[0]!;
  const article = {
    slug:        row.slug,
    title:       row.title,
    excerpt:     row.excerpt,
    contentMd:   row.content_md,
    tags:        row.tags ?? [],
    aiGenerated: row.ai_generated,
    aiModel:     row.ai_model,
    coverImage:  row.cover_image,
    publishedAt: row.published_at,
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
  };
  c.header('Cache-Control', CACHE_CONTROL);
  return c.json(article);
});

export default articles;
