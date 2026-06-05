/** @format */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionLogger } from '../logger.js';
import {
  COGNITO,
  resolveCognitoClientId,
  resolveRdsConn,
  mintCognitoJwt,
  startPortForward,
  connectRds,
  resolvePlatformUserId,
  type Endpoints,
  type PortForward,
  type RdsClient,
  SmokeSetupError,
} from '../../../../scripts/smoke/lib/index.js';
import { tool } from './register.js';
import { session, requireAuth } from '../session.js';
import { assertDevTarget, isSelectOnly } from '../guards.js';
import { DEV_TARGET } from '../config.js';

// Forwarded local ports — mirror scripts/smoke-e2e.ts so the tunnels map the
// in-cluster services (svc/pgbouncer:5432, svc/admin-api:3002) to localhost.
const PG_LOCAL_PORT = 15432;
const ADMIN_API_LOCAL_PORT = 13002;
const ADMIN_API_BASE_URL = `http://127.0.0.1:${ADMIN_API_LOCAL_PORT}`;
const PG_HOST = '127.0.0.1';

/** Lazily open (and remember) the pgbouncer port-forward used by SQL reads. */
async function ensureTunnel(): Promise<void> {
  if (session.tunnelStop) return;
  const fwd: PortForward = await startPortForward({
    namespace: 'platform', target: 'svc/pgbouncer',
    localPort: PG_LOCAL_PORT, remotePort: 5432,
  });
  session.tunnelStop = fwd.stop;
}

/** Lazily open (and remember) the admin-api port-forward used by admin-api
 *  calls (smoke_admin_api / run_strategist / run_coach). Mirrors scripts/
 *  smoke-e2e.ts which forwards svc/admin-api:3002 → 127.0.0.1:13002; without
 *  this nothing serves ADMIN_API_BASE_URL and every fetch ECONNREFUSEs. */
async function ensureAdminApiTunnel(): Promise<void> {
  if (session.adminApiTunnelStop) return;
  const fwd: PortForward = await startPortForward({
    namespace: 'admin-api', target: 'svc/admin-api',
    localPort: ADMIN_API_LOCAL_PORT, remotePort: 3002,
  });
  session.adminApiTunnelStop = fwd.stop;
}

/** Lazily resolve the platform `users.id` (by email) the first time a DB
 *  connection is needed, then cache it on the session. smoke_auth stores the
 *  Cognito sub provisionally; the sub is NOT the platform users.id, so all DB
 *  scoping must use the resolved id. Pure smoke_admin_api calls never reach
 *  here, so they don't need the tunnel. */
async function ensurePlatformUserId(endpoints: Endpoints): Promise<string> {
  if (session.platformUserIdResolved && session.testUserId) return session.testUserId;
  if (!session.email) throw new SmokeSetupError('smoke_auth did not capture an email to resolve users.id');
  const platformUserId = await resolvePlatformUserId({
    host: PG_HOST, port: PG_LOCAL_PORT, database: endpoints.pgDatabase,
    user: endpoints.pgUser, password: endpoints.pgPassword, email: session.email,
  });
  session.testUserId = platformUserId;
  session.platformUserIdResolved = true;
  return platformUserId;
}

/** Connect to the forwarded RDS using the resolved credentials + platform user.
 *  Exported as `connectDev` so other tool modules (e.g. system-design) reuse the
 *  one tunnel + lazy users.id + assertDevTarget path instead of duplicating it. */
export async function connectDev(): Promise<RdsClient> { return connectViaTunnel(); }
async function connectViaTunnel(): Promise<RdsClient> {
  const { endpoints } = requireAuth();
  await ensureTunnel();
  assertDevTarget({ account: DEV_TARGET.account, region: DEV_TARGET.region, db: endpoints.pgDatabase });
  const testUserId = await ensurePlatformUserId(endpoints);
  return connectRds({
    host: PG_HOST, port: PG_LOCAL_PORT, database: endpoints.pgDatabase,
    user: endpoints.pgUser, password: endpoints.pgPassword, testUserId,
  });
}

async function handleAuth(): Promise<{ authed: true; cognitoSub: string; email: string; db: string }> {
  // Read creds from process.env at CALL time (not the import-time COGNITO
  // constant) — .env.smoke is hydrated by loadEnvSmoke() in the bootstrap,
  // which runs before any tool is invoked but after COGNITO was evaluated.
  const username = process.env.SMOKE_COGNITO_USERNAME?.trim() || COGNITO.username;
  const password = process.env.SMOKE_COGNITO_PASSWORD?.trim() || COGNITO.password;
  const region   = process.env.SMOKE_COGNITO_REGION?.trim() || COGNITO.region;
  if (!username || !password) {
    throw new SmokeSetupError('SMOKE_COGNITO_USERNAME / SMOKE_COGNITO_PASSWORD are required');
  }
  const [clientId, rds] = await Promise.all([resolveCognitoClientId(), resolveRdsConn()]);
  const { idToken, sub, email } = await mintCognitoJwt({ clientId, username, password, region });
  // The platform users.id is resolved lazily (by email) on the first DB
  // connection — smoke_auth intentionally does not open the tunnel. The
  // Cognito sub is stored provisionally only so requireAuth() is satisfied.
  const testEmail = email ?? username;
  assertDevTarget({ account: DEV_TARGET.account, region: DEV_TARGET.region, db: rds.database });
  const endpoints: Endpoints = {
    adminApiBaseUrl: ADMIN_API_BASE_URL,
    cognitoIdToken: idToken,
    cognitoSub: sub,
    chatbotUrl: '', chatbotPublicUrl: '', chatbotAuthenticatedUrl: '',
    chatbotApiKey: null,
    pgPassword: rds.password, pgHost: PG_HOST, pgPort: PG_LOCAL_PORT,
    pgDatabase: rds.database, pgUser: rds.user,
  };
  session.idToken = idToken;
  session.cognitoSub = sub;
  session.email = testEmail;
  // Provisional only so requireAuth() passes; upgraded to the real platform
  // users.id by ensurePlatformUserId() on the first DB connection.
  session.testUserId = sub;
  session.platformUserIdResolved = false;
  session.endpoints = endpoints;
  // Open the admin-api tunnel now so admin-api calls (run_strategist/run_coach/
  // smoke_admin_api) have something serving ADMIN_API_BASE_URL.
  await ensureAdminApiTunnel();
  return { authed: true, cognitoSub: sub, email: testEmail, db: rds.database };
}

