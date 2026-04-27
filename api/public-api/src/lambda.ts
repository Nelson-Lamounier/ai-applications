/**
 * @file lambda.ts
 * @description Lambda entry point for the public-api Hono service.
 *
 * Uses the built-in Hono AWS Lambda adapter to wrap the Hono app
 * in an API Gateway v1 proxy handler. The Node.js server (`index.ts`)
 * is kept for local development — Lambda uses this file only.
 *
 * Environment variables (injected by CDK PublicApiStack / ESO):
 *   AWS_DEFAULT_REGION         — AWS region
 *   PG_HOST                    — Postgres host (PgBouncer)
 *   PG_PORT                    — Postgres port (defaults to 5432)
 *   PG_DATABASE                — Postgres database name
 *   PG_USER                    — Postgres user
 *   PG_PASSWORD                — Postgres password
 *   BEDROCK_API_URL            — Chatbot API Gateway URL (optional)
 *   BEDROCK_API_KEY_SECRET_ARN — Secrets Manager ARN for chatbot API key (optional)
 */

import { handle } from 'hono/aws-lambda';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { loadConfig } from './lib/config.js';
import health from './routes/health.js';
import articles from './routes/articles.js';
import chatbot from './routes/chatbot.js';
import tags from './routes/tags.js';
import resumes from './routes/resumes.js';

const cfg = loadConfig();

const app = new Hono();

app.use('*', logger());
app.use(
  '*',
  cors({
    origin: cfg.allowedOrigins,
    allowMethods: ['GET', 'HEAD', 'OPTIONS', 'POST'],
    allowHeaders: ['Content-Type', 'Accept'],
    credentials: false,
    maxAge: 86_400,
  }),
);

app.route('/', health);
app.route('/', articles);
app.route('/', chatbot);
app.route('/', tags);
app.route('/', resumes);

app.notFound((c) => c.json({ error: 'Not found', path: c.req.path }, 404));
app.onError((err, c) => {
  console.error('[public-api] Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

export const handler = handle(app);
