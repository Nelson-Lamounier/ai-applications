# tucaken-smoke MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reusable, AI-driven TypeScript MCP server (`tucaken-smoke`) that drives + asserts E2E smoke tests against the dev account, plus AWS Labs MCPs for live observation. First flow: System Design coach walkthrough.

**Architecture:** A stdio MCP (`@modelcontextprotocol/sdk`) exposing flow-agnostic primitives (`auth`, `admin_api`, `sql`, `wait_pipeline`, `job_logs`, `cleanup`) + System Design flow helpers (`run_strategist`, `run_coach`, `seed_project_evidence`, `assert_system_design`). It reuses the existing `scripts/smoke/` modules via a new barrel (`scripts/smoke/lib/index.ts`). Cross-cutting: dev account/region/db pin, SELECT-only SQL, confirm-on-spend, auto-cleanup, JSON-lines logging with 20-file retention. AWS Labs `eks`/`cloudwatch`/read-only `aws-api` MCPs are wired via `.mcp.json` for observation.

**Tech Stack:** TypeScript (ESM, NodeNext), `@modelcontextprotocol/sdk`, `zod` (tool input schemas), `tsup` (bundle to `dist/index.js`), `vitest` (unit tests). Reuses `pg`, `@aws-sdk/*` transitively via `scripts/smoke`. AWS Labs MCP servers run via `uvx`.

**Conventions:** Files start `/** @format */`. ESM relative imports end in `.js`. Spec: `docs/superpowers/specs/2026-06-04-tucaken-smoke-mcp-design.md`. Dev target pinned: account `771826808455`, region `eu-west-1`, db `tucaken`. No `Co-Authored-By` trailers. Run one MCP unit test: `yarn --cwd mcp-servers/tucaken-smoke test <file>`.

---

## File Structure

**Create (MCP package `mcp-servers/tucaken-smoke/`):**
- `package.json` — deps, `build` (tsup), `test` (vitest), `start`.
- `tsconfig.json` — NodeNext ESM.
- `tsup.config.ts` — bundle `src/index.ts` → `dist/index.js` (resolves the smoke-lib relative import).
- `vitest.config.ts`.
- `src/index.ts` — server bootstrap: create `McpServer`, register tools, stdio transport, startup pin-check + log prune.
- `src/config.ts` — resolve + freeze `{account, region, db}` expectations + `SMOKE_LOG_RETAIN`.
- `src/guards.ts` — `assertDevTarget()`, `isSelectOnly()`.
- `src/logger.ts` — JSON-lines session logger + `pruneLogs()` + `redact()`.
- `src/session.ts` — in-process session state (id token, endpoints, tunnel, cleanup registry).
- `src/tools/primitives.ts` — `smoke_auth`, `smoke_admin_api`, `smoke_sql`, `smoke_wait_pipeline`, `smoke_job_logs`, `smoke_cleanup`.
- `src/tools/system-design.ts` — `smoke_run_strategist`, `smoke_run_coach`, `smoke_seed_project_evidence`, `smoke_assert_system_design`.
- `src/tools/register.ts` — wrap each tool handler with logging + dev-pin + (where flagged) confirm-on-spend.
- `src/validators.ts` — pure `validateSystemDesign(tier, coaching, coverage)` (testable).
- `README.md`.
- `logs/.gitkeep`.
- Tests: `src/__tests__/guards.test.ts`, `logger.test.ts`, `validators.test.ts`, `sql-guard.test.ts`.

**Create (repo root):**
- `.mcp.json` — `tucaken-smoke` (node dist) + AWS Labs `eks`/`cloudwatch`/`aws-api` (uvx, dev profile, read-only).
- `scripts/smoke/lib/index.ts` — barrel re-exporting the reusable smoke modules.

**Modify:**
- `.gitignore` — ignore `mcp-servers/tucaken-smoke/logs/*` (keep `.gitkeep`) and `dist/` already covered.
- `scripts/smoke/admin-api-client.ts` — add `startCoach`/`getCoaching` methods (generic-route based).

---

## Task 1: Shared smoke-lib barrel (zero-churn extraction)

**Files:**
- Create: `scripts/smoke/lib/index.ts`

- [ ] **Step 1: Create the barrel re-exporting reusable modules**

The existing `scripts/smoke/*.ts` modules stay put (no import churn in current tests). The barrel is the shared boundary the MCP imports.

```ts
/** @format */
// Shared smoke-lib boundary: re-exports the reusable harness modules so both
// the jest smoke suite and the tucaken-smoke MCP import one surface.
export * from '../types.js';
export * from '../cognito-auth.js';
export * from '../admin-api-client.js';
export * from '../admin-api-contract.js';
export * from '../rds-client.js';
export * from '../port-forward.js';
export * from '../cleanup-registry.js';
export * from '../discovery.js';
```

- [ ] **Step 2: Verify it type-checks within the smoke tsconfig**

Run: `cd scripts/smoke && npx tsc --noEmit -p tsconfig.json`
Expected: no errors (barrel only re-exports existing modules).

- [ ] **Step 3: Confirm the existing smoke suite is unaffected (compile-only)**

Run: `cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications && npx tsc --noEmit -p scripts/smoke/tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke/lib/index.ts
git commit -m "feat(smoke): shared smoke-lib barrel for MCP reuse"
```

---

## Task 2: Add coach routes to AdminApiClient

**Files:**
- Modify: `scripts/smoke/admin-api-client.ts`
- Modify: `scripts/smoke/admin-api-contract.ts`

