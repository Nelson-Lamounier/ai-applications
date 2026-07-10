/**
 * @file chatbot.ts
 * @description BFF proxy routes for Bedrock chatbot endpoints (Gap S2).
 *
 * Injects the API key server-side so the browser never sees it.
 *
 * Routes:
 *   POST /api/chatbot/invoke       — legacy path, now proxies to BEDROCK_AUTH_API_URL
 *   POST /api/chat                 — normalising alias used by direct API-host
 *                                    callers (api.nelsonlamounier.com); the site
 *                                    widget reaches the same upstream via the
 *                                    Next.js /api/chat handler -> /authenticated
 *   POST /api/chatbot/public       — stateless RAG chatbot (BEDROCK_PUBLIC_API_URL)
 *   POST /api/chatbot/authenticated — session-aware RAG chatbot (BEDROCK_AUTH_API_URL)
 *
 * The old `${BEDROCK_API_URL}/invoke` upstream (Bedrock Agent + the decommissioned
 * Pinecone KB) is gone: /api/chat and /api/chatbot/invoke aliased it, so any
 * caller reaching public-api directly kept getting answers from the stale
 * Pinecone index. Every conversational route now lands on the RDS pgvector store.
 *
 * All routes return 503 when the backing URL or API key secret is not configured.
 */

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Hono } from 'hono';

import { loadConfig } from '../lib/config.js';

// =============================================================================
// Secrets Manager client — credentials resolved via EC2 instance profile
// =============================================================================

const secretsClient = new SecretsManagerClient({});

/**
 * Re-fetch interval for the cached API key.
 *
 * On each request the cache age is checked. When the TTL has elapsed the
 * next call transparently re-fetches from Secrets Manager, so a rotated key
 * is picked up within KEY_TTL_MS without a pod restart.
 *
 * 15 minutes is well below any realistic rotation schedule (90 days) while
 * keeping Secrets Manager API calls negligible (~96 calls/day per pod).
 */
const KEY_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface CachedKey {
  readonly value: string;
  /** Absolute timestamp (Date.now()) after which the cache is stale. */
  readonly expiresAt: number;
}

let _cache: CachedKey | undefined;

/**
 * Retrieve (and TTL-cache) the Bedrock API key from Secrets Manager.
 *
 * Returns the cached value while fresh. Re-fetches transparently once the
 * TTL expires so rotated keys propagate without restarting the pod.
 *
 * @param secretArn - Full ARN of the Secrets Manager secret
 * @returns The plain-string API key value
 * @throws Error if the secret has no value
 */
async function getApiKey(secretArn: string): Promise<string> {
  if (_cache !== undefined && Date.now() < _cache.expiresAt) return _cache.value;

  const resp = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );

  if (!resp.SecretString) {
    throw new Error(`[chatbot-bff] Secrets Manager secret has no value: ${secretArn}`);
  }

  _cache = { value: resp.SecretString, expiresAt: Date.now() + KEY_TTL_MS };
  return _cache.value;
}

// =============================================================================
// Shared proxy helper
// =============================================================================

interface ProxyResult {
  readonly status: number;
  readonly data: Record<string, unknown>;
}

/**
 * POSTs `body` to `fullUrl` with the API key injected as `x-api-key`.
 * Returns the upstream status and parsed JSON body.
 */
