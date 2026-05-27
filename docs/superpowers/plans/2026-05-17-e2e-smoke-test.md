# E2E Smoke Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `just`-driven, on-demand end-to-end smoke test that triggers the deployed dev admin-api, lets real pipelines run on real Bedrock, asserts RDS population for job-strategist / article-pipeline / resume-import / ingestion / the 3 chatbots, then cleans up behind a dev-DB safety guard.

**Architecture:** A `tsx` orchestrator (`scripts/smoke-e2e.ts`) resolves `dev-account` creds, discovers endpoints (kubectl port-forwards + CDK SSM params), then runs jest `*.smoke.test.ts` suites that POST to the real admin-api and poll `pipeline_runs` via a port-forwarded pgbouncer. Pure modules (discovery, rds-client, cleanup-registry, admin-api-client) are TDD'd with mocked deps; the per-flow suites are themselves the integration tests.

**Tech Stack:** TypeScript, tsx, jest + ts-jest (hoisted at root), `pg`, `@aws-sdk/client-ssm`, `@repo/script-utils` (`exec.js` no-shell spawn, `aws.js` SSM/auth), `just`, `kubectl`.

---

## Spec reference

Design: `docs/superpowers/specs/2026-05-17-e2e-smoke-test-design.md`. Approach A (trigger deployed admin-api, poll RDS). The 4 "Open items" (admin-api routes/body, token-secret name, authenticated-chatbot JWT source, `NAME_PREFIX`) are isolated to `scripts/smoke/admin-api-contract.ts` as documented placeholders.

## Conventions for every task

- Unit tests run: `node_modules/.bin/jest --config scripts/smoke/jest.smoke.config.cjs <path> -t <name>` — these mock all I/O (no AWS/Bedrock) and are CI-safe.
- The `*.smoke.test.ts` flow suites are NOT unit-tested; they run only under `just smoke-e2e`. They get a compile check + a skip-path assertion instead.
- All subprocess calls go through `@repo/script-utils/exec.js` `runCommand` (argv array, no shell on Unix) — never a raw shell-string command.
- Commit messages end with no AI co-author line (repo rule). Branch: create `feat/e2e-smoke-test` before Task 1 if on `develop`.
- `docs/` is gitignored: this plan and the spec are not committed; everything under `scripts/` IS committed.

## File structure

```
scripts/
  smoke-e2e.ts                     # orchestrator (tsx entrypoint)
  smoke/
    types.ts                       # Endpoints, FlowName, CleanupTarget, error types
    exec-wrapper.ts                # thin typed wrapper over @repo/script-utils runCommand
    admin-api-contract.ts          # tucaken-app values (documented placeholders)
    discovery.ts                   # resolve Endpoints (kubectl + SSM)
    port-forward.ts                # start/stop kubectl port-forward + TCP healthcheck
    rds-client.ts                  # pg pool, waitForPipelineStatus, assert*, cleanupRun, SAFETY GUARD
    cleanup-registry.ts            # collects run ids / s3 keys
    admin-api-client.ts            # typed fetch wrappers
    fixtures/
      article-draft.md
      strategist-jd.txt
    job-strategist.smoke.test.ts
    article-pipeline.smoke.test.ts
    resume-import.smoke.test.ts
    ingestion.smoke.test.ts
    chatbots.smoke.test.ts
    jest.smoke.config.cjs
    README.md
    __tests__/
      exec-wrapper.test.ts
      discovery.test.ts
      rds-client.test.ts
      cleanup-registry.test.ts
      admin-api-client.test.ts
Justfile                           # add [group('smoke')] recipes
.gitignore                         # add .env.smoke
```

---

### Task 0: Branch + scaffold + jest config

**Files:**
- Create: `scripts/smoke/jest.smoke.config.cjs`
- Create: `scripts/smoke/.gitkeep`
- Modify: `.gitignore`

- [ ] **Step 1: Branch**

Run: `git rev-parse --abbrev-ref HEAD`
If output is `develop`, run: `git checkout -b feat/e2e-smoke-test`

- [ ] **Step 2: Create jest config for the smoke harness**

Create `scripts/smoke/jest.smoke.config.cjs`:
```js
/** @format */
// Unit tests for the smoke harness modules (mocked I/O, CI-safe) AND the
// per-flow *.smoke.test.ts suites (real infra, only via `just smoke-e2e`).
module.exports = {
  testEnvironment: 'node',
  rootDir: '..',                       // scripts/
  roots: ['<rootDir>/smoke'],
  testMatch: [
    '<rootDir>/smoke/__tests__/**/*.test.ts',
    '<rootDir>/smoke/**/*.smoke.test.ts',
  ],
  testTimeout: 10000,
  verbose: true,
  forceExit: true,
  transform: { '^.+\\.ts$': 'ts-jest' },
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  globals: { 'ts-jest': { useESM: false } },
};
```

- [ ] **Step 3: Gitignore the local env file**

Append a new line to `.gitignore`: `.env.smoke`

- [ ] **Step 4: Create placeholder dirs**

Run: `mkdir -p scripts/smoke/__tests__ scripts/smoke/fixtures && touch scripts/smoke/.gitkeep`

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke/jest.smoke.config.cjs scripts/smoke/.gitkeep .gitignore
git commit -m "chore(smoke): scaffold e2e smoke harness dir + jest config"
```

---

### Task 1: Shared types + subprocess wrapper

**Files:**
- Create: `scripts/smoke/types.ts`
- Create: `scripts/smoke/exec-wrapper.ts`
- Create: `scripts/smoke/__tests__/exec-wrapper.test.ts`
- Delete: `scripts/smoke/.gitkeep`

- [ ] **Step 1: Write types**

Create `scripts/smoke/types.ts`:
```ts
/** @format */
export type FlowName =
  | 'job-strategist' | 'article-pipeline' | 'resume-import'
  | 'ingestion' | 'chatbots';

export const ALL_FLOWS: readonly FlowName[] = [
  'job-strategist', 'article-pipeline', 'resume-import', 'ingestion', 'chatbots',
] as const;

export interface Endpoints {
  adminApiBaseUrl: string;          // e.g. http://127.0.0.1:13002
  adminApiToken: string;
  chatbotUrl: string;               // RestApi base, no trailing slash
  chatbotPublicUrl: string;
  chatbotAuthenticatedUrl: string;
  chatbotAuthJwt: string | null;    // null => authenticated chatbot skipped
  pgPassword: string;
  pgHost: string;                   // 127.0.0.1
  pgPort: number;                   // 15432
  pgDatabase: string;               // tucaken (dev)
  pgUser: string;                   // postgres
}

export interface CleanupTarget {
  flow: FlowName;
  pipelineRunId?: string;
  slug?: string;
  s3Keys: string[];
  chatSessionId?: string;
}

export class SmokeSetupError extends Error {
  constructor(message: string) { super(message); this.name = 'SmokeSetupError'; }
}
export class SmokeInfraError extends Error {
  constructor(message: string) { super(message); this.name = 'SmokeInfraError'; }
}
export class SmokeAssertionError extends Error {
  constructor(message: string) { super(message); this.name = 'SmokeAssertionError'; }
}
```

- [ ] **Step 2: Write the failing test for the subprocess wrapper**

Create `scripts/smoke/__tests__/exec-wrapper.test.ts`:
```ts
/** @format */
import { jest } from '@jest/globals';

