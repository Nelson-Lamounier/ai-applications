/** @format */
/**
 * VALUES OWNED BY THE `tucaken-app` REPO — CONFIRM BEFORE FIRST RUN.
 * Every field is overridable via env so the harness can be wired without
 * code changes once the real values are known. A wrong value fails fast
 * at trigger time, never silently.
 */
export interface StartResponse { pipelineRunId: string; slug?: string }

const env = (k: string, d: string) => process.env[k]?.trim() || d;

export const ADMIN_API = {
  tokenSecretName: env('SMOKE_ADMIN_TOKEN_SECRET', 'admin-api-token'),
  tokenSecretKey: env('SMOKE_ADMIN_TOKEN_KEY', 'token'),
  authScheme: env('SMOKE_ADMIN_AUTH_SCHEME', 'bearer') as 'bearer' | 'x-api-key',
  routes: {
    strategist: env('SMOKE_ROUTE_STRATEGIST', '/api/strategist/analyse'),
    article:    env('SMOKE_ROUTE_ARTICLE',    '/api/articles/generate'),
    import:     env('SMOKE_ROUTE_IMPORT',     '/api/resume/import'),
    ingestion:  env('SMOKE_ROUTE_INGESTION',  '/api/ingestion/sync'),
  },
} as const;

export const CHATBOT_AUTH = {
  jwtSecretName: env('SMOKE_CHATBOT_JWT_SECRET', 'admin-api-token'),
  jwtSecretKey:  env('SMOKE_CHATBOT_JWT_KEY', 'dev-user-jwt'),
} as const;

export function authHeader(token: string): Record<string, string> {
  return ADMIN_API.authScheme === 'bearer'
    ? { Authorization: `Bearer ${token}` }
    : { 'x-api-key': token };
}
