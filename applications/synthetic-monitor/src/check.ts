/**
 * @format
 * API-level synthetic monitor for the auth + resume-import workflows.
 *
 * Runs as an in-cluster CronJob. It exercises the real admin-api the same way
 * the UI does, then asserts that Prometheus actually reflects the activity —
 * proving the "Auth — Sign-In / Sign-Up Workflow" and "Resume Import — Upload
 * to Career Entries" dashboards are backed by live, correctly-shaped data.
 *
 * Flow:
 *   1. Cognito USER_PASSWORD_AUTH as a dedicated synthetic user -> id token
 *   2. AUTH check:   GET /api/admin/me, then poll Prometheus until
 *                    auth_provision_total{outcome="returning"} increases
 *   3. RESUME check: upload-url -> PUT fixture to S3 -> /complete -> poll
 *                    /:id/progress to ready_for_review, then poll Prometheus
 *                    for resume_import_runs_total{instance=<importId>},
 *                    a non-zero step_duration, and NO double-scrape series
 *   4. Push synthetic_check_success{workflow=...} (1/0) + duration to
 *      Pushgateway; exit non-zero if any check failed.
 *
 * Every failure path still pushes a 0 so the absence/zero alert can page.
 */
import { readFileSync } from 'node:fs';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { Pushgateway, Registry, Gauge } from 'prom-client';
import { queryInstant, pollUntil } from './prometheus.js';
import {
  sumVector, deltaAtLeast, durationRecorded, hasNoDoubleScrape,
  type CheckResult,
} from './assertions.js';

interface Config {
  adminApiUrl: string;
  prometheusUrl: string;
  pushgatewayUrl: string;
  region: string;
  clientId: string;
  username: string;
  password: string;
  fixturePath: string;
  pollTimeoutMs: number;
  pollIntervalMs: number;
}

function loadConfig(): Config {
  const req = (k: string): string => {
    const v = process.env[k];
    if (!v) throw new Error(`missing required env ${k}`);
    return v;
  };
  return {
    adminApiUrl:    req('ADMIN_API_URL'),
    prometheusUrl:  req('PROMETHEUS_URL'),
    pushgatewayUrl: req('PUSHGATEWAY_URL'),
    region:         process.env['AWS_REGION'] ?? 'eu-west-1',
    clientId:       req('COGNITO_CLIENT_ID'),
    username:       req('SYNTHETIC_USERNAME'),
    password:       req('SYNTHETIC_PASSWORD'),
    fixturePath:    process.env['FIXTURE_PATH'] ?? '/fixtures/sample-resume.pdf',
    pollTimeoutMs:  Number(process.env['POLL_TIMEOUT_MS'] ?? 180_000),
    pollIntervalMs: Number(process.env['POLL_INTERVAL_MS'] ?? 5_000),
  };
}

async function cognitoIdToken(cfg: Config): Promise<string> {
  const client = new CognitoIdentityProviderClient({ region: cfg.region });
  const res = await client.send(new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: cfg.clientId,
    AuthParameters: { USERNAME: cfg.username, PASSWORD: cfg.password },
  }));
  const token = res.AuthenticationResult?.IdToken;
  if (!token) throw new Error('cognito auth returned no IdToken');
  return token;
}

function api(cfg: Config, token: string) {
  return (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${cfg.adminApiUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    });
}

async function runAuthCheck(cfg: Config, token: string): Promise<CheckResult> {
  const expr = 'sum(auth_provision_total{service="admin-api",outcome="returning"})';
  const before = sumVector(await queryInstant(cfg.prometheusUrl, expr));

  const me = await api(cfg, token)('/api/admin/me');
  if (me.status !== 200) return { name: 'auth', ok: false, reason: `/api/admin/me returned ${me.status}` };

  // Poll Prometheus until the returning counter reflects our /me call.
  const { ok } = await pollUntil(
    () => queryInstant(cfg.prometheusUrl, expr).then(sumVector),
    (after) => deltaAtLeast(before, after, 1),
    { timeoutMs: cfg.pollTimeoutMs, intervalMs: cfg.pollIntervalMs },
  );
  return ok
    ? { name: 'auth', ok: true, reason: 'returning counter advanced after /me' }
    : { name: 'auth', ok: false, reason: 'auth_provision_total{returning} did not advance in time' };
}