async function proxyToEndpoint(
  fullUrl: string,
  secretArn: string,
  body: string | null,
): Promise<ProxyResult> {
  let apiKey: string;
  try {
    apiKey = await getApiKey(secretArn);
  } catch (err) {
    console.error('[chatbot-bff] Failed to retrieve API key from Secrets Manager:', err);
    return {
      status: 500,
      data: { error: 'InternalError', message: 'Failed to initialise chatbot service' },
    };
  }

  // 27 s — safely under API Gateway's 29 s hard limit, leaving ~2 s for the
  // error response to clear Traefik and CloudFront before their own timeouts fire.
  const controller = AbortSignal.timeout(27_000);

  let upstream: Response;
  try {
    upstream = await fetch(fullUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body,
      signal: controller,
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    if (isTimeout) {
      console.error('[chatbot-bff] Upstream timed out after 27 s');
      return {
        status: 503,
        data: {
          error: 'ChatbotTimeout',
          message: 'The chatbot is taking too long to respond. Try a shorter message or start a new conversation.',
        },
      };
    }
    console.error('[chatbot-bff] Upstream fetch failed:', err);
    return { status: 502, data: { error: 'UpstreamError', message: 'Failed to reach chatbot upstream' } };
  }

  const data = (await upstream.json()) as Record<string, unknown>;
  return { status: upstream.status, data };
}

function unconfigured503(): ProxyResult {
  return {
    status: 503,
    data: { error: 'ChatbotUnavailable', message: 'Chatbot service is not configured' },
  };
}

/**
 * Guard + proxy shared by every route that targets the session-aware
 * pgvector Lambda (BEDROCK_AUTH_API_URL): /api/chatbot/invoke, /api/chat,
 * and /api/chatbot/authenticated all land on the same upstream.
 */
async function proxyToAuthUpstream(body: string | null): Promise<ProxyResult> {
  const cfg = loadConfig();
  if (!cfg.bedrockAuthApiUrl || !cfg.bedrockApiKeySecretArn) {
    console.error('[chatbot-bff] BEDROCK_AUTH_API_URL or BEDROCK_API_KEY_SECRET_ARN not configured');
    return unconfigured503();
  }
  return proxyToEndpoint(cfg.bedrockAuthApiUrl, cfg.bedrockApiKeySecretArn, body);
}

// =============================================================================
// Routes
// =============================================================================

const chatbot = new Hono();

/**
 * POST /api/chatbot/invoke
 *
 * Legacy route kept for API compatibility; proxies to the session-aware
 * pgvector Lambda (BEDROCK_AUTH_API_URL) — same upstream as /authenticated.
 * Accepts: { prompt: string, sessionId?: string, callerRole?: string }
 */
chatbot.post('/api/chatbot/invoke', async (c) => {
  const { status, data } = await proxyToAuthUpstream(await c.req.text());
  return c.json(data, status as Parameters<typeof c.json>[1]);
});

/**
 * POST /api/chat
 *
 * Normalising alias for callers that hit public-api directly on
 * api.nelsonlamounier.com (the ALB sends nelsonlamounier.com/* to the
 * Next.js app, whose /api/chat handler calls /api/chatbot/authenticated
 * here). Proxies to the session-aware pgvector Lambda
 * (BEDROCK_AUTH_API_URL) and normalises the response to
 * { message, sessionId } for the ChatResponse contract.
 */
chatbot.post('/api/chat', async (c) => {
  const { status, data } = await proxyToAuthUpstream(await c.req.text());

  if (status >= 400) {
    return c.json(data, status as Parameters<typeof c.json>[1]);
  }

  // Upstream Lambda returns { response, sessionId }; frontend expects { message, sessionId }.
  let message: string;
  if (typeof data.message === 'string') {
    message = data.message;
  } else if (typeof data.response === 'string') {
    message = data.response;
  } else {
    message = 'Received a response but could not parse it.';
  }
  const normalized = {
    message,
    sessionId: typeof data.sessionId === 'string' ? data.sessionId : '',
  };

  return c.json(normalized, status as Parameters<typeof c.json>[1]);
});

/**
 * POST /api/chatbot/public
 *
 * Stateless RAG chatbot (no session persistence). Proxies to the
 * chatbot-public Lambda via BEDROCK_PUBLIC_API_URL (full URL from SSM).
 * Accepts: { prompt: string }
 */
chatbot.post('/api/chatbot/public', async (c) => {
  const cfg = loadConfig();
  if (!cfg.bedrockPublicApiUrl || !cfg.bedrockApiKeySecretArn) {
    console.error('[chatbot-bff] BEDROCK_PUBLIC_API_URL or BEDROCK_API_KEY_SECRET_ARN not configured');
    const { status, data } = unconfigured503();
    return c.json(data, status as Parameters<typeof c.json>[1]);
  }
  const { status, data } = await proxyToEndpoint(cfg.bedrockPublicApiUrl, cfg.bedrockApiKeySecretArn, await c.req.text());
  return c.json(data, status as Parameters<typeof c.json>[1]);
});

/**
 * POST /api/chatbot/authenticated
 *
 * Session-aware RAG chatbot. Proxies to the chatbot-authenticated Lambda
 * via BEDROCK_AUTH_API_URL (full URL from SSM). Passes sessionId through.
 * Accepts: { prompt: string, sessionId?: string }
 */
chatbot.post('/api/chatbot/authenticated', async (c) => {
  const { status, data } = await proxyToAuthUpstream(await c.req.text());
  return c.json(data, status as Parameters<typeof c.json>[1]);
});

export default chatbot;
