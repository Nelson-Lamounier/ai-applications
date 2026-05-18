/** @format */
import { AdminApiClient } from '../admin-api-client';

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('AdminApiClient — auth + routes', () => {
  it('startStrategist POSTs the real route with a Bearer JWT and returns the run id', async () => {
    const { fn, calls } = mockFetch(() =>
      new Response(JSON.stringify({ pipelineRunId: 'run-7', applicationId: 'app-7' }), { status: 202 }));
    const c = new AdminApiClient('http://127.0.0.1:13002', 'jwt-abc', fn);
    const r = await c.startStrategist({ targetCompany: 'Acme', targetRole: 'SRE', jobDescription: 'jd', resumeId: 'res-1' });
    expect(r).toEqual({ pipelineRunId: 'run-7', applicationId: 'app-7', importId: undefined, slug: undefined });
    expect(calls[0].url).toMatch(/\/api\/admin\/pipelines\/strategist-job$/);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-abc');
    expect(JSON.parse(calls[0].init.body as string)).not.toHaveProperty('userId');
  });

  it('startArticle puts the slug in the path (not the body) and accepts snake_case pipeline_run_id', async () => {
    const { fn, calls } = mockFetch(() =>
      new Response(JSON.stringify({ pipeline_run_id: 'run-9', slug: 'my-post' }), { status: 202 }));
    const c = new AdminApiClient('http://h', 't', fn);
    const r = await c.startArticle({ slug: 'my-post' });
    expect(r.pipelineRunId).toBe('run-9');
    expect(r.slug).toBe('my-post');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].url).toMatch(/\/api\/admin\/pipelines\/article-job\/my-post$/);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({});
  });

  it('startIngestion posts repoFullName', async () => {
    const { fn, calls } = mockFetch(() =>
      new Response(JSON.stringify({ pipelineRunId: 'run-i' }), { status: 202 }));
    const c = new AdminApiClient('http://h', 't', fn);
    await c.startIngestion({ repoFullName: 'octocat/hello' });
    expect(calls[0].url).toMatch(/\/api\/admin\/ingestion\/trigger$/);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ repoFullName: 'octocat/hello' });
  });

  it('throws SmokeAssertionError on non-2xx with status + body', async () => {
    const { fn } = mockFetch(() => new Response('nope', { status: 500 }));
    const c = new AdminApiClient('http://h', 't', fn);
    await expect(c.startArticle({ slug: 'x' })).rejects.toThrow(/500.*nope/s);
  });

  it('throws when the response carries no run id', async () => {
    const { fn } = mockFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const c = new AdminApiClient('http://h', 't', fn);
    await expect(c.startStrategist({ targetCompany: 'A', targetRole: 'B', jobDescription: 'c', resumeId: 'r' }))
      .rejects.toThrow(/no .*run id/i);
  });
});

describe('AdminApiClient — resume-import 3-step upload', () => {
  it('requestResumeUpload returns uploadUrl + importId + s3Key', async () => {
    const { fn, calls } = mockFetch(() =>
      new Response(JSON.stringify({ uploadUrl: 'https://s3/put', importId: 'imp-1', s3Key: 'smoke/r.pdf' }), { status: 200 }));
    const c = new AdminApiClient('http://h', 't', fn);
    const r = await c.requestResumeUpload({ filename: 'r.pdf', contentType: 'application/pdf', fileSizeBytes: 1234 });
    expect(r).toEqual({ uploadUrl: 'https://s3/put', importId: 'imp-1', s3Key: 'smoke/r.pdf' });
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].url).toMatch(
      /\/api\/admin\/resume-imports\/upload-url\?filename=r\.pdf&contentType=application%2Fpdf&fileSizeBytes=1234$/,
    );
  });

  it('putResumeBytes does a raw PUT with Content-Type and Content-Length (no auth header)', async () => {
    const { fn, calls } = mockFetch(() => new Response(null, { status: 200 }));
    const c = new AdminApiClient('http://h', 't', fn);
    const body = Buffer.from('PDFDATA');
    await c.putResumeBytes('https://s3/put', body, 'application/pdf');
    expect(calls[0].url).toBe('https://s3/put');
    expect(calls[0].init.method).toBe('PUT');
    const h = calls[0].init.headers as Record<string, string>;
    expect(h['Content-Type']).toBe('application/pdf');
    expect(h['Content-Length']).toBe(String(body.length));
    expect(h.Authorization).toBeUndefined();
  });

  it('completeResumeImport POSTs /:id/complete with the Bearer JWT', async () => {
    const { fn, calls } = mockFetch(() =>
      new Response(JSON.stringify({ importId: 'imp-1' }), { status: 200 }));
    const c = new AdminApiClient('http://h', 'jwt-z', fn);
    await c.completeResumeImport('imp-1');
    expect(calls[0].url).toMatch(/\/api\/admin\/resume-imports\/imp-1\/complete$/);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-z');
  });

  it('putResumeBytes throws on a non-2xx S3 response', async () => {
    const { fn } = mockFetch(() => new Response('AccessDenied', { status: 403 }));
    const c = new AdminApiClient('http://h', 't', fn);
    await expect(c.putResumeBytes('https://s3/put', Buffer.from('x'), 'application/pdf'))
      .rejects.toThrow(/403.*AccessDenied/s);
  });
});