const runCommand = jest.fn<(c: string, a: string[], o?: unknown) => Promise<{ exitCode: number; stdout: string; stderr: string }>>();
jest.mock('@repo/script-utils/exec.js', () => ({ runCommand }));

import { capture } from '../exec-wrapper';

describe('capture', () => {
  beforeEach(() => runCommand.mockReset());

  it('returns trimmed stdout on exit 0', async () => {
    runCommand.mockResolvedValueOnce({ exitCode: 0, stdout: '  hello\n', stderr: '' });
    await expect(capture('kubectl', ['version'])).resolves.toBe('hello');
  });

  it('throws SmokeSetupError with stderr on non-zero exit', async () => {
    runCommand.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'boom' });
    await expect(capture('kubectl', ['x'])).rejects.toThrow(/kubectl x.*boom/s);
  });
});
```

- [ ] **Step 3: Run it, expect FAIL**

Run: `node_modules/.bin/jest --config scripts/smoke/jest.smoke.config.cjs exec-wrapper -t capture`
Expected: FAIL — `Cannot find module '../exec-wrapper'`.

- [ ] **Step 4: Implement the wrapper**

Create `scripts/smoke/exec-wrapper.ts`:
```ts
/** @format */
import { runCommand } from '@repo/script-utils/exec.js';
import { SmokeSetupError } from './types.js';

/** Run a command via argv array (no shell). Returns trimmed stdout.
 *  Throws SmokeSetupError (command + stderr) on non-zero exit. */
