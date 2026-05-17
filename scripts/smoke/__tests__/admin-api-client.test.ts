/** @format */
import { AdminApiClient } from '../admin-api-client';

describe('AdminApiClient', () => {
  it('POSTs the strategist route with auth header and returns the run id', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ pipelineRunId: 'run-7', slug: 's-7' }), { status: 202 });
    }) as unknown as typeof fetch;
    const c = new AdminApiClient('http://127.0.0.1:13002', 'tok', fetchMock);
    const r = await c.startStrategist({ userId: 'u', targetCompany: 'Acme', targetRole: 'SRE', jobDescription: 'jd', resumeId: 'res-1' });
    expect(r).toEqual({ pipelineRunId: 'run-7', slug: 's-7' });
    expect(calls[0].url).toMatch(/\/api\/strategist\/analyse$/);
    expect((calls[0].init.headers as Record<string,string>).Authorization).toBe('Bearer tok');
  });

  it('throws on non-2xx with status + body', async () => {
    const fetchMock = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const c = new AdminApiClient('http://h', 't', fetchMock);
    await expect(c.startArticle({ userId: 'u', s3Key: 'smoke/x.md' })).rejects.toThrow(/500.*nope/s);
  });
});
