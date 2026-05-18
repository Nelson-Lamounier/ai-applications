/** @format */
/** Real admin-api contract (verified against tucaken-app). All routes are
 *  Cognito-JWT Bearer; userId derives from the JWT sub, never the body. */
const env = (k: string, d: string) => process.env[k]?.trim() || d;

export const ADMIN_API = {
  routes: {
    strategist: env('SMOKE_ROUTE_STRATEGIST', '/api/admin/pipelines/strategist-job'),
    article:    env('SMOKE_ROUTE_ARTICLE',    '/api/admin/pipelines/article-job'), // + /:slug
    // GET (query params: filename, contentType, fileSizeBytes) — not POST.
    resumeUploadUrl: env('SMOKE_ROUTE_RESUME_UPLOAD', '/api/admin/resume-imports/upload-url'),
    resumeComplete:  env('SMOKE_ROUTE_RESUME_COMPLETE', '/api/admin/resume-imports'), // + /:id/complete
    ingestion:  env('SMOKE_ROUTE_INGESTION',  '/api/admin/ingestion/trigger'),
  },
} as const;

/** Cognito config: client id resolved live from k8s secret unless overridden. */
export const COGNITO = {
  region: env('SMOKE_COGNITO_REGION', 'eu-west-1'),
  /** k8s secret (ns admin-api) + keys holding Cognito ids. */
  secretNamespace: env('SMOKE_COGNITO_SECRET_NS', 'admin-api'),
  secretName: env('SMOKE_COGNITO_SECRET', 'admin-api-secrets'),
  clientIdKey: env('SMOKE_COGNITO_CLIENT_ID_KEY', 'COGNITO_CLIENT_ID'),
  /** Optional explicit overrides (skip the k8s lookup if both set). */
  clientIdOverride: process.env.SMOKE_COGNITO_CLIENT_ID?.trim() || undefined,
  username: process.env.SMOKE_COGNITO_USERNAME?.trim() || undefined,
  password: process.env.SMOKE_COGNITO_PASSWORD?.trim() || undefined,
} as const;

export function bearer(idToken: string): Record<string, string> {
  return { Authorization: `Bearer ${idToken}` };
}

/** Pipeline-trigger response. The admin-api (separate tucaken-app repo)
 *  is the source of truth for the id field name; we accept both camel and
 *  snake case so a casing mismatch can never silently break the harness. */
export interface StartResponse {
  pipelineRunId: string;
  applicationId?: string;
  slug?: string;
  importId?: string;
}

/** Normalise the trigger response: read the run id from pipelineRunId |
 *  pipeline_run_id | id, and surface application/import/slug under stable
 *  names regardless of the admin-api's casing. */
export function normaliseStartResponse(raw: Record<string, unknown>): StartResponse {
  const s = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  // Deliberately NOT falling back to raw.id — a generic `id` is often the
  // new application/import id, and treating it as a run id would make the
  // poller wait the full timeout on a row that never exists.
  const pipelineRunId =
    s(raw.pipelineRunId) ?? s(raw.pipeline_run_id) ?? s(raw.runId) ?? '';
  return {
    pipelineRunId,
    applicationId: s(raw.applicationId) ?? s(raw.application_id),
    importId: s(raw.importId) ?? s(raw.import_id),
    slug: s(raw.slug),
  };
}