- [ ] **Step 1: Add coach + coaching routes to the contract**

In `admin-api-contract.ts`, inside `ADMIN_API.routes`, add (after `ingestion`):

```ts
    // POST /api/admin/applications/:slug/coach  { interviewStage }
    coach:      env('SMOKE_ROUTE_COACH',  '/api/admin/applications'),  // + /:slug/coach
```

- [ ] **Step 2: Add `startCoach` + `getCoaching` to AdminApiClient**

In `admin-api-client.ts`, add these methods to the class (they reuse the existing `send`/`postJson` plumbing; `getCoaching` does a raw GET):

```ts
  /** POST /api/admin/applications/:slug/coach — dispatch a coach run for a stage. */
  startCoach(slug: string, interviewStage: string): Promise<StartResponse> {
    return this.postJson(`${ADMIN_API.routes.coach}/${slug}/coach`, { interviewStage });
  }

  /** GET /api/admin/applications/:slug/coaching/:stage — read a coaching_content row. */
  async getCoaching(slug: string, stage: string): Promise<unknown> {
    const raw = await this.send('GET', `${this.baseUrl}${ADMIN_API.routes.coach}/${slug}/coaching/${stage}`, {
      headers: { ...bearer(this.idToken) },
    });
    return raw ? JSON.parse(raw) : null;
  }
```

(Confirm `this.baseUrl`/`this.idToken`/`bearer` are in scope — `bearer` is imported from `admin-api-contract.js` in this file; if not, add the import.)

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p scripts/smoke/tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke/admin-api-client.ts scripts/smoke/admin-api-contract.ts
git commit -m "feat(smoke): AdminApiClient coach dispatch + coaching read"
```

---

## Task 3: Scaffold the MCP package

**Files:**
- Create: `mcp-servers/tucaken-smoke/package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `README.md`, `logs/.gitkeep`
- Modify: `.gitignore`

- [ ] **Step 1: package.json**

```json
{
  "name": "@bedrock/tucaken-smoke-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "tucaken-smoke-mcp": "dist/index.js" },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.23.8",
    "pg": "^8.11.0"
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "typescript": "^5.4.0",
    "vitest": "^2.0.0",
    "@types/node": "^20.0.0",
    "@types/pg": "^8.11.0"
  }
}
```

- [ ] **Step 2: tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tsup.config.ts", "vitest.config.ts"]
}
```

- [ ] **Step 3: tsup.config.ts** (bundles the relative smoke-lib import into one file)

```ts
import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  bundle: true,
  clean: true,
  // Resolve the cross-dir smoke-lib import; keep heavy native deps external.
  external: ['pg'],
  banner: { js: '#!/usr/bin/env node' },
});
```

- [ ] **Step 4: vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['src/**/*.test.ts'] } });
```

- [ ] **Step 5: README.md + logs/.gitkeep**

`README.md`:
```md
# tucaken-smoke MCP
AI-driven E2E smoke testing against the dev account (771826808455 / eu-west-1 / db tucaken).
Build: `yarn --cwd mcp-servers/tucaken-smoke build`. Wired via repo-root `.mcp.json`.
Tools: smoke_auth, smoke_admin_api, smoke_sql, smoke_wait_pipeline, smoke_job_logs, smoke_cleanup,
smoke_run_strategist, smoke_run_coach, smoke_seed_project_evidence, smoke_assert_system_design.
Safety: dev-pinned, SELECT-only sql, confirm-on-spend, auto-cleanup. Logs: logs/ (JSON-lines, retain 20).
```
`logs/.gitkeep`: empty file.

- [ ] **Step 6: .gitignore — ignore the logs**

Add under the existing entries:
```
# tucaken-smoke MCP run logs
mcp-servers/tucaken-smoke/logs/*
!mcp-servers/tucaken-smoke/logs/.gitkeep
```

- [ ] **Step 7: Install + verify build skeleton**

Run: `yarn install` (root) then create a temporary `src/index.ts` with `console.error('boot')` and run `yarn --cwd mcp-servers/tucaken-smoke build`.
Expected: `dist/index.js` produced. (Replaced in Task 7.)

- [ ] **Step 8: Commit**

```bash
git add mcp-servers/tucaken-smoke/package.json mcp-servers/tucaken-smoke/tsconfig.json mcp-servers/tucaken-smoke/tsup.config.ts mcp-servers/tucaken-smoke/vitest.config.ts mcp-servers/tucaken-smoke/README.md mcp-servers/tucaken-smoke/logs/.gitkeep .gitignore yarn.lock
git commit -m "chore(tucaken-smoke): scaffold MCP package (tsup + vitest, ESM)"
```

---

## Task 4: Config + dev-target pin + SELECT-only guard (TDD)

