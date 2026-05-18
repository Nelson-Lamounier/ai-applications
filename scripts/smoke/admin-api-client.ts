/** @format */
import { ADMIN_API, bearer, normaliseStartResponse, type StartResponse } from './admin-api-contract.js';
import { SmokeAssertionError } from './types.js';

type Fetch = typeof fetch;

export interface ResumeUploadTicket {
  uploadUrl: string;
  importId: string;
  s3Key: string;
}

/** Black-box client for the deployed admin-api. Every admin route carries a
 *  Cognito JWT Bearer token; the server derives the user from the JWT `sub`,
 *  so request bodies never carry a userId. The presigned-PUT step talks
 *  straight to S3 and must NOT send the Authorization header. */
export class AdminApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly idToken: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private async send(method: string, url: string, init: RequestInit): Promise<string> {
    const res = await this.fetchImpl(url, { method, ...init });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      throw new SmokeAssertionError(`${method} ${url} -> ${res.status}: ${text}`);
    }
    return text;
  }

  private async postJson(route: string, body: unknown): Promise<StartResponse> {
    const text = await this.send('POST', `${this.baseUrl}${route}`, {
      headers: { 'content-type': 'application/json', ...bearer(this.idToken) },
      body: JSON.stringify(body),
    });
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(text) as Record<string, unknown>; }
    catch { throw new SmokeAssertionError(`admin-api ${route} returned non-JSON: ${text}`); }
    const res = normaliseStartResponse(raw);
    if (!res.pipelineRunId && !res.importId) {
      throw new SmokeAssertionError(`admin-api ${route} returned no run id / import id: ${text}`);
    }
    return res;
  }

  /** resumeId is optional in the admin-api contract
   *  (`body.resumeId?.trim() || ''`); omit it when no seed resume exists. */
  startStrategist(b: {
    targetCompany: string; targetRole: string; jobDescription: string; resumeId?: string;
  }): Promise<StartResponse> {
    return this.postJson(ADMIN_API.routes.strategist, b);
  }

  /** Article route takes the slug as a PATH param and reads the draft from
   *  `drafts/<slug>.md` in the server's assets bucket — the body only carries
   *  an optional `mode`; any s3Key in the body is ignored by admin-api. */
  startArticle(b: { slug: string; mode?: string }): Promise<StartResponse> {
    const route = `${ADMIN_API.routes.article}/${encodeURIComponent(b.slug)}`;
    return this.postJson(route, b.mode ? { mode: b.mode } : {});
  }

  startIngestion(b: { repoFullName: string }): Promise<StartResponse> {
    return this.postJson(ADMIN_API.routes.ingestion, b);
  }

  /** Step 1 of resume-import: ask for a presigned S3 PUT url + import id.
   *  admin-api exposes this as GET with query params (filename, contentType,
   *  fileSizeBytes) — not a JSON body. */
  async requestResumeUpload(b: {
    filename: string; contentType: string; fileSizeBytes: number;
  }): Promise<ResumeUploadTicket> {
    const qs = new URLSearchParams({
      filename: b.filename,
      contentType: b.contentType,
      fileSizeBytes: String(b.fileSizeBytes),
    });
    const text = await this.send(
      'GET',
      `${this.baseUrl}${ADMIN_API.routes.resumeUploadUrl}?${qs}`,
      { headers: { ...bearer(this.idToken) } },
    );
    const j = JSON.parse(text) as Record<string, unknown>;
    const uploadUrl = j.uploadUrl ?? j.upload_url ?? j.url;
    const importId = j.importId ?? j.import_id ?? j.id;
    const s3Key = j.s3Key ?? j.s3_key ?? j.key;
    if (typeof uploadUrl !== 'string' || typeof importId !== 'string' || typeof s3Key !== 'string') {
      throw new SmokeAssertionError(`resume upload-url incomplete: ${text}`);
    }
    return { uploadUrl, importId, s3Key };
  }

  /** Step 2: raw PUT the bytes to the presigned S3 url. No Authorization
   *  header — the signature is in the url; Content-Type/Length must match
   *  what was signed in step 1. */
  async putResumeBytes(uploadUrl: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.send('PUT', uploadUrl, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(bytes.length),
      },
      body: bytes,
    });
  }

  /** Step 3: tell the admin-api the upload is done so it queues parsing. */
  completeResumeImport(importId: string): Promise<StartResponse> {
    return this.postJson(`${ADMIN_API.routes.resumeComplete}/${importId}/complete`, {});
  }
}
