/** @format */
import { ADMIN_API, authHeader, type StartResponse } from './admin-api-contract.js';
import { SmokeAssertionError } from './types.js';

type Fetch = typeof fetch;

export class AdminApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private async post(route: string, body: unknown): Promise<StartResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(this.token) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      throw new SmokeAssertionError(`admin-api ${route} -> ${res.status}: ${text}`);
    }
    const json = JSON.parse(text) as StartResponse;
    if (!json.pipelineRunId) {
      throw new SmokeAssertionError(`admin-api ${route} returned no pipelineRunId: ${text}`);
    }
    return json;
  }

  startStrategist(b: { userId: string; targetCompany: string; targetRole: string; jobDescription: string; resumeId: string }) {
    return this.post(ADMIN_API.routes.strategist, b);
  }
  startArticle(b: { userId: string; s3Key: string }) { return this.post(ADMIN_API.routes.article, b); }
  startImport(b: { userId: string; s3Key: string }) { return this.post(ADMIN_API.routes.import, b); }
  startIngestion(b: { userId: string; repoFullName: string }) { return this.post(ADMIN_API.routes.ingestion, b); }
}