**Files:**
- Create: `mcp-servers/tucaken-smoke/src/config.ts`, `src/guards.ts`
- Test: `src/__tests__/guards.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
/** @format */
import { describe, it, expect } from 'vitest';
import { assertDevTarget, isSelectOnly } from '../guards.js';

describe('assertDevTarget', () => {
  it('passes for the pinned dev target', () => {
    expect(() => assertDevTarget({ account: '771826808455', region: 'eu-west-1', db: 'tucaken' })).not.toThrow();
  });
  it('throws for any other account/region/db', () => {
    expect(() => assertDevTarget({ account: '999', region: 'eu-west-1', db: 'tucaken' })).toThrow(/account/);
    expect(() => assertDevTarget({ account: '771826808455', region: 'us-east-1', db: 'tucaken' })).toThrow(/region/);
    expect(() => assertDevTarget({ account: '771826808455', region: 'eu-west-1', db: 'prod' })).toThrow(/db/);
  });
});

describe('isSelectOnly', () => {
  it('accepts SELECT / WITH ... SELECT', () => {
    expect(isSelectOnly('SELECT 1')).toBe(true);
    expect(isSelectOnly('  with x as (select 1) select * from x')).toBe(true);
  });
  it('rejects writes + multi-statement', () => {
    for (const s of ['UPDATE t SET a=1', 'delete from t', 'INSERT INTO t VALUES(1)', 'DROP TABLE t',
                     'SELECT 1; DROP TABLE t', 'truncate t']) expect(isSelectOnly(s)).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`Cannot find module '../guards.js'`)

Run: `yarn --cwd mcp-servers/tucaken-smoke test src/__tests__/guards.test.ts`

- [ ] **Step 3: Implement config.ts + guards.ts**

`config.ts`:
```ts
/** @format */
export const DEV_TARGET = { account: '771826808455', region: 'eu-west-1', db: 'tucaken' } as const;
export const LOG_RETAIN = Math.max(1, parseInt(process.env.SMOKE_LOG_RETAIN ?? '20', 10));
```
`guards.ts`:
```ts
/** @format */
import { DEV_TARGET } from './config.js';

export function assertDevTarget(t: { account: string; region: string; db: string }): void {
  if (t.account !== DEV_TARGET.account) throw new Error(`refusing: account ${t.account} != dev ${DEV_TARGET.account}`);
  if (t.region !== DEV_TARGET.region) throw new Error(`refusing: region ${t.region} != ${DEV_TARGET.region}`);
  if (t.db !== DEV_TARGET.db) throw new Error(`refusing: db ${t.db} != ${DEV_TARGET.db}`);
}

/** True only for a single read-only statement (SELECT or WITH…SELECT, no extra ';'). */
export function isSelectOnly(sql: string): boolean {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (trimmed.includes(';')) return false;            // no multi-statement
  return /^(select|with)\b/i.test(trimmed);
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `yarn --cwd mcp-servers/tucaken-smoke test src/__tests__/guards.test.ts`

- [ ] **Step 5: Commit**

```bash
git add mcp-servers/tucaken-smoke/src/config.ts mcp-servers/tucaken-smoke/src/guards.ts mcp-servers/tucaken-smoke/src/__tests__/guards.test.ts
git commit -m "feat(tucaken-smoke): dev-target pin + SELECT-only guard"
```

---

## Task 5: JSON-lines logger + retention + redaction (TDD)

**Files:**
- Create: `mcp-servers/tucaken-smoke/src/logger.ts`
- Test: `src/__tests__/logger.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
/** @format */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneLogs, redact } from '../logger.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'smokelog-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('pruneLogs', () => {
  it('keeps newest N, deletes the rest', () => {
    for (let i = 0; i < 25; i++) writeFileSync(join(dir, `smoke-${String(i).padStart(3,'0')}.log`), 'x');
    pruneLogs(dir, 20);
    const files = readdirSync(dir).filter(f => f.endsWith('.log')).sort();
    expect(files.length).toBe(20);
    expect(files[0]).toBe('smoke-005.log'); // 000-004 pruned
  });
});

describe('redact', () => {
  it('masks secrets by key', () => {
    const out = redact({ password: 'p', idToken: 'jwt', body: { ok: 1 } }) as Record<string, unknown>;
    expect(out.password).toBe('***');
    expect(out.idToken).toBe('***');
    expect((out.body as { ok: number }).ok).toBe(1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `yarn --cwd mcp-servers/tucaken-smoke test src/__tests__/logger.test.ts`

- [ ] **Step 3: Implement logger.ts**

```ts
/** @format */
import { appendFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECRET_KEYS = /^(password|pass|token|idtoken|accesstoken|secret|authorization|jwt)$/i;

export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) o[k] = SECRET_KEYS.test(k) ? '***' : redact(val);
    return o;
  }
  return v;
}

/** Delete oldest *.log beyond `retain` (lexical sort == chronological for our timestamped names). */
export function pruneLogs(dir: string, retain: number): void {
  if (!existsSync(dir)) return;
  const logs = readdirSync(dir).filter(f => f.endsWith('.log')).sort();
  for (const f of logs.slice(0, Math.max(0, logs.length - retain))) unlinkSync(join(dir, f));
}

export class SessionLogger {
  private readonly file: string;
  constructor(logsDir: string, isoStamp: string) {
    mkdirSync(logsDir, { recursive: true });
    this.file = join(logsDir, `smoke-${isoStamp.replace(/[:.]/g, '-')}.log`);
  }
  log(entry: Record<string, unknown>): void {
    appendFileSync(this.file, JSON.stringify({ ...redact(entry) as object }) + '\n');
  }
}

/** Default logs dir relative to the built file: <pkg>/logs. */
export function defaultLogsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'logs');
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `yarn --cwd mcp-servers/tucaken-smoke test src/__tests__/logger.test.ts`

- [ ] **Step 5: Commit**

```bash
git add mcp-servers/tucaken-smoke/src/logger.ts mcp-servers/tucaken-smoke/src/__tests__/logger.test.ts
git commit -m "feat(tucaken-smoke): JSON-lines logger + 20-file retention + redaction"
```

---

## Task 6: System Design validators (TDD, pure)

**Files:**
- Create: `mcp-servers/tucaken-smoke/src/validators.ts`
- Test: `src/__tests__/validators.test.ts`

