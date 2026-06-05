/** @format */
import { ADMIN_API, bearer, normaliseStartResponse, type StartResponse } from './admin-api-contract.js';
import { SmokeAssertionError } from './types.js';

type Fetch = typeof fetch;

export interface ResumeUploadTicket {
  uploadUrl: string;
  importId: string;
  s3Key: string;
}

/** Response of POST /api/admin/applications/:slug/coach. The route returns
 *  202 { status:'queued', coachPipelineRunId } on dispatch, 200 { status:'skipped' }
 *  when nothing to do, or 4xx { error } — none of which carry the strategist's
 *  `pipelineRunId`, so this is parsed separately from postJson. */
export interface StartCoachResponse {
  status: string;
  coachPipelineRunId?: string;
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

  /** POST + parse + normalise. Does NOT assert a run id — ingestion is
   *  tracked by repo_sync_state (user+repo), not pipeline_runs, so its
   *  trigger response carries no pipelineRunId/importId. */
  private async postJsonRaw(route: string, body: unknown): Promise<StartResponse> {
    const text = await this.send('POST', `${this.baseUrl}${route}`, {
      headers: { 'content-type': 'application/json', ...bearer(this.idToken) },
      body: JSON.stringify(body),
    });
    try { return normaliseStartResponse(JSON.parse(text) as Record<string, unknown>); }
    catch { throw new SmokeAssertionError(`admin-api ${route} returned non-JSON: ${text}`); }
  }

  private async postJson(route: string, body: unknown): Promise<StartResponse> {
    const res = await this.postJsonRaw(route, body);
    if (!res.pipelineRunId && !res.importId) {
      throw new SmokeAssertionError(`admin-api ${route} returned no run id / import id`);
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

  /** Ingestion returns { status, jobName, repoFullName, ... } with no run
   *  id — progress is tracked in repo_sync_state by user+repo. */
  startIngestion(b: { repoFullName: string }): Promise<StartResponse> {
    return this.postJsonRaw(ADMIN_API.routes.ingestion, b);
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
      // Buffer is a Uint8Array at runtime; wrap to satisfy the node fetch BodyInit type.
      body: new Uint8Array(bytes),
    });
  }

  /** Step 3: tell the admin-api the upload is done so it queues parsing. */
  completeResumeImport(importId: string): Promise<StartResponse> {
    return this.postJson(`${ADMIN_API.routes.resumeComplete}/${importId}/complete`, {});
  }

  /** POST /api/admin/applications/:slug/coach — dispatch a coach run for a stage.
   *  Parses the raw JSON itself (NOT via postJson): the coach response carries
   *  `coachPipelineRunId`, not `pipelineRunId`/`importId`, so postJson's run-id
   *  assertion would wrongly throw. `:slug` is the application id. */
  async startCoach(slug: string, interviewStage: string): Promise<StartCoachResponse> {
    const route = `${ADMIN_API.routes.coach}/${slug}/coach`;
    const text = await this.send('POST', `${this.baseUrl}${route}`, {
      headers: { 'content-type': 'application/json', ...bearer(this.idToken) },
      body: JSON.stringify({ interviewStage }),
    });
    let raw: Record<string, unknown>;
    try { raw = (text ? JSON.parse(text) : {}) as Record<string, unknown>; }
    catch { throw new SmokeAssertionError(`admin-api ${route} returned non-JSON: ${text}`); }
    const status = typeof raw.status === 'string' ? raw.status : '';
    const coachPipelineRunId =
      typeof raw.coachPipelineRunId === 'string' ? raw.coachPipelineRunId : undefined;
    return { status, coachPipelineRunId };
  }

  /** GET /api/admin/applications/:slug/coaching/:stage?applicationId=… */
  async getCoaching(slug: string, stage: string, applicationId: string): Promise<unknown> {
    const url = `${this.baseUrl}${ADMIN_API.routes.coach}/${slug}/coaching/${stage}?applicationId=${encodeURIComponent(applicationId)}`;
    const raw = await this.send('GET', url, { headers: { ...bearer(this.idToken) } });
    return raw ? JSON.parse(raw) : null;
  }
}
