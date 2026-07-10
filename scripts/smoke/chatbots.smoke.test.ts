/** @format */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { recordCleanup } from './cleanup-file.js';
import type { Endpoints } from './types.js';

const ep: Endpoints = JSON.parse(readFileSync(process.env.SMOKE_ENDPOINTS_FILE!, 'utf-8'));
const QUESTION = 'In one sentence, what is this portfolio about?';

interface ChatReply { response?: string; message?: string; sessionId?: string }

/** The chatbot Lambdas take { prompt, sessionId?, callerRole? } and reply
 *  { response, sessionId }. The agent api key (if any) goes in x-api-key;
 *  the authenticated variant additionally needs the Cognito Bearer. */
async function ask(url: string, body: object, headers: Record<string, string> = {}) {
  const apiKey = ep.chatbotApiKey;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: ChatReply = {};
  try { json = JSON.parse(text) as ChatReply; } catch { /* keep raw text */ }
  return { status: res.status, text, json };
}

describe('chatbots', () => {
  it('public chatbot answers', async () => {
    // Post-decommission routes: /invoke-public (stateless) and
    // /invoke-authenticated (session-aware); both serve from RDS pgvector.
    const { status, text, json } = await ask(`${ep.chatbotPublicUrl}/invoke-public`,
      { prompt: QUESTION });
    expect(status).toBe(200);
    expect((json.response ?? json.message ?? text).length).toBeGreaterThan(2);
  }, 120_000);

  it('default chatbot answers', async () => {
    const { status, text, json } = await ask(`${ep.chatbotUrl}/invoke-authenticated`,
      { prompt: QUESTION, sessionId: randomUUID() });
    expect(status).toBe(200);
    expect((json.response ?? json.message ?? text).length).toBeGreaterThan(2);
  }, 120_000);

  (ep.cognitoIdToken ? it : it.skip)('authenticated chatbot answers and persists a session', async () => {
    const { status, json } = await ask(`${ep.chatbotAuthenticatedUrl}/invoke-authenticated`,
      { prompt: QUESTION, callerRole: 'user' },
      { Authorization: `Bearer ${ep.cognitoIdToken}` });
    expect(status).toBe(200);
    expect((json.response ?? json.message ?? '').length).toBeGreaterThan(2);
    // chat_sessions.id is a UUID minted server-side; record the returned
    // id so cleanup deletes exactly that session (+ its messages).
    if (json.sessionId) recordCleanup({ flow: 'chatbots', chatSessionId: json.sessionId });
  }, 120_000);
});