Contract: `validateSystemDesign(tier, coaching)` returns `{ ok, failures[] }`. Tier A: `systemDesignCoverage` present. Tier B: also every walkthrough card's `evidenceRefs[].id` ∈ that concern's `coverage.detected[].evidenceRefs` ids; gap cards (`choiceMade===null`) carry no evidenceRefs.

- [ ] **Step 1: Write failing tests**

```ts
/** @format */
import { describe, it, expect } from 'vitest';
import { validateSystemDesign } from '../validators.js';

const coverage = { detected: [{ concernId: 'rls', evidenceRefs: [{ id: 'c1' }] }], relevantTotal: 1, relevantAddressed: 1 };
const groundedCard = { concernId: 'rls', evidenceRefs: [{ id: 'c1' }], choiceMade: 'RLS' };
const base = { systemDesignCoverage: coverage, systemDesignWalkthrough: [groundedCard] };

describe('validateSystemDesign', () => {
  it('Tier A passes when coverage present', () => {
    expect(validateSystemDesign('A', base).ok).toBe(true);
  });
  it('Tier A fails when coverage missing', () => {
    expect(validateSystemDesign('A', { systemDesignWalkthrough: [] }).ok).toBe(false);
  });
  it('Tier B passes a grounded card', () => {
    expect(validateSystemDesign('B', base).ok).toBe(true);
  });
  it('Tier B fails an invented evidence id', () => {
    const bad = { ...base, systemDesignWalkthrough: [{ ...groundedCard, evidenceRefs: [{ id: 'FAKE' }] }] };
    const r = validateSystemDesign('B', bad);
    expect(r.ok).toBe(false);
    expect(r.failures.join()).toMatch(/FAKE/);
  });
  it('Tier B fails a gap card carrying evidence', () => {
    const bad = { ...base, systemDesignWalkthrough: [{ concernId: 'rls', choiceMade: null, evidenceRefs: [{ id: 'c1' }] }] };
    expect(validateSystemDesign('B', bad).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `yarn --cwd mcp-servers/tucaken-smoke test src/__tests__/validators.test.ts`

- [ ] **Step 3: Implement validators.ts**

```ts
/** @format */
interface Ref { id: string }
interface Card { concernId: string; choiceMade: string | null; evidenceRefs?: Ref[] }
interface Detected { concernId: string; evidenceRefs?: Ref[] }
interface Coverage { detected: Detected[]; relevantTotal: number; relevantAddressed: number }
interface Coaching { systemDesignCoverage?: Coverage; systemDesignWalkthrough?: Card[] }

export function validateSystemDesign(tier: 'A' | 'B', c: Coaching): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const coverage = c.systemDesignCoverage;
  if (!coverage) { failures.push('missing systemDesignCoverage'); return { ok: false, failures }; }
  if (tier === 'A') return { ok: true, failures };

  const refsByConcern = new Map(coverage.detected.map(d => [d.concernId, new Set((d.evidenceRefs ?? []).map(r => r.id))]));
  for (const card of c.systemDesignWalkthrough ?? []) {
    const allowed = refsByConcern.get(card.concernId);
    if (!allowed) { failures.push(`card for unknown concern: ${card.concernId}`); continue; }
    for (const r of card.evidenceRefs ?? []) if (!allowed.has(r.id)) failures.push(`invented evidence id "${r.id}" for ${card.concernId}`);
    if (card.choiceMade === null && (card.evidenceRefs ?? []).length > 0) failures.push(`gap card "${card.concernId}" must carry no evidenceRefs`);
  }
  return { ok: failures.length === 0, failures };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `yarn --cwd mcp-servers/tucaken-smoke test src/__tests__/validators.test.ts`

- [ ] **Step 5: Commit**

```bash
git add mcp-servers/tucaken-smoke/src/validators.ts mcp-servers/tucaken-smoke/src/__tests__/validators.test.ts
git commit -m "feat(tucaken-smoke): System Design Tier A/B validators"
```

---

## Task 7: Session state + server bootstrap

**Files:**
- Create: `mcp-servers/tucaken-smoke/src/session.ts`, `src/index.ts`, `src/tools/register.ts`

- [ ] **Step 1: session.ts — in-process state**

```ts
/** @format */
import type { Endpoints, CleanupTarget } from '../../../scripts/smoke/lib/index.js';

export interface SmokeSession {
  endpoints?: Endpoints;
  idToken?: string;
  testUserId?: string;
  cleanup: CleanupTarget[];
  tunnelStop?: () => void;
}
export const session: SmokeSession = { cleanup: [] };
export function requireAuth(): { endpoints: Endpoints; idToken: string; testUserId: string } {
  if (!session.endpoints || !session.idToken || !session.testUserId) throw new Error('call smoke_auth first');
  return { endpoints: session.endpoints, idToken: session.idToken, testUserId: session.testUserId };
}
```

- [ ] **Step 2: register.ts — wrap handlers with logging + dev-pin**

```ts
/** @format */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SessionLogger } from '../logger.js';

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

/** Register a tool: validate input, log call+outcome, return MCP text content. */
export function tool(server: McpServer, logger: SessionLogger, name: string, schema: z.ZodRawShape, handler: Handler): void {
  server.tool(name, schema, async (args: Record<string, unknown>) => {
    const started = Date.now();
    try {
      const result = await handler(args);
      logger.log({ tool: name, params: args, ok: true, durationMs: Date.now() - started });
      return { content: [{ type: 'text', text: JSON.stringify(result ?? { ok: true }, null, 2) }] };
    } catch (e) {
      const err = e as Error;
      logger.log({ tool: name, params: args, ok: false, durationMs: Date.now() - started, error: err.message, stack: err.stack });
      return { content: [{ type: 'text', text: `ERROR ${name}: ${err.message}` }], isError: true };
    }
  });
}
```

