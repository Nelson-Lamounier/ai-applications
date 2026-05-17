/** @format */
/** Real admin-api contract (verified against tucaken-app). All routes are
 *  Cognito-JWT Bearer; userId derives from the JWT sub, never the body. */
const env = (k: string, d: string) => process.env[k]?.trim() || d;

export const ADMIN_API = {
  routes: {
    strategist: env('SMOKE_ROUTE_STRATEGIST', '/api/admin/pipelines/strategist-job'),
    article:    env('SMOKE_ROUTE_ARTICLE',    '/api/admin/pipelines/article-job'), // + /:slug
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

/* ----------------------------------------------------------------------------
 * Temporary compat shims so the pre-existing admin-api-client.ts/.test.ts
 * still COMPILE against the new contract until Group 3 rewrites them.
 * These are not part of the real contract and carry no behaviour change.
 * -------------------------------------------------------------------------- */
export interface StartResponse { pipelineRunId: string; slug?: string }
export function authHeader(t: string): Record<string, string> { return bearer(t); }
