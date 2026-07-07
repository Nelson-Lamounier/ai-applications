/**
 * @file article-images.ts
 * @description Public article media — streams `images/articles/<file>` from
 * the dedicated article-assets S3 bucket (no PII lives in that bucket).
 *
 * Security: anonymous by design (published-article media is public). The
 * prefix is hard-coded, the filename is a single strictly-validated path
 * segment, and the runtime role can only read `images/articles/*` — three
 * independent containment layers.
 *
 * Routes:
 *   GET /api/articles/images/:file — 200 stream | 400 invalid name |
 *                                     404 missing | 502 upstream S3 error |
 *                                     503 unconfigured
 */

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Hono } from 'hono';

import { loadConfig } from '../lib/config.js';

// =============================================================================
// S3 client — credentials resolved via EC2 instance profile
// =============================================================================

const s3Client = new S3Client({});

/** Single path segment: lowercase slug + allowlisted image extension. */
const FILE_RE = /^[a-z0-9][a-z0-9-]*\.(jpeg|jpg|png|webp|gif)$/;

/** Replaceable-by-slug content must not be immutable; 1h matches the site's ISR ethos. */
const CACHE_CONTROL = 'public, max-age=3600';

const articleImages = new Hono();

/**
 * GET /api/articles/images/:file
 *
 * Streams a single image object from `images/articles/<file>` in the
 * article-assets bucket. The filename is validated against {@link FILE_RE}
 * BEFORE any S3 call — invalid names never reach the SDK.
 */
articleImages.get('/api/articles/images/:file', async (c) => {
  const file = c.req.param('file');
  if (!FILE_RE.test(file)) {
    return c.json({ error: 'Invalid image name' }, 400);
  }

  const cfg = loadConfig();
  if (!cfg.articleAssetsBucketName) {
    console.error('[article-images] ARTICLE_ASSETS_BUCKET_NAME not configured');
    return c.json({ error: 'Article media unavailable — bucket not configured' }, 503);
  }

  try {
    const obj = await s3Client.send(
      new GetObjectCommand({
        Bucket: cfg.articleAssetsBucketName,
        Key: `images/articles/${file}`,
      }),
    );
    const body = obj.Body as { transformToWebStream: () => ReadableStream } | undefined;
    if (!body) {
      return c.json({ error: 'Not found' }, 404);
    }
    c.header('Cache-Control', CACHE_CONTROL);
    c.header('Content-Type', obj.ContentType ?? 'application/octet-stream');
    if (obj.ContentLength !== undefined) {
      c.header('Content-Length', String(obj.ContentLength));
    }
    return c.body(body.transformToWebStream());
  } catch (err: unknown) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'NoSuchKey' || name === 'NotFound') {
      return c.json({ error: 'Not found' }, 404);
    }
    console.error('[article-images] S3 GetObject failed');
    return c.json({ error: 'Upstream storage error' }, 502);
  }
});

export default articleImages;