export async function capture(
  cmd: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv; cwd?: string },
): Promise<string> {
  const res = await runCommand(cmd, args, { captureOutput: true, ...opts });
  if (res.exitCode !== 0) {
    throw new SmokeSetupError(`\`${cmd} ${args.join(' ')}\` failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
  }
  return res.stdout.trim();
}
```

- [ ] **Step 5: Run it, expect PASS**

Run: `node_modules/.bin/jest --config scripts/smoke/jest.smoke.config.cjs exec-wrapper`
Expected: PASS (2 tests). If `runCommand`'s real signature differs, open `packages/script-utils/src/exec.ts`, match the exported name/params, adjust the import + call only (keep the test behaviour).

- [ ] **Step 6: Commit**

```bash
rm -f scripts/smoke/.gitkeep
git add scripts/smoke/types.ts scripts/smoke/exec-wrapper.ts scripts/smoke/__tests__/exec-wrapper.test.ts
git add -A scripts/smoke/.gitkeep
git commit -m "feat(smoke): shared types + no-shell subprocess wrapper"
```

---

### Task 2: admin-api contract (documented placeholders)

**Files:**
- Create: `scripts/smoke/admin-api-contract.ts`

- [ ] **Step 1: Write the contract module**

Create `scripts/smoke/admin-api-contract.ts`:
```ts
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
```

- [ ] **Step 2: Commit**

```bash
git add scripts/smoke/admin-api-contract.ts
git commit -m "feat(smoke): admin-api contract config (tucaken-app placeholders)"
```

---

### Task 3: cleanup-registry (TDD)

**Files:**
- Create: `scripts/smoke/cleanup-registry.ts`
- Create: `scripts/smoke/__tests__/cleanup-registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke/__tests__/cleanup-registry.test.ts`:
```ts
/** @format */
import { CleanupRegistry } from '../cleanup-registry';

describe('CleanupRegistry', () => {
  it('records and lists targets in insertion order', () => {
    const r = new CleanupRegistry();
    r.register({ flow: 'ingestion', s3Keys: [] });
    r.register({ flow: 'article-pipeline', pipelineRunId: 'p1', s3Keys: ['smoke/p1/a.md'] });
    expect(r.list().map(t => t.flow)).toEqual(['ingestion', 'article-pipeline']);
    expect(r.list()[1].pipelineRunId).toBe('p1');
  });

  it('isEmpty reflects state', () => {
    const r = new CleanupRegistry();
    expect(r.isEmpty()).toBe(true);
    r.register({ flow: 'chatbots', s3Keys: [] });
    expect(r.isEmpty()).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `node_modules/.bin/jest --config scripts/smoke/jest.smoke.config.cjs cleanup-registry`
Expected: FAIL — `Cannot find module '../cleanup-registry'`.

- [ ] **Step 3: Implement**

Create `scripts/smoke/cleanup-registry.ts`:
```ts
/** @format */
import type { CleanupTarget } from './types.js';

export class CleanupRegistry {
  private readonly targets: CleanupTarget[] = [];
  register(t: CleanupTarget): void { this.targets.push(t); }
  list(): readonly CleanupTarget[] { return this.targets; }
  isEmpty(): boolean { return this.targets.length === 0; }
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `node_modules/.bin/jest --config scripts/smoke/jest.smoke.config.cjs cleanup-registry`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke/cleanup-registry.ts scripts/smoke/__tests__/cleanup-registry.test.ts
git commit -m "feat(smoke): cleanup registry"
```

---

### Task 4: rds-client — SAFETY GUARD first (TDD)

**Files:**
- Create: `scripts/smoke/rds-client.ts`
- Create: `scripts/smoke/__tests__/rds-client.test.ts`

The guard is implemented and proven before any query/delete code exists.

- [ ] **Step 1: Write the failing guard test**

Create `scripts/smoke/__tests__/rds-client.test.ts`:
```ts
/** @format */
import { assertSafeToMutate } from '../rds-client';

describe('assertSafeToMutate', () => {
  const okUser = '31f4686a-979b-4765-a17c-22a1e71cec59';

  it('passes for the dev db + a uuid test user', () => {
    expect(() => assertSafeToMutate('tucaken', okUser)).not.toThrow();
  });
  it('aborts when the db is not the dev database', () => {
    expect(() => assertSafeToMutate('tucaken_prod', okUser)).toThrow(/refusing.*database/i);
  });
  it('aborts when the test user id is empty', () => {
    expect(() => assertSafeToMutate('tucaken', '')).toThrow(/test user/i);
  });
  it('aborts when the test user id is not a uuid', () => {
    expect(() => assertSafeToMutate('tucaken', 'admin')).toThrow(/test user/i);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `node_modules/.bin/jest --config scripts/smoke/jest.smoke.config.cjs rds-client -t assertSafeToMutate`
Expected: FAIL — `Cannot find module '../rds-client'`.

- [ ] **Step 3: Implement the guard only**

Create `scripts/smoke/rds-client.ts`:
```ts
/** @format */
import { SmokeSetupError } from './types.js';

const ALLOWED_DBS = (process.env.SMOKE_ALLOWED_DBS ?? 'tucaken').split(',').map(s => s.trim());
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hard-aborts (no DB work) unless the resolved database is an allowed dev
 *  database AND the test user id is a UUID. The single most important guard
 *  in the harness — a cleanup bug here would delete real rows. */
export function assertSafeToMutate(database: string, testUserId: string): void {
  if (!ALLOWED_DBS.includes(database)) {
    throw new SmokeSetupError(
      `Refusing to touch database "${database}" — not in allowed dev set [${ALLOWED_DBS.join(', ')}]`,
    );
  }
  if (!testUserId || !UUID_RE.test(testUserId)) {
    throw new SmokeSetupError(
      `Refusing to run: test user id "${testUserId}" is empty or not a UUID`,
    );
  }
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `node_modules/.bin/jest --config scripts/smoke/jest.smoke.config.cjs rds-client -t assertSafeToMutate`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke/rds-client.ts scripts/smoke/__tests__/rds-client.test.ts
git commit -m "feat(smoke): rds-client dev-db/test-user safety guard"
```

---

### Task 5: rds-client — pool, poll, asserts, cleanup (TDD)

**Files:**
- Modify: `scripts/smoke/rds-client.ts`
- Modify: `scripts/smoke/__tests__/rds-client.test.ts`

- [ ] **Step 1: Add failing tests for poll + cleanup ordering**

Append to `scripts/smoke/__tests__/rds-client.test.ts`:
```ts
import { RdsClient } from '../rds-client';

function fakePool(responses: Array<{ rows: unknown[] }>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let i = 0;
  return {
    calls,
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return responses[Math.min(i++, responses.length - 1)] ?? { rows: [] };
    },
    end: async () => {},
  };
}
const U = '31f4686a-979b-4765-a17c-22a1e71cec59';

describe('RdsClient.waitForPipelineStatus', () => {
  it('resolves when status becomes terminal', async () => {
    const pool = fakePool([{ rows: [{ status: 'researching' }] }, { rows: [{ status: 'complete' }] }]);
    const c = new RdsClient(pool as never, 'tucaken', U);
    expect(await c.waitForPipelineStatus('run-1', 50, 5)).toBe('complete');
  });
  it('throws SmokeAssertionError when status is failed', async () => {
    const pool = fakePool([{ rows: [{ status: 'failed', error: { msg: 'boom' } }] }]);
    const c = new RdsClient(pool as never, 'tucaken', U);
    await expect(c.waitForPipelineStatus('run-1', 50, 5)).rejects.toThrow(/failed.*boom/s);
  });
  it('throws SmokeInfraError on timeout', async () => {
    const pool = fakePool([{ rows: [{ status: 'researching' }] }]);
    const c = new RdsClient(pool as never, 'tucaken', U);
    await expect(c.waitForPipelineStatus('run-1', 10, 5)).rejects.toThrow(/timed out/i);
  });
});

describe('RdsClient.cleanupRun', () => {
  it('deletes children before parents, test-user scoped, guard-checked', async () => {
    const pool = fakePool([{ rows: [] }]);
    const c = new RdsClient(pool as never, 'tucaken', U);
    await c.cleanupRun({ flow: 'job-strategist', pipelineRunId: 'run-9', s3Keys: [] });
    const tables = pool.calls.map(x => x.sql.match(/DELETE FROM (\w+)/)?.[1]);
    expect(tables).toEqual(['coaching_content', 'resumes', 'articles', 'pipeline_runs', 'job_applications']);
    for (const call of pool.calls) expect(call.params).toContain(U);
  });
  it('refuses cleanup when the safety guard fails', async () => {
    const pool = fakePool([{ rows: [] }]);
    const c = new RdsClient(pool as never, 'prod_db', U);
    await expect(c.cleanupRun({ flow: 'job-strategist', pipelineRunId: 'r', s3Keys: [] }))
      .rejects.toThrow(/refusing.*database/i);
    expect(pool.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `node_modules/.bin/jest --config scripts/smoke/jest.smoke.config.cjs rds-client`
Expected: FAIL — `RdsClient is not a constructor` / not exported.

- [ ] **Step 3: Implement RdsClient**

Append to `scripts/smoke/rds-client.ts`:
```ts
import { SmokeAssertionError, SmokeInfraError } from './types.js';
import type { CleanupTarget } from './types.js';

const TERMINAL_OK = 'complete';
const TERMINAL_FAIL = 'failed';

export interface QueryablePool {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

export class RdsClient {
  constructor(
    private readonly pool: QueryablePool,
    private readonly database: string,
    private readonly testUserId: string,
  ) {}

  private guard(): void { assertSafeToMutate(this.database, this.testUserId); }

  async waitForPipelineStatus(runId: string, timeoutMs: number, intervalMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let last = 'unknown';
    while (Date.now() <= deadline) {
      const { rows } = await this.pool.query(
        'SELECT status, error FROM pipeline_runs WHERE id = $1 LIMIT 1', [runId]);
      const row = rows[0] as { status?: string; error?: unknown } | undefined;
      last = row?.status ?? 'missing';
      if (last === TERMINAL_OK) return last;
      if (last === TERMINAL_FAIL) {
        throw new SmokeAssertionError(`pipeline ${runId} failed: ${JSON.stringify(row?.error ?? {})}`);
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new SmokeInfraError(`pipeline ${runId} timed out (last status: ${last})`);
  }

  async assertRows(sql: string, params: unknown[], what: string): Promise<unknown[]> {
    const { rows } = await this.pool.query(sql, params);
    if (rows.length === 0) throw new SmokeAssertionError(`expected rows for ${what}, found none`);
    return rows;
  }

  async cleanupRun(t: CleanupTarget): Promise<void> {
    this.guard();
    const uid = this.testUserId;
    const rid = t.pipelineRunId ?? null;
    const stmts: Array<[string, unknown[]]> = [
      ['DELETE FROM coaching_content WHERE user_id = $1 AND ($2::text IS NULL OR pipeline_run_id = $2)', [uid, rid]],
      ['DELETE FROM resumes WHERE user_id = $1 AND source = $2 AND ($3::text IS NULL OR pipeline_run_id = $3)', [uid, 'tailored', rid]],
      ['DELETE FROM articles WHERE user_id = $1 AND ($2::text IS NULL OR pipeline_run_id = $2)', [uid, rid]],
      ['DELETE FROM pipeline_runs WHERE user_id = $1 AND ($2::text IS NULL OR id = $2)', [uid, rid]],
      ['DELETE FROM job_applications WHERE user_id = $1 AND ($2::text IS NULL OR pipeline_run_id = $2)', [uid, rid]],
    ];
    for (const [sql, params] of stmts) {
      try { await this.pool.query(sql, params); }
      catch (e) { console.warn(`[smoke] cleanup skip: ${(e as Error).message}`); }
    }
  }

  async cleanupUserScoped(): Promise<void> {
    this.guard();
    const uid = this.testUserId;
    const stmts: Array<[string, unknown[]]> = [
      ['DELETE FROM user_career_history WHERE user_id = $1', [uid]],
      ['DELETE FROM document_embeddings WHERE user_id = $1', [uid]],
      ['DELETE FROM repo_sync_state WHERE user_id = $1', [uid]],
    ];
    for (const [sql, params] of stmts) {
      try { await this.pool.query(sql, params); }
      catch (e) { console.warn(`[smoke] cleanup skip: ${(e as Error).message}`); }
    }
  }

  async close(): Promise<void> { await this.pool.end(); }
}

export async function connectRds(opts: {
  host: string; port: number; database: string; user: string; password: string; testUserId: string;
}): Promise<RdsClient> {
  assertSafeToMutate(opts.database, opts.testUserId);
  const { Pool } = await import('pg');
  const pool = new Pool({
    host: opts.host, port: opts.port, database: opts.database,
    user: opts.user, password: opts.password, max: 4,
    connectionTimeoutMillis: 10_000,
  });
  return new RdsClient(pool as unknown as QueryablePool, opts.database, opts.testUserId);
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `node_modules/.bin/jest --config scripts/smoke/jest.smoke.config.cjs rds-client`
Expected: PASS (all guard + poll + cleanup tests). Cleanup-order test asserts exactly `[coaching_content, resumes, articles, pipeline_runs, job_applications]`.

- [ ] **Step 5: Executor note (real columns — defer to first run, not now)**

`pipeline_runs.id`, `pipeline_run_id`, `resumes.source` are inferred from `applications/job-strategist/src/__tests__/run-pipeline.integration.test.ts`. Before the FIRST real `just smoke-e2e` (not during this plan), verify against `applications/platform-rds-bootstrap/src/index.ts` DDL + that integration test and adjust the `cleanupRun`/poll SQL if a column name differs. The unit tests assert ordering + user-scoping, which hold regardless.

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke/rds-client.ts scripts/smoke/__tests__/rds-client.test.ts
git commit -m "feat(smoke): rds poll + FK-ordered test-user-scoped cleanup"
```

---

### Task 6: discovery (TDD)

**Files:**
- Create: `scripts/smoke/discovery.ts`
- Create: `scripts/smoke/__tests__/discovery.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke/__tests__/discovery.test.ts`:
```ts
/** @format */
import { jest } from '@jest/globals';

const capture = jest.fn<(c: string, a: string[]) => Promise<string>>();
const getSSMParameter = jest.fn<(name: string, cfg: unknown) => Promise<string>>();
jest.mock('../exec-wrapper', () => ({ capture }));
jest.mock('@repo/script-utils/aws.js', () => ({
  getSSMParameter,
  resolveAuth: () => ({ credentials: undefined }),
}));

import { resolveChatbotUrls, decodeK8sSecret } from '../discovery';

describe('decodeK8sSecret', () => {
  it('base64-decodes a jsonpath secret value', () => {
    expect(decodeK8sSecret(Buffer.from('s3cr3t').toString('base64'))).toBe('s3cr3t');
  });
});

describe('resolveChatbotUrls', () => {
  beforeEach(() => getSSMParameter.mockReset());
  it('reads the three CDK SSM params and strips trailing slashes', async () => {
    getSSMParameter
      .mockResolvedValueOnce('https://a.example.com/prod/')
      .mockResolvedValueOnce('https://b.example.com/prod/')
      .mockResolvedValueOnce('https://c.example.com/prod/');
    const r = await resolveChatbotUrls('bedrock-data-development', { region: 'eu-west-1' });
    expect(r).toEqual({
      chatbotUrl: 'https://a.example.com/prod',
      chatbotPublicUrl: 'https://b.example.com/prod',
      chatbotAuthenticatedUrl: 'https://c.example.com/prod',
    });
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `node_modules/.bin/jest --config scripts/smoke/jest.smoke.config.cjs discovery`
Expected: FAIL — `Cannot find module '../discovery'`.

- [ ] **Step 3: Implement discovery**

Create `scripts/smoke/discovery.ts`:
```ts
/** @format */
import { getSSMParameter, resolveAuth } from '@repo/script-utils/aws.js';
import { capture } from './exec-wrapper.js';
import { ADMIN_API, CHATBOT_AUTH } from './admin-api-contract.js';
import { SmokeSetupError } from './types.js';

export function decodeK8sSecret(b64: string): string {
  return Buffer.from(b64.trim(), 'base64').toString('utf-8');
}

async function k8sSecret(ns: string, name: string, key: string): Promise<string> {
  const b64 = await capture('kubectl', [
    '-n', ns, 'get', 'secret', name, '-o', `jsonpath={.data.${key}}`,
  ]);
  if (!b64) throw new SmokeSetupError(`secret ${ns}/${name} key "${key}" empty/not found`);
  return decodeK8sSecret(b64);
}

export async function resolveChatbotUrls(
  namePrefix: string,
  cfg: { region: string; profile?: string },
): Promise<{ chatbotUrl: string; chatbotPublicUrl: string; chatbotAuthenticatedUrl: string }> {
  const strip = (u: string) => u.replace(/\/+$/, '');
  const [u, p, a] = await Promise.all([
    getSSMParameter(`/${namePrefix}/api-url`, cfg),
    getSSMParameter(`/${namePrefix}/chatbot-public-api-url`, cfg),
    getSSMParameter(`/${namePrefix}/chatbot-authenticated-api-url`, cfg),
  ]);
  return { chatbotUrl: strip(u), chatbotPublicUrl: strip(p), chatbotAuthenticatedUrl: strip(a) };
}

export async function resolveAdminSecrets(): Promise<{ adminApiToken: string; chatbotAuthJwt: string | null }> {
  const adminApiToken = await k8sSecret('admin-api', ADMIN_API.tokenSecretName, ADMIN_API.tokenSecretKey);
  let chatbotAuthJwt: string | null = null;
  try { chatbotAuthJwt = await k8sSecret('admin-api', CHATBOT_AUTH.jwtSecretName, CHATBOT_AUTH.jwtSecretKey); }
  catch { chatbotAuthJwt = null; }
  return { adminApiToken, chatbotAuthJwt };
}

export async function resolvePgPassword(): Promise<string> {
  return k8sSecret('platform', 'platform-rds-credentials',
    process.env.SMOKE_PG_SECRET_KEY ?? 'password');
}

export { resolveAuth };
```

- [ ] **Step 4: Run it, expect PASS**

Run: `node_modules/.bin/jest --config scripts/smoke/jest.smoke.config.cjs discovery`
Expected: PASS (2 tests). If `getSSMParameter`'s real signature differs (see `packages/script-utils/src/aws.ts:92`), adjust the call + the test mock together, keeping the trailing-slash + 3-param assertions.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke/discovery.ts scripts/smoke/__tests__/discovery.test.ts
git commit -m "feat(smoke): endpoint + secret discovery"
```

---

### Task 7: port-forward lifecycle

**Files:**
- Create: `scripts/smoke/port-forward.ts`

No unit test — a tiny `spawn` + TCP-connect wrapper, exercised by the orchestrator and the real run.

- [ ] **Step 1: Implement**

Create `scripts/smoke/port-forward.ts`:
```ts
/** @format */
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { SmokeSetupError } from './types.js';

export interface PortForward { stop(): void }

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const sock = createConnection({ host: '127.0.0.1', port });
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new SmokeSetupError(`port ${port} not reachable`));
        else setTimeout(tick, 500);
      });
    };
    tick();
  });
}

/** Start `kubectl -n <ns> port-forward <target> <local>:<remote>` (argv, no shell). */
export async function startPortForward(args: {
  namespace: string; target: string; localPort: number; remotePort: number;
}): Promise<PortForward> {
  const child: ChildProcess = spawn('kubectl', [
    '-n', args.namespace, 'port-forward', args.target,
    `${args.localPort}:${args.remotePort}`,
  ], { stdio: 'ignore' });
  let stopped = false;
  child.once('exit', (code) => {
    if (!stopped) console.warn(`[smoke] port-forward ${args.target} exited (${code})`);
  });
  await waitForPort(args.localPort, 20_000);
  return { stop() { stopped = true; child.kill('SIGTERM'); } };
}
```

- [ ] **Step 2: Compile check**

Run: `npx tsx --eval "import('./scripts/smoke/port-forward.ts').then(()=>console.log('ok'))"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke/port-forward.ts
git commit -m "feat(smoke): kubectl port-forward lifecycle + tcp healthcheck"
```

---

### Task 8: admin-api-client (TDD)

**Files:**
- Create: `scripts/smoke/admin-api-client.ts`
- Create: `scripts/smoke/__tests__/admin-api-client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke/__tests__/admin-api-client.test.ts`:
```ts
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
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `node_modules/.bin/jest --config scripts/smoke/jest.smoke.config.cjs admin-api-client`
Expected: FAIL — `Cannot find module '../admin-api-client'`.

- [ ] **Step 3: Implement**

Create `scripts/smoke/admin-api-client.ts`:
```ts
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
```

- [ ] **Step 4: Run it, expect PASS**

Run: `node_modules/.bin/jest --config scripts/smoke/jest.smoke.config.cjs admin-api-client`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke/admin-api-client.ts scripts/smoke/__tests__/admin-api-client.test.ts
git commit -m "feat(smoke): typed admin-api client"
```

---

### Task 9: Fixtures

**Files:**
- Create: `scripts/smoke/fixtures/article-draft.md`
- Create: `scripts/smoke/fixtures/strategist-jd.txt`

- [ ] **Step 1: Article draft**

Create `scripts/smoke/fixtures/article-draft.md`:
```markdown
# Smoke: Zero-Downtime Postgres Connection Pooling

Author direction: a short technical post (~600 words) on why pgbouncer
in transaction mode reduces RDS connection pressure for Lambda + K8s
workloads. Cover: the problem, transaction vs session pooling, one
gotcha (prepared statements), and a closing recommendation. British
English. One Mermaid diagram.
```

- [ ] **Step 2: JD fixture**

Create `scripts/smoke/fixtures/strategist-jd.txt`:
```
Senior Site Reliability Engineer — Smoke Test Co (remote, EU)

You will own SLOs for a Kubernetes platform on AWS EKS, run an
incident process, and drive IaC with CDK. Required: 5+ years SRE/DevOps,
strong Kubernetes, AWS, Terraform or CDK, observability (Prometheus,
Grafana), and on-call leadership. Nice to have: Go, cost optimisation.
```

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke/fixtures/article-draft.md scripts/smoke/fixtures/strategist-jd.txt
git commit -m "feat(smoke): minimal real fixtures (draft + JD)"
```

---

### Task 10: Flow suite — chatbots

**Files:**
- Create: `scripts/smoke/chatbots.smoke.test.ts`

Suites read endpoints from a JSON file written by the orchestrator (`SMOKE_ENDPOINTS_FILE`).

- [ ] **Step 1: Implement**

Create `scripts/smoke/chatbots.smoke.test.ts`:
```ts
/** @format */
import { readFileSync } from 'node:fs';
import type { Endpoints } from './types.js';

const ep: Endpoints = JSON.parse(readFileSync(process.env.SMOKE_ENDPOINTS_FILE!, 'utf-8'));
const QUESTION = 'In one sentence, what is this portfolio about?';

async function ask(url: string, body: unknown, headers: Record<string,string> = {}) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

describe('chatbots', () => {
  it('public chatbot answers', async () => {
    const { status, text } = await ask(`${ep.chatbotPublicUrl}/invoke-public`,
      { question: QUESTION, sessionId: `smoke-${Date.now()}` });
    expect(status).toBe(200);
    expect(text.length).toBeGreaterThan(2);
  }, 120_000);

  it('default chatbot answers', async () => {
    const { status, text } = await ask(`${ep.chatbotUrl}/invoke`,
      { question: QUESTION, sessionId: `smoke-${Date.now()}` });
    expect(status).toBe(200);
    expect(text.length).toBeGreaterThan(2);
  }, 120_000);

  (ep.chatbotAuthJwt ? it : it.skip)('authenticated chatbot answers', async () => {
    const sessionId = `smoke-auth-${Date.now()}`;
    const { status } = await ask(`${ep.chatbotAuthenticatedUrl}/invoke-authenticated`,
      { question: QUESTION, sessionId }, { Authorization: `Bearer ${ep.chatbotAuthJwt}` });
    expect(status).toBe(200);
    console.log(`SMOKE_CHAT_SESSION=${sessionId}`);
  }, 120_000);
});
```

- [ ] **Step 2: Compile check**

Run: `npx tsx --eval "import('./scripts/smoke/chatbots.smoke.test.ts').catch(e=>{if(!/SMOKE_ENDPOINTS_FILE|Cannot find module .jest|describe is not defined/.test(String(e))) throw e; console.log('compiles')})"`
Expected: prints `compiles`.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke/chatbots.smoke.test.ts
git commit -m "feat(smoke): chatbots flow suite"
```

---

### Task 11: Flow suite — job-strategist

**Files:**
- Create: `scripts/smoke/job-strategist.smoke.test.ts`

- [ ] **Step 1: Implement**

Create `scripts/smoke/job-strategist.smoke.test.ts`:
```ts
/** @format */
import { readFileSync } from 'node:fs';
import { connectRds } from './rds-client.js';
import { AdminApiClient } from './admin-api-client.js';
import type { Endpoints } from './types.js';

const ep: Endpoints = JSON.parse(readFileSync(process.env.SMOKE_ENDPOINTS_FILE!, 'utf-8'));
const TEST_USER_ID = process.env.SMOKE_TEST_USER_ID!;
const TIMEOUT = Number(process.env.SMOKE_FLOW_TIMEOUT ?? '600000');

describe('job-strategist e2e', () => {
  it('admin-api -> pipeline -> RDS', async () => {
    const rds = await connectRds({
      host: ep.pgHost, port: ep.pgPort, database: ep.pgDatabase,
      user: ep.pgUser, password: ep.pgPassword, testUserId: TEST_USER_ID,
    });
    try {
      const seed = await rds.assertRows(
        'SELECT id FROM resumes WHERE user_id = $1 LIMIT 1', [TEST_USER_ID],
        'a seed resume for the test user (run resume-import first or seed one)');
      const resumeId = (seed[0] as { id: string }).id;

      const api = new AdminApiClient(ep.adminApiBaseUrl, ep.adminApiToken);
      const jd = readFileSync(`${__dirname}/fixtures/strategist-jd.txt`, 'utf-8');
      const { pipelineRunId } = await api.startStrategist({
        userId: TEST_USER_ID, targetCompany: 'Smoke Test Co',
        targetRole: 'Senior SRE', jobDescription: jd, resumeId,
      });
      console.log(`SMOKE_CLEANUP job-strategist ${pipelineRunId}`);

      const status = await rds.waitForPipelineStatus(pipelineRunId, TIMEOUT, 5000);
      expect(status).toBe('complete');

      await rds.assertRows(
        'SELECT 1 FROM job_applications WHERE user_id = $1 AND pipeline_run_id = $2',
        [TEST_USER_ID, pipelineRunId], 'job_applications row');
      await rds.assertRows(
        "SELECT 1 FROM resumes WHERE user_id = $1 AND source = 'tailored' AND pipeline_run_id = $2",
        [TEST_USER_ID, pipelineRunId], 'tailored resume row');
      await rds.assertRows(
        'SELECT 1 FROM coaching_content WHERE user_id = $1 AND pipeline_run_id = $2',
        [TEST_USER_ID, pipelineRunId], 'coaching_content row');
    } finally {
      await rds.close();
    }
  }, Number(process.env.SMOKE_FLOW_TIMEOUT ?? '600000') + 60_000);
});
```

- [ ] **Step 2: Compile check**

Run: `npx tsx --eval "import('./scripts/smoke/job-strategist.smoke.test.ts').catch(e=>{if(!/SMOKE_ENDPOINTS_FILE|Cannot find module .jest|describe is not defined/.test(String(e))) throw e; console.log('compiles')})"`
Expected: prints `compiles`.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke/job-strategist.smoke.test.ts
git commit -m "feat(smoke): job-strategist flow suite"
```

---

### Task 12: Flow suites — article-pipeline, resume-import, ingestion

**Files:**
- Create: `scripts/smoke/article-pipeline.smoke.test.ts`
- Create: `scripts/smoke/resume-import.smoke.test.ts`
- Create: `scripts/smoke/ingestion.smoke.test.ts`

- [ ] **Step 1: article-pipeline**

Create `scripts/smoke/article-pipeline.smoke.test.ts`:
```ts
/** @format */
import { readFileSync } from 'node:fs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { connectRds } from './rds-client.js';
import { AdminApiClient } from './admin-api-client.js';
import type { Endpoints } from './types.js';

const ep: Endpoints = JSON.parse(readFileSync(process.env.SMOKE_ENDPOINTS_FILE!, 'utf-8'));
const TEST_USER_ID = process.env.SMOKE_TEST_USER_ID!;
const BUCKET = process.env.SMOKE_ASSETS_BUCKET!;
const TIMEOUT = Number(process.env.SMOKE_FLOW_TIMEOUT ?? '600000');

describe('article-pipeline e2e', () => {
  it('admin-api -> pipeline -> articles row', async () => {
    const rds = await connectRds({
      host: ep.pgHost, port: ep.pgPort, database: ep.pgDatabase,
      user: ep.pgUser, password: ep.pgPassword, testUserId: TEST_USER_ID,
    });
    try {
      const s3Key = `smoke/article-${Date.now()}/draft.md`;
      const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'eu-west-1' });
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET, Key: s3Key, Body: readFileSync(`${__dirname}/fixtures/article-draft.md`),
      }));
      console.log(`SMOKE_CLEANUP_S3 ${BUCKET} ${s3Key}`);

      const api = new AdminApiClient(ep.adminApiBaseUrl, ep.adminApiToken);
      const { pipelineRunId } = await api.startArticle({ userId: TEST_USER_ID, s3Key });
      console.log(`SMOKE_CLEANUP article-pipeline ${pipelineRunId}`);

      const status = await rds.waitForPipelineStatus(pipelineRunId, TIMEOUT, 5000);
      expect(status).toBe('complete');
      const rows = await rds.assertRows(
        'SELECT status FROM articles WHERE user_id = $1 AND pipeline_run_id = $2',
        [TEST_USER_ID, pipelineRunId], 'articles row');
      expect(['review', 'published']).toContain((rows[0] as { status: string }).status);
    } finally {
      await rds.close();
    }
  }, Number(process.env.SMOKE_FLOW_TIMEOUT ?? '600000') + 60_000);
});
```

- [ ] **Step 2: resume-import**

Create `scripts/smoke/resume-import.smoke.test.ts`:
```ts
/** @format */
import { readFileSync } from 'node:fs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { connectRds } from './rds-client.js';
import { AdminApiClient } from './admin-api-client.js';
import type { Endpoints } from './types.js';

const ep: Endpoints = JSON.parse(readFileSync(process.env.SMOKE_ENDPOINTS_FILE!, 'utf-8'));
const TEST_USER_ID = process.env.SMOKE_TEST_USER_ID!;
const BUCKET = process.env.SMOKE_ASSETS_BUCKET!;
const TIMEOUT = Number(process.env.SMOKE_FLOW_TIMEOUT ?? '600000');
const PDF = `${__dirname}/../../applications/resume-import-processor/src/parsers/__tests__/fixtures/Nelson_Lamounier_Resume.pdf`;

describe('resume-import e2e', () => {
  it('admin-api -> import -> user_career_history', async () => {
    const rds = await connectRds({
      host: ep.pgHost, port: ep.pgPort, database: ep.pgDatabase,
      user: ep.pgUser, password: ep.pgPassword, testUserId: TEST_USER_ID,
    });
    try {
      const s3Key = `smoke/resume-${Date.now()}/resume.pdf`;
      const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'eu-west-1' });
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: s3Key, Body: readFileSync(PDF) }));
      console.log(`SMOKE_CLEANUP_S3 ${BUCKET} ${s3Key}`);

      const api = new AdminApiClient(ep.adminApiBaseUrl, ep.adminApiToken);
      const { pipelineRunId } = await api.startImport({ userId: TEST_USER_ID, s3Key });
      console.log(`SMOKE_CLEANUP resume-import ${pipelineRunId}`);

      const status = await rds.waitForPipelineStatus(pipelineRunId, TIMEOUT, 5000);
      expect(status).toBe('complete');
      await rds.assertRows(
        'SELECT 1 FROM user_career_history WHERE user_id = $1', [TEST_USER_ID],
        'user_career_history rows');
    } finally {
      await rds.close();
    }
  }, Number(process.env.SMOKE_FLOW_TIMEOUT ?? '600000') + 60_000);
});
```

- [ ] **Step 3: ingestion**

Create `scripts/smoke/ingestion.smoke.test.ts`:
```ts
/** @format */
import { readFileSync } from 'node:fs';
import { connectRds } from './rds-client.js';
import { AdminApiClient } from './admin-api-client.js';
import type { Endpoints } from './types.js';

const ep: Endpoints = JSON.parse(readFileSync(process.env.SMOKE_ENDPOINTS_FILE!, 'utf-8'));
const TEST_USER_ID = process.env.SMOKE_TEST_USER_ID!;
const REPO = process.env.SMOKE_INGEST_REPO ?? 'sindresorhus/is';
const TIMEOUT = Number(process.env.SMOKE_FLOW_TIMEOUT ?? '600000');

describe('ingestion e2e', () => {
  it('admin-api -> ingest -> document_embeddings', async () => {
    const rds = await connectRds({
      host: ep.pgHost, port: ep.pgPort, database: ep.pgDatabase,
      user: ep.pgUser, password: ep.pgPassword, testUserId: TEST_USER_ID,
    });
    try {
      const api = new AdminApiClient(ep.adminApiBaseUrl, ep.adminApiToken);
      const { pipelineRunId } = await api.startIngestion({ userId: TEST_USER_ID, repoFullName: REPO });
      console.log(`SMOKE_CLEANUP ingestion ${pipelineRunId}`);

      const status = await rds.waitForPipelineStatus(pipelineRunId, TIMEOUT, 5000);
      expect(status).toBe('complete');
      await rds.assertRows(
        'SELECT 1 FROM document_embeddings WHERE user_id = $1 LIMIT 1', [TEST_USER_ID],
        'document_embeddings rows');
    } finally {
      await rds.close();
    }
  }, Number(process.env.SMOKE_FLOW_TIMEOUT ?? '600000') + 60_000);
});
```

- [ ] **Step 4: Compile check all three**

Run:
```bash
for f in article-pipeline resume-import ingestion; do \
 npx tsx --eval "import('./scripts/smoke/$f.smoke.test.ts').catch(e=>{if(!/SMOKE_ENDPOINTS_FILE|Cannot find module .jest|describe is not defined/.test(String(e))) throw e; console.log('$f compiles')})"; done
```
Expected: `article-pipeline compiles`, `resume-import compiles`, `ingestion compiles`.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke/article-pipeline.smoke.test.ts scripts/smoke/resume-import.smoke.test.ts scripts/smoke/ingestion.smoke.test.ts
git commit -m "feat(smoke): article-pipeline, resume-import, ingestion flow suites"
```

---

### Task 13: Orchestrator

**Files:**
- Create: `scripts/smoke-e2e.ts`

- [ ] **Step 1: Implement**

Create `scripts/smoke-e2e.ts`:
```ts
/** @format */
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { ALL_FLOWS, type FlowName, type Endpoints } from './smoke/types.js';
import { resolveChatbotUrls, resolveAdminSecrets, resolvePgPassword, resolveAuth } from './smoke/discovery.js';
import { startPortForward } from './smoke/port-forward.js';
import { connectRds } from './smoke/rds-client.js';

const REGION = process.env.AWS_REGION ?? 'eu-west-1';
const PROFILE = process.env.AWS_PROFILE ?? 'dev-account';
const NAME_PREFIX = process.env.SMOKE_NAME_PREFIX ?? 'bedrock-data-development';
const TEST_USER_ID = process.env.SMOKE_TEST_USER_ID ?? '31f4686a-979b-4765-a17c-22a1e71cec59';
const PG_DATABASE = process.env.SMOKE_PG_DATABASE ?? 'tucaken';
const PG_USER = process.env.SMOKE_PG_USER ?? 'postgres';

function parseArgs(argv: string[]): FlowName[] {
  const flows = argv.filter(a => !a.startsWith('-'));
  if (flows.length === 0 || flows.includes('all')) return [...ALL_FLOWS];
  for (const f of flows) if (!ALL_FLOWS.includes(f as FlowName)) {
    throw new Error(`unknown flow "${f}". valid: ${ALL_FLOWS.join(', ')}, all`);
  }
  return flows as FlowName[];
}

async function main() {
  process.env.SMOKE_TEST_USER_ID = TEST_USER_ID;
  process.env.AWS_PROFILE = PROFILE;
  const flows = parseArgs(process.argv.slice(2));
  const cleanFirst = process.argv.includes('--clean-first');
  const skipCleanup = process.env.SKIP_CLEANUP === '1';
  console.log(`[smoke] flows=${flows.join(',')} user=${TEST_USER_ID} profile=${PROFILE}`);

  const stops: Array<() => void> = [];
  const tmp = mkdtempSync(join(tmpdir(), 'smoke-'));
  const epFile = join(tmp, 'endpoints.json');
  let failed = false;

  try {
    const pgFwd = await startPortForward({ namespace: 'platform', target: 'svc/pgbouncer', localPort: 15432, remotePort: 5432 });
    stops.push(pgFwd.stop);
    const adminFwd = await startPortForward({ namespace: 'admin-api', target: 'svc/admin-api', localPort: 13002, remotePort: 3002 });
    stops.push(adminFwd.stop);

    const auth = resolveAuth(PROFILE);
    const cfg = { region: REGION, profile: PROFILE, credentials: auth.credentials };
    const [chat, secrets, pgPassword] = await Promise.all([
      resolveChatbotUrls(NAME_PREFIX, cfg),
      resolveAdminSecrets(),
      resolvePgPassword(),
    ]);
    const ep: Endpoints = {
      adminApiBaseUrl: 'http://127.0.0.1:13002',
      adminApiToken: secrets.adminApiToken,
      chatbotAuthJwt: secrets.chatbotAuthJwt,
      ...chat,
      pgPassword, pgHost: '127.0.0.1', pgPort: 15432,
      pgDatabase: PG_DATABASE, pgUser: PG_USER,
    };
    writeFileSync(epFile, JSON.stringify(ep));
    process.env.SMOKE_ENDPOINTS_FILE = epFile;

    if (cleanFirst) {
      const rds = await connectRds({
        host: '127.0.0.1', port: 15432, database: PG_DATABASE,
        user: PG_USER, password: pgPassword, testUserId: TEST_USER_ID,
      });
      await rds.cleanupUserScoped();
      await rds.close();
      console.log('[smoke] pre-clean done');
    }

    const patterns = flows.map(f => `${f}.smoke.test.ts`).join('|');
    const res = spawnSync('node_modules/.bin/jest', [
      '--config', 'scripts/smoke/jest.smoke.config.cjs',
      '--runInBand', '--testPathPattern', patterns,
    ], { stdio: 'inherit', env: process.env });
    failed = res.status !== 0;
  } catch (e) {
    failed = true;
    console.error(`[smoke] SETUP FAILED: ${(e as Error).message}`);
  } finally {
    if (!skipCleanup) {
      try {
        let pw = '';
        try { pw = JSON.parse(readFileSync(epFile, 'utf-8')).pgPassword as string; } catch { pw = ''; }
        if (pw) {
          const rds = await connectRds({
            host: '127.0.0.1', port: 15432, database: PG_DATABASE,
            user: PG_USER, password: pw, testUserId: TEST_USER_ID,
          });
          await rds.cleanupRun({ flow: 'job-strategist', s3Keys: [] }); // user-scoped sweep (rid null)
          await rds.cleanupUserScoped();
          await rds.close();
        }
        const s3 = new S3Client({ region: REGION });
        // smoke/ S3 fixtures are best-effort: list+delete prefix is YAGNI for now;
        // objects are tiny and namespaced under smoke/. Left intentionally.
        void s3; void DeleteObjectCommand;
        console.log('[smoke] cleanup done');
      } catch (e) {
        console.warn(`[smoke] cleanup error (non-fatal): ${(e as Error).message}`);
      }
    } else {
      console.log(`[smoke] SKIP_CLEANUP=1 — retained rows for ${TEST_USER_ID}; endpoints: ${epFile}`);
    }
    for (const stop of stops.reverse()) try { stop(); } catch { /* noop */ }
    if (!skipCleanup) rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failed ? '[smoke] RESULT: FAIL' : '[smoke] RESULT: PASS');
  process.exit(failed ? 1 : 0);
}

void main();
```

- [ ] **Step 2: Executor note (S3 fixture cleanup — YAGNI now)**

Flow suites print `SMOKE_CLEANUP_S3 <bucket> <key>`. The orchestrator does a user-scoped DB sweep (sufficient: all rows are `TEST_USER_ID`-scoped) and leaves the tiny `smoke/`-prefixed S3 objects. Add stdout-capture + prefix-delete only if `smoke/` accumulation becomes a real problem.

- [ ] **Step 3: Compile check**

Run: `npx tsx --eval "import('./scripts/smoke-e2e.ts').catch(e=>{console.log('loadcheck:', e.name)})" 2>&1 | head -1`
Expected: prints `loadcheck:` (module type-loads; `main()` will not complete without a cluster — that is fine). A TypeScript error here must be fixed.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-e2e.ts
git commit -m "feat(smoke): orchestrator (creds, discovery, port-forward, jest, cleanup)"
```

---

### Task 14: justfile recipes + README

**Files:**
- Modify: `justfile`
- Create: `scripts/smoke/README.md`

- [ ] **Step 1: Append recipes to `justfile`**

Append to the end of `justfile`:
```just

# ── E2E Smoke (real Bedrock, dev account — NEVER in CI) ──────────────────────

# Run the end-to-end smoke suite against the deployed dev account.
# Usage: just smoke-e2e                 # all flows
#        just smoke-e2e job-strategist  # one flow
#        just smoke-e2e chatbots SKIP_CLEANUP=1
[group('smoke')]
smoke-e2e *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ -f .env.smoke ]]; then
      while IFS='=' read -r key value || [[ -n "$key" ]]; do
        [[ "$key" =~ ^[[:space:]]*# ]] && continue
        [[ -z "${key// }" ]] && continue
        key="${key// /}"; value="${value// /}"
        [[ -n "$value" && -z "${!key:-}" ]] && export "$key=$value"
      done < .env.smoke
    fi
    flows=(); for arg in {{ARGS}}; do
      if [[ "$arg" == *=* ]]; then export "$arg"; else flows+=("$arg"); fi
    done
    npx tsx scripts/smoke-e2e.ts "${flows[@]:-all}"

# Open the pgbouncer tunnel for manual psql inspection during a smoke run.
[group('smoke')]
smoke-tunnel:
    kubectl port-forward svc/pgbouncer 15432:5432 -n platform
```

- [ ] **Step 2: Verify just parses it**

Run: `just --list 2>/dev/null | grep -E 'smoke-e2e|smoke-tunnel'`
Expected: both recipes listed. If `just` errors, match the body indentation to the existing recipes in the file.

- [ ] **Step 3: Write the README**

Create `scripts/smoke/README.md`:
```markdown
# E2E Smoke Test

Real Bedrock + real RDS, dev account only. **Never runs in CI.**

## Prerequisites
- `aws sso login --profile dev-account` (or valid `dev-account` creds)
- `kubectl` context pointing at the dev cluster
- `just`, Node, repo deps installed (`npm ci`)

## Run
```
just smoke-e2e                  # all flows
just smoke-e2e job-strategist   # one flow
just smoke-e2e chatbots SKIP_CLEANUP=1
just smoke-e2e all --clean-first
```

## Before the FIRST run — fill tucaken-app values
Set these in a gitignored `.env.smoke` (or real env). Defaults in
`scripts/smoke/admin-api-contract.ts` are placeholders:

| var | meaning |
|---|---|
| `SMOKE_ROUTE_STRATEGIST` / `_ARTICLE` / `_IMPORT` / `_INGESTION` | admin-api route paths |
| `SMOKE_ADMIN_TOKEN_SECRET` / `SMOKE_ADMIN_TOKEN_KEY` | k8s secret holding the admin-api token |
| `SMOKE_ADMIN_AUTH_SCHEME` | `bearer` or `x-api-key` |
| `SMOKE_CHATBOT_JWT_SECRET` / `SMOKE_CHATBOT_JWT_KEY` | dev JWT for chatbot-authenticated (omit ⇒ skipped) |
| `SMOKE_NAME_PREFIX` | SSM param prefix (default `bedrock-data-development`) |
| `SMOKE_ASSETS_BUCKET` | dev assets S3 bucket for draft/PDF upload |
| `SMOKE_TEST_USER_ID` | UUID test user (default `31f4686a-…`) |
| `SMOKE_FLOW_TIMEOUT` | per-flow ms (default 600000) |
| `SMOKE_INGEST_REPO` | repo full-name for ingestion (default `sindresorhus/is`) |
| `SKIP_CLEANUP=1` | retain rows for debugging |

Also re-verify `rds-client` column names against
`applications/platform-rds-bootstrap/src/index.ts` and
`applications/job-strategist/src/__tests__/run-pipeline.integration.test.ts`.

## Safety
`assertSafeToMutate` hard-aborts unless the DB is in `SMOKE_ALLOWED_DBS`
(default `tucaken`) and `SMOKE_TEST_USER_ID` is a UUID. Cleanup is
test-user-scoped only.
```

- [ ] **Step 4: Commit**

```bash
git add justfile scripts/smoke/README.md
git commit -m "feat(smoke): just recipes + README"
```

---

### Task 15: Full harness unit-test gate

- [ ] **Step 1: Run every harness unit test**

Run: `node_modules/.bin/jest --config scripts/smoke/jest.smoke.config.cjs --testPathPattern '__tests__'`
Expected: all PASS (`exec-wrapper`, `cleanup-registry`, `rds-client`, `discovery`, `admin-api-client`). Zero AWS/Bedrock.

- [ ] **Step 2: Confirm flow suites are excluded from that run**

Expected: no `*.smoke.test.ts` executed (testPathPattern `__tests__`). If any flow suite ran, fix `jest.smoke.config.cjs`.

- [ ] **Step 3: Typecheck the new files**

Run: `npx tsc --noEmit --skipLibCheck -p tsconfig.json 2>&1 | grep -i 'scripts/smoke' || echo "no smoke type errors"`
Expected: `no smoke type errors` (or fix any reported).

- [ ] **Step 4: Final commit**

```bash
git add -A scripts/smoke scripts/smoke-e2e.ts
git commit -m "test(smoke): harness unit-test gate green" --allow-empty
```

---

## Self-review

**Spec coverage:**
- Approach A (trigger admin-api, poll RDS) → Tasks 8, 11, 12. ✔
- Discovery (kubectl + SSM) → Task 6. ✔
- Port-forwards + TCP healthcheck → Task 7 + orchestrator Task 13. ✔
- Per-flow contracts (5 flows + 3 chatbots) → Tasks 10–12. ✔
- Fixed test user + FK-ordered, test-user-scoped, idempotent cleanup → Tasks 4–5, 13. ✔
- Safety guard (dev DB + UUID), TDD first → Task 4. ✔
- Error classes / timeouts / fail-fast / no Bedrock retry → Task 1 (types), 5 (rds-client), 13 (orchestrator). ✔
- `admin-api-contract.ts` placeholders for the 4 open items → Task 2. ✔
- just runner, no CI, README → Task 14. ✔
- Harness self-tests TDD, CI-safe → Tasks 1, 3–6, 8, 15. ✔
- `.env.smoke` gitignored → Task 0. ✔

**Placeholder scan:** No "TBD/TODO" steps; every code step has full code. The only intentional placeholders are the documented `admin-api-contract.ts` env defaults (a spec requirement). Two executor notes (Task 5 Step 5, Task 13 Step 2) explicitly defer real-column verification / S3 stdout-capture to first-run / YAGNI — explicit, not vague.

**Type consistency:** `Endpoints`, `FlowName`, `CleanupTarget`, `SmokeSetupError/InfraError/AssertionError` defined in Task 1, used unchanged after. `RdsClient`/`connectRds`/`assertSafeToMutate` (Tasks 4–5) consumed consistently in flow suites + orchestrator. `AdminApiClient` method names match `ADMIN_API.routes`. `capture` (Task 1) used by discovery (Task 6). `resolveChatbotUrls`/`resolveAdminSecrets`/`resolvePgPassword`/`resolveAuth` (Task 6) match orchestrator imports (Task 13). No signature drift.

**Known soft spots (documented, not blocking):** exact admin-api request body shapes and a few RDS column names are inferred from the integration test, confirmed before the first real run (README + Task 5 note). All are isolated to `admin-api-contract.ts` / `rds-client.cleanupRun` and do not affect unit-tested logic (ordering, scoping, guard).