- [ ] **Step 3: index.ts — bootstrap**

```ts
/** @format */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SessionLogger, defaultLogsDir, pruneLogs } from './logger.js';
import { LOG_RETAIN } from './config.js';
import { registerPrimitives } from './tools/primitives.js';
import { registerSystemDesign } from './tools/system-design.js';

const logsDir = defaultLogsDir();
pruneLogs(logsDir, LOG_RETAIN);                       // bound retention at startup
const stamp = new Date().toISOString();               // process-start stamp (allowed at runtime)
const logger = new SessionLogger(logsDir, stamp);

const server = new McpServer({ name: 'tucaken-smoke', version: '0.1.0' });
registerPrimitives(server, logger);
registerSystemDesign(server, logger);

await server.connect(new StdioServerTransport());
logger.log({ tool: '_boot', ok: true, params: { logsDir, retain: LOG_RETAIN } });
```

- [ ] **Step 4: Typecheck (handlers stubbed next tasks — create empty register fns to compile)**

Create minimal `src/tools/primitives.ts` + `src/tools/system-design.ts` exporting `registerPrimitives`/`registerSystemDesign` that do nothing yet, then:
Run: `yarn --cwd mcp-servers/tucaken-smoke typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add mcp-servers/tucaken-smoke/src/session.ts mcp-servers/tucaken-smoke/src/index.ts mcp-servers/tucaken-smoke/src/tools/register.ts mcp-servers/tucaken-smoke/src/tools/primitives.ts mcp-servers/tucaken-smoke/src/tools/system-design.ts
git commit -m "feat(tucaken-smoke): server bootstrap + logged tool wrapper + session state"
```

---

## Task 8: Primitives — auth, admin_api, sql, wait_pipeline, cleanup

**Files:**
- Modify: `mcp-servers/tucaken-smoke/src/tools/primitives.ts`

- [ ] **Step 1: Implement `registerPrimitives`**

Uses the smoke-lib barrel for auth/RDS/admin-api. `smoke_sql` enforces `isSelectOnly` + opens/reuses a port-forward tunnel and asserts the dev db.

