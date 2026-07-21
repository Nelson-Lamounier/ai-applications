/**
 * @file index.ts
 * @description Entry point for the public-api Hono service.
 *
 * Assembles the application by mounting:
 *   - Metrics route    → GET /metrics          (no CORS — internal scraping only)
 *   - CORS middleware  (all subsequent routes)
 *   - Health route     → GET /healthz
 *   - Articles route   → GET /api/articles, GET /api/articles/:slug
 *   - Tags route       → GET /api/tags
 *   - Resumes route    → GET /api/resumes/active
 *   - Chatbot route    → POST /api/chatbot/invoke
 *   - GitHub webhook   → POST /webhooks/github
 *   - Projects routes  → GET /api/projects[/:slug] (portfolio owner), GET /public/projects/:username/:slug (share)
 *   - Article images   → GET /api/articles/images/:file (streams from the article-assets S3 bucket)
 *
 * ## Credential Chain
 *
 * No AWS credentials are configured in code. The AWS SDK v3 default
 * credential provider chain resolves credentials automatically via
 * the EC2 Instance Profile (IMDS) attached to the Kubernetes node.
 * The `AWS_DEFAULT_REGION` environment variable (from `nextjs-config`
 * ConfigMap) is used by the SDK to determine the target region.
 *
 * ## Port
 *
 * Defaults to `3001`. Override via the `PORT` environment variable.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { loadConfig } from './lib/config.js';
import health from './routes/health.js';
import articles from './routes/articles.js';
import engagement from './routes/engagement.js';
import chatbot from './routes/chatbot.js';
import tags from './routes/tags.js';
import resumes from './routes/resumes.js';
import githubWebhook from './routes/github-webhook.js';
import projects from './routes/projects.js';
import metrics from './routes/metrics.js';
import articleImages from './routes/article-images.js';

const cfg = loadConfig();

const app = new Hono();

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------

/** Structured request logging to stdout. */
app.use('*', logger());

// Metrics endpoint is mounted before CORS so Prometheus scrapers receive no
// CORS headers (scraping is server-to-server; browser access is not intended).
app.route('/', metrics);

/** CORS — allow portfolio origin and local dev. */
app.use(
  '*',
  cors({
    origin: ['https://nelsonlamounier.com', 'http://localhost:3000'],
    // POST added for /api/chat and /api/chatbot/invoke (BFF proxy — Gap S2)
    allowMethods: ['GET', 'HEAD', 'OPTIONS', 'POST'],
    allowHeaders: ['Content-Type', 'Accept'],
    credentials: false,
    maxAge: 86_400,
  }),
);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.route('/', health);
app.route('/', articles);
app.route('/', engagement);
app.route('/', chatbot);
app.route('/', tags);
app.route('/', resumes);
app.route('/', githubWebhook);
app.route('/', projects);
app.route('/', articleImages);

// ---------------------------------------------------------------------------
// 404 fallback
// ---------------------------------------------------------------------------

app.notFound((c) => {
  return c.json({ error: 'Not found', path: c.req.path }, 404);
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

app.onError((err, c) => {
  console.error('[public-api] Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

console.log(`[public-api] Starting on port ${cfg.port}`);
console.log(`[public-api] Region: ${cfg.awsRegion}`);
console.log(`[public-api] PG: ${cfg.pgUser}@${cfg.pgHost}:${cfg.pgPort}/${cfg.pgDatabase}`);

serve({
  fetch: app.fetch,
  port: cfg.port,
});
