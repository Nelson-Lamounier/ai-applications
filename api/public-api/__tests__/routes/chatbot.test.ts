/**
 * @format
 * Tests for public-api routes/chatbot.ts
 *
 * Strategy: mock config, SecretsManagerClient, and globalThis.fetch so all
 * tests run offline with no real AWS calls.
 *
 * The SecretsManagerClient is a module-level singleton in chatbot.ts (created
 * once at import time). We expose a stable `mockSend` reference through the
 * mock factory — Jest allows `mock`-prefixed vars to be referenced inside
 * hoisted jest.mock() closures.
 *
 * Coverage:
 *   POST /api/chatbot/invoke        — proxies to bedrockApiUrl/invoke
 *   POST /api/chat                  — normalises response to { message, sessionId }
 *   POST /api/chatbot/public        — proxies to bedrockPublicApiUrl (full URL)
 *   POST /api/chatbot/authenticated — proxies to bedrockAuthApiUrl (full URL)
 *   All routes                      — 503 when URL/secret not configured
 *   All routes                      — 503 on upstream timeout
 *   All routes                      — 502 on upstream fetch error
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { Config } from '../../src/lib/config.js';

// ---------------------------------------------------------------------------
// Stable mock for SecretsManagerClient.send
// (must be `mock`-prefixed so Jest allows it inside the hoisted factory)
// ---------------------------------------------------------------------------

const mockSmSend = jest.fn<() => Promise<{ SecretString: string }>>();

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({
    send: mockSmSend,
  })),
  GetSecretValueCommand: jest.fn(),
}));

jest.mock('../../src/lib/config.js', () => ({
  loadConfig: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import chatbot from '../../src/routes/chatbot.js';
import { loadConfig } from '../../src/lib/config.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECRET_ARN = 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:chatbot-api-key';
const API_KEY    = 'test-api-key-value';

const BASE_CONFIG: Config = {
  awsRegion:  'eu-west-1',
  oauthTokenKmsKeyArn: 'arn:aws:kms:eu-west-1:123456789012:key/12345678-1234-1234-1234-123456789012',
  githubAppSecretArn:  'arn:aws:secretsmanager:eu-west-1:123456789012:secret/github-app-test',
  pgHost:     'localhost',
  pgPort:     5432,
  pgDatabase: 'platform',
  pgUser:     'public_api',
  pgPassword: 'secret',
  port:       3001,
  allowedOrigins:          ['http://localhost:3000'],
  bedrockApiUrl:           'https://api.execute-api.eu-west-1.amazonaws.com/v1/',
  bedrockApiKeySecretArn:  SECRET_ARN,
  bedrockPublicApiUrl:     'https://api.execute-api.eu-west-1.amazonaws.com/v1/invoke-public',
  bedrockAuthApiUrl:       'https://api.execute-api.eu-west-1.amazonaws.com/v1/invoke-authenticated',
};

function makeUpstreamResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();

  mockSmSend.mockResolvedValue({ SecretString: API_KEY });
  jest.mocked(loadConfig).mockReturnValue(BASE_CONFIG);

  globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
    makeUpstreamResponse({ response: 'Hello', sessionId: 'sess-1' }),
  );
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// POST /api/chatbot/invoke
// ---------------------------------------------------------------------------

describe('POST /api/chatbot/invoke', () => {
  it('returns 200 with upstream data', async () => {
    const res = await chatbot.request('/api/chatbot/invoke', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'Hello' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['response']).toBe('Hello');
  });

  it('appends /invoke to bedrockApiUrl', async () => {
    await chatbot.request('/api/chatbot/invoke', { method: 'POST', body: '{}' });
    const fetchCall = jest.mocked(globalThis.fetch).mock.calls[0];
    expect(fetchCall?.[0]).toBe('https://api.execute-api.eu-west-1.amazonaws.com/v1/invoke');
  });

  it('injects x-api-key header', async () => {
    await chatbot.request('/api/chatbot/invoke', { method: 'POST', body: '{}' });
    const headers = jest.mocked(globalThis.fetch).mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers?.['x-api-key']).toBe(API_KEY);
  });

  it('returns 503 when bedrockApiUrl is absent', async () => {
    jest.mocked(loadConfig).mockReturnValue({ ...BASE_CONFIG, bedrockApiUrl: undefined });
    const res = await chatbot.request('/api/chatbot/invoke', { method: 'POST', body: '{}' });
    expect(res.status).toBe(503);
  });

  it('returns 503 when bedrockApiKeySecretArn is absent', async () => {
    jest.mocked(loadConfig).mockReturnValue({ ...BASE_CONFIG, bedrockApiKeySecretArn: undefined });
    const res = await chatbot.request('/api/chatbot/invoke', { method: 'POST', body: '{}' });
    expect(res.status).toBe(503);
  });

  it('returns 503 on upstream timeout', async () => {
    jest.mocked(globalThis.fetch).mockRejectedValue(
      Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
    );
    const res = await chatbot.request('/api/chatbot/invoke', { method: 'POST', body: '{}' });
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body['error']).toBe('ChatbotTimeout');
  });

  it('returns 502 on generic fetch error', async () => {
    jest.mocked(globalThis.fetch).mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await chatbot.request('/api/chatbot/invoke', { method: 'POST', body: '{}' });
    expect(res.status).toBe(502);
    const body = await res.json() as Record<string, unknown>;
    expect(body['error']).toBe('UpstreamError');
  });
});

// ---------------------------------------------------------------------------
// POST /api/chat
// ---------------------------------------------------------------------------

describe('POST /api/chat', () => {
  it('normalises { response } to { message }', async () => {
    const res = await chatbot.request('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'Hi' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['message']).toBe('Hello');
    expect(body['sessionId']).toBe('sess-1');
  });

  it('passes through { message } directly when upstream returns it', async () => {
    jest.mocked(globalThis.fetch).mockResolvedValue(
      makeUpstreamResponse({ message: 'Direct message', sessionId: 'sess-2' }),
    );
    const res = await chatbot.request('/api/chat', { method: 'POST', body: '{}' });
    const body = await res.json() as Record<string, unknown>;
    expect(body['message']).toBe('Direct message');
  });

  it('returns upstream error payload unchanged when status >= 400', async () => {
    jest.mocked(globalThis.fetch).mockResolvedValue(
      makeUpstreamResponse({ error: 'BadRequest' }, 400),
    );
    const res = await chatbot.request('/api/chat', { method: 'POST', body: '{}' });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body['error']).toBe('BadRequest');
  });

  it('returns 503 when bedrockApiUrl is absent', async () => {
    jest.mocked(loadConfig).mockReturnValue({ ...BASE_CONFIG, bedrockApiUrl: undefined });
    const res = await chatbot.request('/api/chat', { method: 'POST', body: '{}' });
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// POST /api/chatbot/public
// ---------------------------------------------------------------------------

describe('POST /api/chatbot/public', () => {
  it('returns 200 with upstream data', async () => {
    jest.mocked(globalThis.fetch).mockResolvedValue(
      makeUpstreamResponse({ response: 'RAG answer' }),
    );
    const res = await chatbot.request('/api/chatbot/public', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'Tell me about Nelson' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['response']).toBe('RAG answer');
  });

  it('proxies to bedrockPublicApiUrl directly (full URL, no path suffix appended)', async () => {
    await chatbot.request('/api/chatbot/public', { method: 'POST', body: '{}' });
    const fetchCall = jest.mocked(globalThis.fetch).mock.calls[0];
    expect(fetchCall?.[0]).toBe('https://api.execute-api.eu-west-1.amazonaws.com/v1/invoke-public');
  });

  it('injects x-api-key header', async () => {
    await chatbot.request('/api/chatbot/public', { method: 'POST', body: '{}' });
    const headers = jest.mocked(globalThis.fetch).mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers?.['x-api-key']).toBe(API_KEY);
  });

  it('returns 503 when bedrockPublicApiUrl is absent', async () => {
    jest.mocked(loadConfig).mockReturnValue({ ...BASE_CONFIG, bedrockPublicApiUrl: undefined });
    const res = await chatbot.request('/api/chatbot/public', { method: 'POST', body: '{}' });
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body['error']).toBe('ChatbotUnavailable');
  });

  it('returns 503 when bedrockApiKeySecretArn is absent', async () => {
    jest.mocked(loadConfig).mockReturnValue({ ...BASE_CONFIG, bedrockApiKeySecretArn: undefined });
    const res = await chatbot.request('/api/chatbot/public', { method: 'POST', body: '{}' });
    expect(res.status).toBe(503);
  });

  it('returns 503 on upstream timeout', async () => {
    jest.mocked(globalThis.fetch).mockRejectedValue(
      Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
    );
    const res = await chatbot.request('/api/chatbot/public', { method: 'POST', body: '{}' });
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body['error']).toBe('ChatbotTimeout');
  });
});

// ---------------------------------------------------------------------------
// POST /api/chatbot/authenticated
// ---------------------------------------------------------------------------

describe('POST /api/chatbot/authenticated', () => {
  it('returns 200 with upstream data including sessionId', async () => {
    jest.mocked(globalThis.fetch).mockResolvedValue(
      makeUpstreamResponse({ response: 'Auth answer', sessionId: 'sess-auth-1' }),
    );
    const res = await chatbot.request('/api/chatbot/authenticated', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'What is my experience?', sessionId: 'sess-auth-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['sessionId']).toBe('sess-auth-1');
  });

  it('proxies to bedrockAuthApiUrl directly (full URL, no path suffix appended)', async () => {
    await chatbot.request('/api/chatbot/authenticated', { method: 'POST', body: '{}' });
    const fetchCall = jest.mocked(globalThis.fetch).mock.calls[0];
    expect(fetchCall?.[0]).toBe('https://api.execute-api.eu-west-1.amazonaws.com/v1/invoke-authenticated');
  });

  it('injects x-api-key header', async () => {
    await chatbot.request('/api/chatbot/authenticated', { method: 'POST', body: '{}' });
    const headers = jest.mocked(globalThis.fetch).mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers?.['x-api-key']).toBe(API_KEY);
  });

  it('returns 503 when bedrockAuthApiUrl is absent', async () => {
    jest.mocked(loadConfig).mockReturnValue({ ...BASE_CONFIG, bedrockAuthApiUrl: undefined });
    const res = await chatbot.request('/api/chatbot/authenticated', { method: 'POST', body: '{}' });
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body['error']).toBe('ChatbotUnavailable');
  });

  it('returns 503 when bedrockApiKeySecretArn is absent', async () => {
    jest.mocked(loadConfig).mockReturnValue({ ...BASE_CONFIG, bedrockApiKeySecretArn: undefined });
    const res = await chatbot.request('/api/chatbot/authenticated', { method: 'POST', body: '{}' });
    expect(res.status).toBe(503);
  });

  it('returns 502 on generic fetch error', async () => {
    jest.mocked(globalThis.fetch).mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await chatbot.request('/api/chatbot/authenticated', { method: 'POST', body: '{}' });
    expect(res.status).toBe(502);
    const body = await res.json() as Record<string, unknown>;
    expect(body['error']).toBe('UpstreamError');
  });
});