```ts
/** @format */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionLogger } from '../logger.js';
import { tool } from './register.js';
import { session, requireAuth } from '../session.js';
import { assertDevTarget, isSelectOnly } from '../guards.js';
import { DEV_TARGET } from '../config.js';
import {
  mintCognitoJwt, decodeJwtSub, resolveCognitoClientId, resolveRdsConn, resolvePgPassword,
  AdminApiClient, startPortForward, connectRds,
} from '../../../scripts/smoke/lib/index.js';

export function registerPrimitives(server: McpServer, logger: SessionLogger): void {
  tool(server, logger, 'smoke_auth', {}, async () => {
    const clientId = await resolveCognitoClientId();
    const idToken = await mintCognitoJwt({
      region: DEV_TARGET.region, clientId,
      username: process.env.SMOKE_COGNITO_USERNAME!, password: process.env.SMOKE_COGNITO_PASSWORD!,
    });
    const rds = await resolveRdsConn();
    assertDevTarget({ account: DEV_TARGET.account, region: DEV_TARGET.region, db: rds.database });
    session.idToken = idToken;
    session.testUserId = decodeJwtSub(idToken);
    session.endpoints = { ...rds, adminApiBaseUrl: process.env.SMOKE_ADMIN_API_URL! } as never;
    return { authed: true, testUserId: session.testUserId, db: rds.database };
  });

  tool(server, logger, 'smoke_admin_api',
    { method: z.string(), path: z.string(), body: z.record(z.unknown()).optional() },
    async ({ method, path, body }) => {
      const { idToken, endpoints } = requireAuth();
      const res = await fetch(`${(endpoints as { adminApiBaseUrl: string }).adminApiBaseUrl}${path as string}`, {
        method: method as string,
        headers: { Authorization: `Bearer ${idToken}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    });

  tool(server, logger, 'smoke_sql', { sql: z.string(), params: z.array(z.unknown()).optional() },
    async ({ sql, params }) => {
      if (!isSelectOnly(sql as string)) throw new Error('smoke_sql is SELECT-only');
      const { testUserId } = requireAuth();
      const rds = await resolveRdsConn();
      assertDevTarget({ account: DEV_TARGET.account, region: DEV_TARGET.region, db: rds.database });
      if (!session.tunnelStop) {
        const pf = await startPortForward({ /* per startPortForward args; see scripts/smoke */ } as never);
        session.tunnelStop = () => pf.stop();
      }
      const pw = await resolvePgPassword();
      const client = await connectRds({ host: rds.host, port: rds.port, database: rds.database, user: rds.user, password: pw, testUserId });
      try { return { rows: (await (client as unknown as { maybeRows(s: string, p: unknown[]): Promise<unknown[]> }).maybeRows(sql as string, (params as unknown[]) ?? [])) }; }
      finally { await client.close(); }
    });

  tool(server, logger, 'smoke_wait_pipeline', { pipelineRunId: z.string(), timeoutMs: z.number().optional() },
    async ({ pipelineRunId, timeoutMs }) => {
      const { testUserId } = requireAuth();
      const rds = await resolveRdsConn();
      const pw = await resolvePgPassword();
      const client = await connectRds({ host: rds.host, port: rds.port, database: rds.database, user: rds.user, password: pw, testUserId });
      try { return { status: await client.waitForPipelineStatus(pipelineRunId as string, (timeoutMs as number) ?? 600000, 5000) }; }
      finally { await client.close(); }
    });

  tool(server, logger, 'smoke_cleanup', {}, async () => {
    const { testUserId } = requireAuth();
    const rds = await resolveRdsConn();
    const pw = await resolvePgPassword();
    const client = await connectRds({ host: rds.host, port: rds.port, database: rds.database, user: rds.user, password: pw, testUserId });
    let removed = 0;
    try { for (const t of session.cleanup) { await client.cleanupRun(t); removed++; } session.cleanup = []; }
    finally { await client.close(); }
    if (session.tunnelStop) { session.tunnelStop(); session.tunnelStop = undefined; }
    return { removed };
  });
}
```

NOTE for implementer: `startPortForward` args + the exact `Endpoints` shape live in `scripts/smoke/port-forward.ts` / `types.ts`; wire the real fields (the `as never` placeholders mark where to read the actual signatures). Keep behaviour identical to how `connectRds`/tunnel are used in the existing smoke tests (`scripts/smoke/*.smoke.test.ts`).

- [ ] **Step 2: Build + typecheck**

Run: `yarn --cwd mcp-servers/tucaken-smoke typecheck && yarn --cwd mcp-servers/tucaken-smoke build`
Expected: clean; `dist/index.js` bundles the smoke-lib.

- [ ] **Step 3: Commit**

```bash
git add mcp-servers/tucaken-smoke/src/tools/primitives.ts
git commit -m "feat(tucaken-smoke): primitives — auth, admin_api, sql(SELECT-only), wait_pipeline, cleanup"
```

---

## Task 9: Primitive — job_logs (kubectl fallback)

**Files:**
- Modify: `mcp-servers/tucaken-smoke/src/tools/primitives.ts`

- [ ] **Step 1: Add `smoke_job_logs`** (kubectl-based; eks MCP is the AI's richer alternative)

```ts
  tool(server, logger, 'smoke_job_logs', { label: z.string().optional(), runId: z.string().optional() },
    async ({ label, runId }) => {
      const sel = (label as string) ?? (runId ? `run-id=${runId}` : '');
      const { execFileSync } = await import('node:child_process');
      const env = { ...process.env, AWS_PROFILE: 'dev-account', AWS_REGION: DEV_TARGET.region };
      const get = (args: string[]) => execFileSync('kubectl', args, { env, encoding: 'utf-8' });
      const pods = get(['get', 'pods', '-n', 'job-strategist', ...(sel ? ['-l', sel] : []), '-o', 'name']).trim();
      const logs = pods ? pods.split('\n').map(p => get(['logs', '-n', 'job-strategist', p, '--tail', '200'])).join('\n---\n') : '(no pods — Job may be TTL-cleaned)';
      return { pods: pods || '(none)', logs };
    });
```

- [ ] **Step 2: Build + typecheck**

Run: `yarn --cwd mcp-servers/tucaken-smoke typecheck`

- [ ] **Step 3: Commit**

```bash
git add mcp-servers/tucaken-smoke/src/tools/primitives.ts
git commit -m "feat(tucaken-smoke): smoke_job_logs (kubectl, dev profile)"
```

---

## Task 10: Wire AWS Labs MCPs + the custom MCP in .mcp.json

**Files:**
- Create: `.mcp.json`

- [ ] **Step 1: Write .mcp.json**

eks/cloudwatch/aws-api are AWS Labs servers via `uvx`, pinned to dev profile + read-only. The custom server runs the built bundle.

```json
{
  "mcpServers": {
    "tucaken-smoke": {
      "command": "node",
      "args": ["mcp-servers/tucaken-smoke/dist/index.js"],
      "env": { "AWS_PROFILE": "dev-account", "AWS_REGION": "eu-west-1" }
    },
    "eks": {
      "command": "uvx",
      "args": ["awslabs.eks-mcp-server@latest"],
      "env": { "AWS_PROFILE": "dev-account", "AWS_REGION": "eu-west-1", "FASTMCP_LOG_LEVEL": "ERROR" }
    },
    "cloudwatch": {
      "command": "uvx",
      "args": ["awslabs.cloudwatch-mcp-server@latest"],
      "env": { "AWS_PROFILE": "dev-account", "AWS_REGION": "eu-west-1", "FASTMCP_LOG_LEVEL": "ERROR" }
    },
    "aws-api": {
      "command": "uvx",
      "args": ["awslabs.aws-api-mcp-server@latest"],
      "env": { "AWS_PROFILE": "dev-account", "AWS_REGION": "eu-west-1", "READ_OPERATIONS_ONLY": "true", "FASTMCP_LOG_LEVEL": "ERROR" }
    }
  }
}
```

- [ ] **Step 2: Verify uvx availability + the eks server resolves (read-only smoke)**

Run: `which uvx && uvx awslabs.eks-mcp-server@latest --help 2>&1 | head -5`
Expected: help text (confirms the server is fetchable). If `uvx` missing, document `brew install uv` as a prerequisite in the README and proceed (the custom MCP works without the AWS Labs servers).

- [ ] **Step 3: Commit**

```bash
git add .mcp.json
git commit -m "chore(mcp): wire tucaken-smoke + AWS Labs eks/cloudwatch/aws-api (dev, read-only)"
```

---

## Task 11: Flow — seed_project_evidence (write, cleanup-registered)

**Files:**
- Modify: `mcp-servers/tucaken-smoke/src/tools/system-design.ts`

- [ ] **Step 1: Implement `smoke_seed_project_evidence`** (the only write tool; explicit INSERT, tagged, cleanup-registered)

```ts
/** @format */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionLogger } from '../logger.js';
import { tool } from './register.js';
import { session, requireAuth } from '../session.js';
import { assertDevTarget } from '../guards.js';
import { DEV_TARGET } from '../config.js';
import { validateSystemDesign } from '../validators.js';
import { resolveRdsConn, resolvePgPassword, connectRds, AdminApiClient } from '../../../scripts/smoke/lib/index.js';

