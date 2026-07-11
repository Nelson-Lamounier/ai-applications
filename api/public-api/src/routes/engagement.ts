/**
 * @file engagement.ts
 * @description Article engagement (likes + comments) for the public-api service.
 *
 * RDS-backed replacement for the portfolio's legacy DynamoDB engagement layer
 * (frontend-portfolio: dynamodb-engagement.ts). Lets the portfolio become a
 * pure consumer of public-api with no direct DynamoDB access
 * (frontend-portfolio#6, ai-applications#338).
 *
 * Routes (all unauthenticated — public):
 *   GET  /api/articles/:slug/like?sessionId=  → { liked, likeCount }
 *   POST /api/articles/:slug/like { sessionId } → toggle → { liked, likeCount }
 *   GET  /api/articles/:slug/comments           → PublicComment[] (approved)
 *   POST /api/articles/:slug/comments { name, email, body } → 201 PublicComment
 *
 * Counts are derived with COUNT(*) (tables: article_likes, article_comments)
 * so they never drift. New comments default to 'pending' moderation.
 */

import { Hono } from 'hono';
import { getPool } from '../lib/pg.js';
import { loadConfig } from '../lib/config.js';
import { clientIpFromRequest } from '../lib/client-ip.js';

const engagement = new Hono();

/** Likes/comments are personal/volatile — do not cache at the edge. */
const NO_STORE = 'no-store';
/** Approved comments change rarely; allow a short edge cache. */
const COMMENTS_CACHE = 'public, s-maxage=60, stale-while-revalidate=120';

/** Maximum comment body length. */
const MAX_COMMENT_LENGTH = 2000;
/** Maximum comments per IP per rolling hour. */
const RATE_LIMIT_MAX = 5;

interface PublicComment {
  commentId: string;
  name: string;
  body: string;
  createdAt: Date;
}

/** Total likes for a slug. */
async function likeCount(pool: ReturnType<typeof getPool>, slug: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM article_likes WHERE article_slug = $1`,
    [slug],
  );
  return Number(r.rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Likes
// ---------------------------------------------------------------------------

/**
 * GET /api/articles/:slug/like?sessionId=
 * Returns whether this session liked the article and the total count.
 */
engagement.get('/api/articles/:slug/like', async (c) => {
  const slug = c.req.param('slug');
  const sessionId = c.req.query('sessionId');
  const cfg = loadConfig();
  const pool = getPool(cfg);

  c.header('Cache-Control', NO_STORE);

  if (!sessionId) {
    return c.json({ liked: false, likeCount: await likeCount(pool, slug) });
  }

  const liked = await pool.query(
    `SELECT 1 FROM article_likes WHERE article_slug = $1 AND session_id = $2`,
    [slug, sessionId],
  );
  return c.json({ liked: liked.rows.length > 0, likeCount: await likeCount(pool, slug) });
});

/**
 * POST /api/articles/:slug/like  { sessionId }
 * Toggles the like for the session (delete-or-insert) and returns the new state.
 */
engagement.post('/api/articles/:slug/like', async (c) => {
  const slug = c.req.param('slug');
  const cfg = loadConfig();
  const pool = getPool(cfg);

  c.header('Cache-Control', NO_STORE);

  let body: { sessionId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'BadRequest', message: 'Invalid JSON body' }, 400);
  }

  if (!body.sessionId || typeof body.sessionId !== 'string') {
    return c.json({ error: 'BadRequest', message: 'Missing sessionId' }, 400);
  }

  // Toggle: try to remove an existing like; if none removed, add one.
  const removed = await pool.query(
    `DELETE FROM article_likes WHERE article_slug = $1 AND session_id = $2`,
    [slug, body.sessionId],
  );

  let liked: boolean;
  if (removed.rowCount && removed.rowCount > 0) {
    liked = false;
  } else {
    await pool.query(
      `INSERT INTO article_likes (article_slug, session_id) VALUES ($1, $2)
       ON CONFLICT (article_slug, session_id) DO NOTHING`,
      [slug, body.sessionId],
    );
    liked = true;
  }

  return c.json({ liked, likeCount: await likeCount(pool, slug) });
});

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/**
 * GET /api/articles/:slug/comments
 * Returns approved comments (public-safe: no email / IP), oldest first.
 */
engagement.get('/api/articles/:slug/comments', async (c) => {
  const slug = c.req.param('slug');
  const cfg = loadConfig();
  const pool = getPool(cfg);

  const result = await pool.query<{ id: string; name: string; body: string; created_at: Date }>(
    `SELECT id, name, body, created_at
       FROM article_comments
      WHERE article_slug = $1 AND status = 'approved'
      ORDER BY created_at ASC`,
    [slug],
  );

  const comments: PublicComment[] = result.rows.map((r) => ({
    commentId: r.id,
    name: r.name,
    body: r.body,
    createdAt: r.created_at,
  }));

  c.header('Cache-Control', COMMENTS_CACHE);
  return c.json(comments);
});

/**
 * POST /api/articles/:slug/comments  { name, email, body }
 * Creates a comment (status 'pending'). Validates input and rate-limits per IP.
 */
engagement.post('/api/articles/:slug/comments', async (c) => {
  const slug = c.req.param('slug');
  const cfg = loadConfig();
  const pool = getPool(cfg);

  c.header('Cache-Control', NO_STORE);

  let raw: { name?: string; email?: string; body?: string };
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'BadRequest', message: 'Invalid JSON body' }, 400);
  }

  const name = (raw.name ?? '').trim();
  const email = (raw.email ?? '').trim().toLowerCase();
  const body = (raw.body ?? '').trim();

  if (!name || name.length > 100) {
    return c.json({ error: 'BadRequest', message: 'Name is required (max 100 characters)' }, 400);
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'BadRequest', message: 'A valid email address is required' }, 400);
  }
  if (!body || body.length > MAX_COMMENT_LENGTH) {
    return c.json(
      { error: 'BadRequest', message: `Comment is required (max ${MAX_COMMENT_LENGTH} characters)` },
      400,
    );
  }

  // Trust only the proxy-appended (rightmost) XFF entry — the leftmost value is
  // caller-controlled and would let anyone spoof a fresh IP per request to
  // defeat the per-IP limit below. See lib/client-ip.ts for the ALB semantics.
  const ipAddress = clientIpFromRequest(c.req);

  // Rate limit: max RATE_LIMIT_MAX comments per IP in the last hour.
  const recent = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::int AS n
       FROM article_comments
      WHERE ip_address = $1 AND created_at > now() - interval '1 hour'`,
    [ipAddress],
  );
  if (Number(recent.rows[0]?.n ?? 0) >= RATE_LIMIT_MAX) {
    return c.json(
      { error: 'TooManyRequests', message: 'Rate limit exceeded. Please try again later.' },
      429,
    );
  }

  const inserted = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO article_comments (article_slug, name, email, body, ip_address, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     RETURNING id, created_at`,
    [slug, name, email, body, ipAddress],
  );

  const row = inserted.rows[0]!;
  const comment: PublicComment = {
    commentId: row.id,
    name,
    body,
    createdAt: row.created_at,
  };
  return c.json(comment, 201);
});

export default engagement;