async function runResumeCheck(cfg: Config, token: string): Promise<CheckResult> {
  const call = api(cfg, token);

  // 1. presigned upload URL
  const uploadRes = await call('/api/admin/resume-imports/upload-url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: 'sample-resume.pdf', contentType: 'application/pdf' }),
  });
  if (uploadRes.status !== 200) return { name: 'resume_import', ok: false, reason: `upload-url ${uploadRes.status}` };
  const { url, importId } = (await uploadRes.json()) as { url: string; importId: string };

  // 2. PUT the fixture to S3 via the presigned URL
  const fixture = readFileSync(cfg.fixturePath);
  const put = await fetch(url, { method: 'PUT', body: fixture, headers: { 'content-type': 'application/pdf' } });
  if (!put.ok) return { name: 'resume_import', ok: false, reason: `s3 PUT ${put.status}` };

  // 3. dispatch the processing Job
  const complete = await call(`/api/admin/resume-imports/${importId}/complete`, { method: 'POST' });
  if (complete.status !== 202) return { name: 'resume_import', ok: false, reason: `/complete ${complete.status}` };

  // 4. poll progress to ready_for_review
  const progress = await pollUntil(
    () => call(`/api/admin/resume-imports/${importId}/progress`).then((r) => r.json() as Promise<{ status: string }>),
    (p) => p.status === 'ready_for_review' || p.status === 'failed',
    { timeoutMs: cfg.pollTimeoutMs, intervalMs: cfg.pollIntervalMs },
  );
  if (!progress.ok || progress.last.status !== 'ready_for_review') {
    return { name: 'resume_import', ok: false, reason: `import did not reach ready_for_review (last=${progress.last?.status})` };
  }

  // 5. assert Prometheus reflects this specific run (poll for scrape lag)
  const runExpr  = `sum(resume_import_runs_total{instance="${importId}"})`;
  const stepExpr = `sum(resume_import_step_duration_seconds_sum{instance="${importId}"})`;
  const dupExpr  = 'resume_import_runs_total{exported_instance!=""}';

  const runOk = await pollUntil(
    () => queryInstant(cfg.prometheusUrl, runExpr).then(sumVector),
    (v) => v !== null && v >= 1,
    { timeoutMs: cfg.pollTimeoutMs, intervalMs: cfg.pollIntervalMs },
  );
  if (!runOk.ok) return { name: 'resume_import', ok: false, reason: 'resume_import_runs_total never appeared for importId' };

  if (!durationRecorded(await queryInstant(cfg.prometheusUrl, stepExpr))) {
    return { name: 'resume_import', ok: false, reason: 'step_duration sum is zero (timer regression)' };
  }
  if (!hasNoDoubleScrape(await queryInstant(cfg.prometheusUrl, dupExpr))) {
    return { name: 'resume_import', ok: false, reason: 'double-scrape detected (exported_instance present)' };
  }
  return { name: 'resume_import', ok: true, reason: 'run, step_duration and label-shape all verified' };
}

async function pushResults(cfg: Config, results: CheckResult[], durationS: number): Promise<void> {
  const registry = new Registry();
  const success = new Gauge({
    name: 'synthetic_check_success',
    help: '1 if the synthetic workflow check passed, 0 otherwise.',
    labelNames: ['workflow'] as const, registers: [registry],
  });
  const duration = new Gauge({
    name: 'synthetic_check_duration_seconds',
    help: 'Wall-clock duration of the synthetic check run.',
    registers: [registry],
  });
  for (const r of results) success.set({ workflow: r.name }, r.ok ? 1 : 0);
  duration.set(durationS);
  const gateway = new Pushgateway(cfg.pushgatewayUrl, { timeout: 5000 }, registry);
  await gateway.pushAdd({ jobName: 'synthetic-monitor', groupings: { instance: 'synthetic-monitor' } });
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const start = Date.now();
  const results: CheckResult[] = [];
  try {
    const token = await cognitoIdToken(cfg);
    results.push(await runAuthCheck(cfg, token));
    results.push(await runResumeCheck(cfg, token));
  } catch (err) {
    results.push({ name: 'auth', ok: false, reason: `fatal: ${(err as Error).message}` });
    results.push({ name: 'resume_import', ok: false, reason: `fatal: ${(err as Error).message}` });
  }

  const durationS = (Date.now() - start) / 1000;
  for (const r of results) {
    process.stdout.write(`${JSON.stringify({ level: r.ok ? 'info' : 'error', event: 'synthetic_check', ...r })}\n`);
  }
  try {
    await pushResults(cfg, results, durationS);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ level: 'error', event: 'synthetic_push_failed', err: (err as Error).message })}\n`);
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

void main();