async function devClient(testUserId: string) {
  const rds = await resolveRdsConn();
  assertDevTarget({ account: DEV_TARGET.account, region: DEV_TARGET.region, db: rds.database });
  const pw = await resolvePgPassword();
  return connectRds({ host: rds.host, port: rds.port, database: rds.database, user: rds.user, password: pw, testUserId });
}

export function registerSystemDesign(server: McpServer, logger: SessionLogger): void {
  tool(server, logger, 'smoke_seed_project_evidence',
    { projectName: z.string().optional(), components: z.array(z.object({ name: z.string(), kind: z.string() })) },
    async ({ projectName, components }) => {
      const { testUserId } = requireAuth();
      const client = await devClient(testUserId);
      try {
        const proj = (await (client as unknown as { assertRows(s: string, p: unknown[], w: string): Promise<unknown[]> }).assertRows(
          `INSERT INTO projects (user_id, name, is_ai_suggested, is_user_confirmed)
           VALUES ($1, $2, false, true) RETURNING id`,
          [testUserId, (projectName as string) ?? 'Smoke SD Project'], 'seed project'))[0] as { id: string };
        for (const c of components as Array<{ name: string; kind: string }>) {
          await (client as unknown as { assertRows(s: string, p: unknown[], w: string): Promise<unknown[]> }).assertRows(
            `INSERT INTO project_components (project_id, name, kind) VALUES ($1, $2, $3) RETURNING id`,
            [proj.id, c.name, c.kind], 'seed component');
        }
        session.cleanup.push({ flow: 'job-strategist', projectId: proj.id } as never);  // cleanupRun removes project + components (cascade)
        return { projectId: proj.id, components: (components as unknown[]).length };
      } finally { await client.close(); }
    });

  // run_strategist / run_coach / assert_system_design added in Task 12-13.
}
```

NOTE: confirm `projects`/`project_components` columns against migration `030_projects.sql` (names verified in the System Design work: `projects(user_id,name,is_ai_suggested,is_user_confirmed)`, `project_components(project_id,name,kind)`). Extend `CleanupTarget` + `RdsClient.cleanupRun` to handle a `projectId` target (cascade delete `projects` → `project_components` via FK). If `cleanupRun` lacks a project branch, add one in `scripts/smoke/rds-client.ts` (delete from projects where id=$1 and user_id=testUserId).

- [ ] **Step 2: Build + typecheck**

Run: `yarn --cwd mcp-servers/tucaken-smoke typecheck`

- [ ] **Step 3: Commit**

```bash
git add mcp-servers/tucaken-smoke/src/tools/system-design.ts scripts/smoke/rds-client.ts scripts/smoke/types.ts
git commit -m "feat(tucaken-smoke): smoke_seed_project_evidence + project cleanup target"
```

---

## Task 12: Flows — run_strategist + run_coach (confirm-on-spend)

**Files:**
- Modify: `mcp-servers/tucaken-smoke/src/tools/system-design.ts`

- [ ] **Step 1: Add both flow tools** (require `confirm:true` before any Bedrock spend)

```ts
  tool(server, logger, 'smoke_run_strategist',
    { company: z.string(), role: z.string(), jobDescription: z.string(), confirm: z.boolean() },
    async ({ company, role, jobDescription, confirm }) => {
      if (confirm !== true) return { skipped: true, reason: 'confirm:true required — this triggers Bedrock spend' };
      const { idToken, endpoints, testUserId } = requireAuth();
      const api = new AdminApiClient((endpoints as { adminApiBaseUrl: string }).adminApiBaseUrl, idToken);
      const { pipelineRunId, applicationId } = await api.startStrategist({ targetCompany: company as string, targetRole: role as string, jobDescription: jobDescription as string });
      session.cleanup.push({ flow: 'job-strategist', pipelineRunId, applicationId } as never);
      const client = await devClient(testUserId);
      try {
        const status = await client.waitForPipelineStatus(pipelineRunId, 600000, 5000);
        const apps = await (client as unknown as { assertRows(s: string, p: unknown[], w: string): Promise<unknown[]> }).assertRows(
          `SELECT id, slug FROM job_applications WHERE user_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY created_at DESC LIMIT 1`,
          [testUserId, applicationId ?? null], 'application');
        return { pipelineRunId, status, application: apps[0] };
      } finally { await client.close(); }
    });

  tool(server, logger, 'smoke_run_coach',
    { slug: z.string(), interviewStage: z.string(), confirm: z.boolean() },
    async ({ slug, interviewStage, confirm }) => {
      if (confirm !== true) return { skipped: true, reason: 'confirm:true required — this triggers Bedrock spend' };
      const { idToken, endpoints, testUserId } = requireAuth();
      const api = new AdminApiClient((endpoints as { adminApiBaseUrl: string }).adminApiBaseUrl, idToken);
      const { pipelineRunId } = await api.startCoach(slug as string, interviewStage as string);
      session.cleanup.push({ flow: 'job-strategist', pipelineRunId } as never);
      const client = await devClient(testUserId);
      try { return { pipelineRunId, status: await client.waitForPipelineStatus(pipelineRunId, 600000, 5000) }; }
      finally { await client.close(); }
    });