async function handleAdminApi(args: {
  method: string; path: string; body?: Record<string, unknown>;
}): Promise<{ status: number; body: unknown }> {
  const { endpoints, idToken } = requireAuth();
  // Ensure the admin-api tunnel is up even if no pipeline tool ran first.
  await ensureAdminApiTunnel();
  const init: RequestInit = {
    method: args.method,
    headers: { Authorization: `Bearer ${idToken}`, 'content-type': 'application/json' },
  };
  if (args.body !== undefined) init.body = JSON.stringify(args.body);
  const res = await fetch(`${endpoints.adminApiBaseUrl}${args.path}`, init);
  const text = await res.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }
  return { status: res.status, body };
}

async function handleSql(args: { sql: string; params?: unknown[] }): Promise<{ rows: unknown[] }> {
  if (!isSelectOnly(args.sql)) throw new SmokeSetupError('smoke_sql accepts a single SELECT/WITH statement only');
  const client = await connectViaTunnel();
  try {
    const rows = await client.maybeRows(args.sql, args.params ?? []);
    return { rows };
  } finally {
    await client.close();
  }
}

async function handleWaitPipeline(args: {
  pipelineRunId: string; timeoutMs?: number;
}): Promise<{ status: string }> {
  const client = await connectViaTunnel();
  try {
    const status = await client.waitForPipelineStatus(args.pipelineRunId, args.timeoutMs ?? 600000, 5000);
    return { status };
  } finally {
    await client.close();
  }
}

/** Tail logs of transient coach/strategist Job pods in the job-strategist
 *  namespace via kubectl (dev profile). Fail-soft: any kubectl/no-pod error
 *  yields a friendly message instead of throwing. The AWS Labs eks MCP is the
 *  richer alternative; this is the built-in fallback. */
async function handleJobLogs(args: {
  label?: string; runId?: string;
}): Promise<{ pods: string; logs: string }> {
  const sel = args.label ?? (args.runId ? `run-id=${args.runId}` : '');
  const { execFileSync } = await import('node:child_process');
  const env = { ...process.env, AWS_PROFILE: 'dev-account', AWS_REGION: DEV_TARGET.region };
  const get = (kArgs: string[]): string => execFileSync('kubectl', kArgs, { env, encoding: 'utf-8' });
  try {
    const podArgs = ['get', 'pods', '-n', 'job-strategist', ...(sel ? ['-l', sel] : []), '-o', 'name'];
    const pods = get(podArgs).trim();
    if (!pods) return { pods: '(none)', logs: '(no pods — Job may be TTL-cleaned)' };
    const logs = pods.split('\n')
      .map((p) => get(['logs', '-n', 'job-strategist', p, '--tail', '200']))
      .join('\n---\n');
    return { pods, logs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { pods: '(none)', logs: `(no pods or kubectl error: ${msg})` };
  }
}

async function handleCleanup(): Promise<{ removed: number }> {
  const targets = session.cleanup;
  let removed = 0;
  if (targets.length > 0) {
    const client = await connectViaTunnel();
    try {
      for (const t of targets) { await client.cleanupRun(t); removed += 1; }
    } finally {
      await client.close();
    }
  }
  session.cleanup = [];
  if (session.tunnelStop) { session.tunnelStop(); session.tunnelStop = undefined; }
  if (session.adminApiTunnelStop) { session.adminApiTunnelStop(); session.adminApiTunnelStop = undefined; }
  return { removed };
}

export function registerPrimitives(server: McpServer, logger: SessionLogger): void {
  tool(server, logger, 'smoke_auth', {}, () => handleAuth());

  tool(server, logger, 'smoke_admin_api', {
    method: z.string(), path: z.string(), body: z.record(z.unknown()).optional(),
  }, (args) => handleAdminApi(args as { method: string; path: string; body?: Record<string, unknown> }));

  tool(server, logger, 'smoke_sql', {
    sql: z.string(), params: z.array(z.unknown()).optional(),
  }, (args) => handleSql(args as { sql: string; params?: unknown[] }));

  tool(server, logger, 'smoke_wait_pipeline', {
    pipelineRunId: z.string(), timeoutMs: z.number().optional(),
  }, (args) => handleWaitPipeline(args as { pipelineRunId: string; timeoutMs?: number }));

  tool(server, logger, 'smoke_job_logs', {
    label: z.string().optional(), runId: z.string().optional(),
  }, (args) => handleJobLogs(args));

  tool(server, logger, 'smoke_cleanup', {}, () => handleCleanup());
}
