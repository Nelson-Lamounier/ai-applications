/**
 * @file resumes.ts
 * @description Public resume route for the public-api service.
 *
 * Exposes the active resume publicly so portfolio visitors and the site's
 * SSR pages can fetch it without hitting the database directly.
 *
 * Routes (all unauthenticated — public read-only):
 *
 *   GET /api/resumes/active — Returns the currently active resume.
 *                             Returns 204 if no resume is active.
 *
 * ## Caching strategy
 *
 * Resumes change rarely (admin action required), so we apply a generous
 * Cache-Control header (`s-maxage=300, stale-while-revalidate=600`).
 *
 * ## PG access pattern
 *
 * Resumes live in the `resumes` table. Each row's `content_json` JSONB
 * payload carries an `is_active` boolean (sourced from the legacy DynamoDB
 * `isActive` field during Phase 2 migration). The active resume is the
 * single row with `content_json->>'is_active' = 'true'`.
 */

import { Hono } from 'hono';
import { getPool } from '../lib/pg.js';
import { loadConfig } from '../lib/config.js';

const resumes = new Hono();

/** Cache-Control header for resume responses. */
const CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=600';

interface ActiveResumeRow {
  id:           string;
  content_json: Record<string, unknown>;
  generated_at: Date;
}

/**
 * GET /api/resumes/active
 *
 * Returns the currently active resume data.
 *
 * Response:
 *   200 — Active resume JSON (full data included)
 *   204 — No active resume configured (frontend falls back to hardcoded data)
 */
resumes.get('/api/resumes/active', async (c) => {
  const cfg  = loadConfig();
  const pool = getPool(cfg);

  const result = await pool.query<ActiveResumeRow>(
    `SELECT id, content_json, generated_at
       FROM resumes
      WHERE content_json->>'is_active' = 'true'
      LIMIT 1`,
  );

  if (result.rows.length === 0) {
    // 204 No Content — frontend uses hardcoded fallback
    return c.body(null, 204);
  }

  const row = result.rows[0]!;
  const cj  = row.content_json as Record<string, unknown>;
  const resume = {
    resumeId:  row.id,
    label:     (cj['label'] as string)      ?? '',
    isActive:  (cj['is_active'] as boolean) ?? false,
    data:      cj,                          // full structured resume data lives in content_json
    createdAt: row.generated_at,
    updatedAt: row.generated_at,
  };
  c.header('Cache-Control', CACHE_CONTROL);
  return c.json(resume);
});

export default resumes;