```

- [ ] **Step 2: Build + typecheck**

Run: `yarn --cwd mcp-servers/tucaken-smoke typecheck`

- [ ] **Step 3: Commit**

```bash
git add mcp-servers/tucaken-smoke/src/tools/system-design.ts
git commit -m "feat(tucaken-smoke): run_strategist + run_coach (confirm-on-spend)"
```

---

## Task 13: Flow — assert_system_design

**Files:**
- Modify: `mcp-servers/tucaken-smoke/src/tools/system-design.ts`

- [ ] **Step 1: Add `smoke_assert_system_design`** (reads coaching_content, runs the pure validator)

```ts
  tool(server, logger, 'smoke_assert_system_design',
    { slug: z.string(), tier: z.enum(['A', 'B']) },
    async ({ slug, tier }) => {
      const { idToken, endpoints } = requireAuth();
      const api = new AdminApiClient((endpoints as { adminApiBaseUrl: string }).adminApiBaseUrl, idToken);
      const coaching = await api.getCoaching(slug as string, 'system-design');
      // coaching_content.topics_to_study holds the full InterviewCoachResult JSON.
      const payload = (coaching as { topics_to_study?: unknown; topicsToStudy?: unknown })?.topics_to_study
        ?? (coaching as { topicsToStudy?: unknown })?.topicsToStudy ?? coaching;
      const verdict = validateSystemDesign(tier as 'A' | 'B', payload as never);
      return { tier, verdict, coaching: payload };
    });
```

NOTE: confirm the GET `/:slug/coaching/:stage` response shape against tucaken-app `applications.ts` (it selects `topics_to_study`). Adjust the field extraction to match (the row's `topics_to_study` is the full `InterviewCoachResult` incl. `systemDesignWalkthrough`/`systemDesignCoverage`).

- [ ] **Step 2: Full build + unit suite**

Run: `yarn --cwd mcp-servers/tucaken-smoke build && yarn --cwd mcp-servers/tucaken-smoke test`
Expected: build clean; all unit tests (guards, logger, validators) pass.

- [ ] **Step 3: Commit**

```bash
git add mcp-servers/tucaken-smoke/src/tools/system-design.ts
git commit -m "feat(tucaken-smoke): assert_system_design (Tier A/B verdict)"
```

---

## Task 14: Live System Design reference run (Tier A+B) + smoke-harness parity

**Files:** none (verification task)

- [ ] **Step 1: Confirm prerequisites on dev (read-only, via smoke_sql once the MCP is loaded, or psql tunnel)**

- `SELECT count(*) FROM system_design_concerns` → expect `14` (migration 065 seeded).
- Confirm `.env.smoke` has `SMOKE_COGNITO_USERNAME/PASSWORD` + `SMOKE_ADMIN_API_URL` (see smoke-e2e-env runbook; re-sync SSM↔GW key if admin-api 403s).

- [ ] **Step 2: Build the MCP so .mcp.json can launch it**

Run: `yarn --cwd mcp-servers/tucaken-smoke build`

- [ ] **Step 3: Drive the reference flow** (the agent calls the tools in order; confirm:true only after the user OKs spend)

1. `smoke_auth`
2. `smoke_seed_project_evidence { components:[{name:'Tenant RLS policy layer',kind:'backend'},{name:'Rate limiter middleware',kind:'backend'}] }`
3. `smoke_run_strategist { company:'Smoke Test Co', role:'Senior Platform Engineer', jobDescription:<JD>, confirm:true }`
4. `smoke_run_coach { slug:<slug>, interviewStage:'system-design', confirm:true }`
5. (observe) eks/cloudwatch MCPs → coach pod + Bedrock logs
6. `smoke_assert_system_design { slug:<slug>, tier:'B' }` → verdict ok
7. `smoke_cleanup` → removes seeded project + application + runs + coaching rows

Expected: Tier B verdict `ok:true`; cleanup removes all created rows.

- [ ] **Step 4: Confirm the existing jest smoke harness still passes (lib barrel didn't break it)**

Run: `just smoke-e2e job-strategist` (or at minimum `npx tsc --noEmit -p scripts/smoke/tsconfig.json`).
Expected: no regression.

- [ ] **Step 5: Commit any fixes surfaced during the live run**

```bash
git add -A && git commit -m "fix(tucaken-smoke): wire real port-forward/coaching shapes from live run"
```

---

## Self-review notes for the implementer
- The `as never`/`as unknown as` casts mark spots where the **real signatures** from `scripts/smoke/{port-forward,types,rds-client}.ts` and the tucaken-app coaching route must be wired in — replace them with the actual shapes during Task 8/11/13; do not ship the casts if the real types are available.
- `CleanupTarget` may need a `projectId` variant (Task 11) — extend `scripts/smoke/types.ts` + `RdsClient.cleanupRun` together.
- Confirm-on-spend lives in `run_strategist`/`run_coach` only; all reads are free.
- Everything pins to dev via `assertDevTarget`; never add account/region params to tools.
- If `uvx` isn't installed, the custom MCP still fully functions; AWS Labs MCPs are observation-only.
