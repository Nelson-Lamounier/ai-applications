/** @format */
import { readFileSync } from 'node:fs';
import type { Endpoints } from './types.js';

const ep: Endpoints = JSON.parse(readFileSync(process.env.SMOKE_ENDPOINTS_FILE!, 'utf-8'));
const QUESTION = 'In one sentence, what is this portfolio about?';

async function ask(url: string, body: unknown, headers: Record<string,string> = {}) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

describe('chatbots', () => {
  it('public chatbot answers', async () => {
    const { status, text } = await ask(`${ep.chatbotPublicUrl}/invoke-public`,
      { question: QUESTION, sessionId: `smoke-${Date.now()}` });
    expect(status).toBe(200);
    expect(text.length).toBeGreaterThan(2);
  }, 120_000);

  it('default chatbot answers', async () => {
    const { status, text } = await ask(`${ep.chatbotUrl}/invoke`,
      { question: QUESTION, sessionId: `smoke-${Date.now()}` });
    expect(status).toBe(200);
    expect(text.length).toBeGreaterThan(2);
  }, 120_000);

  (ep.chatbotAuthJwt ? it : it.skip)('authenticated chatbot answers', async () => {
    const sessionId = `smoke-auth-${Date.now()}`;
    const { status } = await ask(`${ep.chatbotAuthenticatedUrl}/invoke-authenticated`,
      { question: QUESTION, sessionId }, { Authorization: `Bearer ${ep.chatbotAuthJwt}` });
    expect(status).toBe(200);
    console.log(`SMOKE_CHAT_SESSION=${sessionId}`);
  }, 120_000);
});
