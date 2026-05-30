# Projects: Onboarding Orchestrator + Clustering Triggers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every connected repo gets a default `single_repo` project (all plans); a confirmed multi_repo proposal archives the redundant pristine defaults; multi_repo clustering is wired to a Pro-gated trigger with feature gates enabled.

**Architecture:** Two PRs. **PR A** (tucaken-app/admin-api): two new repository helpers (`ensureDefaultProject`, `archiveSupersededDefaults`) called from the repo-insert sites and the confirm handler. **PR B**: a feature-gate seed migration (ai-applications), a Pro plan-gate on `POST /clustering/run` (admin-api), and frontend plan-gating of the already-built clustering trigger (tucaken-app). The review/confirm UI already exists.

**Tech Stack:** TypeScript, Hono (admin-api BFF), `pg` (raw SQL, no ORM), Jest + pg mock, Postgres RLS via `withUser`, TanStack Start server fns + React Query (frontend), K8s Job dispatch.

**Spec:** `docs/superpowers/specs/2026-05-30-projects-onboarding-and-clustering-triggers-design.md`

**Pre-work for the implementer:** Both repos must be on current `main`/`develop`. In `tucaken-app`, `git fetch origin && git checkout -b <branch> origin/main` (the local checkout was on a stale branch during planning). In `ai-applications`, branch off `origin/develop`.

---

## Key facts (verified against origin/main during planning)

- `admin-api/src/lib/repositories/projects.ts` uses `Queryable` (= `Pool | PoolClient`) for every function; imports `randomUUID` from `node:crypto` (see `splitProject`).
- `admin-api/src/routes/github.ts` `insertRepository(pool, userId, fullName, defaultBranch)` writes `repositories` via the **raw pool, which connects as superuser** (bypasses RLS). It does `INSERT … ON CONFLICT (user_id, provider, full_name) DO NOTHING` and returns `void` (no id).
- Three repo-insert call sites in `github.ts`: line ~351 (auto-dispatch/sync loop), ~960 (deferSync branch), ~985 (main dispatch path). All use the raw `pool`.
- `withUser(pool, uid, fn)` (in `admin-api/src/lib/pg.ts`) wraps a tx: `SET LOCAL ROLE tucaken_app` + `SET LOCAL app.current_user_id`. Used by the confirm handler and `/clustering/run`.
- Migration 031 slug rule: `lower(full_name)`, non-`[a-z0-9]+` → `-`, trim leading/trailing `-`. Component `name='Main'`, `kind='shared'`.
- `app_config` is keyed `(key TEXT PK, value JSONB)`. Feature flags read `value->>'enabled'`. Migrations live in `ai-applications/applications/platform-rds-bootstrap/migrations/`; highest is `043`.
- Frontend review flow already exists: `src/app/_dashboard/projects/review.tsx` → `ProjectReviewStep` → `useRunClustering()` + `useConfirmProject()`. `AuthUser` (`src/server/session.ts`) is `{ id, email }` — no `plan`.

---

## File Structure

**PR A (tucaken-app):**
- Modify `admin-api/src/lib/repositories/projects.ts` — add `ensureDefaultProject`, `archiveSupersededDefaults`, `deriveRepoSlug`.
- Modify `admin-api/src/routes/github.ts` — call `ensureDefaultProject` at the 3 repo-insert sites, wrapped so repo-insert + project-create are one transaction.
- Modify `admin-api/src/routes/projects.ts` — call `archiveSupersededDefaults` inside the confirm handler's `withUser` block; add `archivedDefaults` to the response.
- Tests: `admin-api/src/lib/repositories/projects.test.ts` (or new `projects-onboarding.test.ts`).

**PR B:**
- Create `ai-applications/applications/platform-rds-bootstrap/migrations/044_enable_project_features.sql`.
- Modify `tucaken-app/admin-api/src/routes/projects.ts` — Pro gate on `/clustering/run`.
- Modify `tucaken-app/src/server/session.ts` — add `plan` to `AuthUser` + `getUserSessionFn`.
- Modify `tucaken-app/src/features/projects/components/review/ProjectReviewStep.tsx` — hide run-clustering for non-pro.
- Tests: `admin-api/src/routes/projects.test.ts` (gate), frontend component test.

---

# PR A — Onboarding orchestrator

## Task 1: `deriveRepoSlug` helper

**Files:**
- Modify: `admin-api/src/lib/repositories/projects.ts`
- Test: `admin-api/src/lib/repositories/projects-onboarding.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```typescript
// admin-api/src/lib/repositories/projects-onboarding.test.ts
import { describe, it, expect } from '@jest/globals';
import { deriveRepoSlug } from './projects.js';

describe('deriveRepoSlug', () => {
  it('lower-cases and dashes the full name (mirrors migration 031)', () => {
    expect(deriveRepoSlug('Nelson-Lamounier/cdk-monitoring'))
      .toBe('nelson-lamounier-cdk-monitoring');
  });
  it('collapses runs of non-alphanumerics to a single dash', () => {
    expect(deriveRepoSlug('Owner/My__Repo..Name')).toBe('owner-my-repo-name');
  });
  it('trims leading and trailing dashes', () => {
    expect(deriveRepoSlug('__weird__/__name__')).toBe('weird-name');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `tucaken-app/`): `npx jest admin-api/src/lib/repositories/projects-onboarding.test.ts -t deriveRepoSlug`
Expected: FAIL — `deriveRepoSlug is not a function` / not exported.

- [ ] **Step 3: Implement `deriveRepoSlug`**

Add near the top of `admin-api/src/lib/repositories/projects.ts` (after imports):

```typescript
/**
 * Per-user project slug from a repo full_name. Mirrors migration 031:
 * lower-case, non-[a-z0-9] runs → single dash, trim leading/trailing dashes.
 */
export function deriveRepoSlug(fullName: string): string {
  return fullName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest admin-api/src/lib/repositories/projects-onboarding.test.ts -t deriveRepoSlug`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add admin-api/src/lib/repositories/projects.ts admin-api/src/lib/repositories/projects-onboarding.test.ts
git commit -m "feat(projects): add deriveRepoSlug helper (mirrors migration 031)"
```

---

## Task 2: `ensureDefaultProject` helper

**Files:**
- Modify: `admin-api/src/lib/repositories/projects.ts`
- Test: `admin-api/src/lib/repositories/projects-onboarding.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `projects-onboarding.test.ts`. Uses a fake `Queryable` recording queries; the guard `SELECT` decides create-vs-noop.

```typescript
import { ensureDefaultProject } from './projects.js';
import type { Queryable } from '../pg.js';

// Minimal Queryable stub. `existsRows` controls the NOT EXISTS guard result.
function fakeDb(existsRows: number) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const db = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      if (/SELECT 1 FROM project_repositories/i.test(sql)) {
        return { rows: existsRows > 0 ? [{ one: 1 }] : [], rowCount: existsRows };
      }
      if (/INSERT INTO projects/i.test(sql))           return { rows: [{ id: 'proj-1' }], rowCount: 1 };
      if (/INSERT INTO project_components/i.test(sql))  return { rows: [{ id: 'comp-1' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Queryable;
  return { db, calls };
}

describe('ensureDefaultProject', () => {
  it('no-ops when the repo already has a project_repositories link', async () => {
    const { db, calls } = fakeDb(1);
    await ensureDefaultProject(db, 'user-1', 'repo-1', 'Owner/repo');
    expect(calls.some(c => /INSERT INTO projects/i.test(c.sql))).toBe(false);
  });

  it('creates project + component + link when the repo has no project', async () => {
    const { db, calls } = fakeDb(0);
    await ensureDefaultProject(db, 'user-1', 'repo-1', 'Owner/My-Repo');
    const sqls = calls.map(c => c.sql).join(' || ');
    expect(sqls).toMatch(/INSERT INTO projects/i);
    expect(sqls).toMatch(/INSERT INTO project_components/i);
    expect(sqls).toMatch(/INSERT INTO project_repositories/i);
    // slug derived from full name
    const projInsert = calls.find(c => /INSERT INTO projects/i.test(c.sql))!;
    expect(projInsert.params).toContain('owner-my-repo');
    // single_repo shape, not AI-suggested
    expect(projInsert.sql).toMatch(/'single_repo'/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest admin-api/src/lib/repositories/projects-onboarding.test.ts -t ensureDefaultProject`
Expected: FAIL — `ensureDefaultProject is not a function`.

- [ ] **Step 3: Implement `ensureDefaultProject`**

Add to `admin-api/src/lib/repositories/projects.ts` (uses `randomUUID` already imported for `splitProject`; if not imported, add `import { randomUUID } from 'node:crypto';`):

```typescript
/**
 * Ensure a repo has a default single_repo project. Mirrors migration 031 for
 * one repo. Idempotent: no-ops if the repo already has any project_repositories
 * link. Runs against the caller's Queryable (Pool or PoolClient) — the caller
 * owns the transaction so repo-insert + project-create commit/rollback together.
 */
export async function ensureDefaultProject(
  db: Queryable,
  userId: string,
  repositoryId: string,
  repoFullName: string,
): Promise<void> {
  const guard = await db.query(
    `SELECT 1 FROM project_repositories WHERE repository_id = $1::uuid LIMIT 1`,
    [repositoryId],
  );
  if ((guard.rowCount ?? 0) > 0) return;

  const projectId   = randomUUID();
  const componentId = randomUUID();
  const slug        = deriveRepoSlug(repoFullName);
  const name        = repoFullName.split('/')[1] || repoFullName;

  await db.query(
    `INSERT INTO projects (
        id, user_id, slug, name, shape, is_ai_suggested, is_user_confirmed,
        status, role_exhibited, visibility
     ) VALUES (
        $1::uuid, $2::uuid, $3, $4, 'single_repo', FALSE, FALSE,
        'active', 'sole_builder', 'private'
     )
     ON CONFLICT (user_id, slug) DO NOTHING`,
    [projectId, userId, slug, name],
  );
  await db.query(
    `INSERT INTO project_components (id, user_id, project_id, name, kind, order_index)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'Main', 'shared', 0)`,
    [componentId, userId, projectId],
  );
  await db.query(
    `INSERT INTO project_repositories (user_id, project_component_id, repository_id, subpath)
     VALUES ($1::uuid, $2::uuid, $3::uuid, '')
     ON CONFLICT (project_component_id, repository_id, subpath) DO NOTHING`,
    [userId, componentId, repositoryId],
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest admin-api/src/lib/repositories/projects-onboarding.test.ts -t ensureDefaultProject`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add admin-api/src/lib/repositories/projects.ts admin-api/src/lib/repositories/projects-onboarding.test.ts
git commit -m "feat(projects): ensureDefaultProject — default single_repo project per repo"
```

---

## Task 3: Wire `ensureDefaultProject` into repo-insert sites (transactional)

**Files:**
- Modify: `admin-api/src/routes/github.ts:195-207` (insertRepository → return id + accept a Queryable)
- Modify: `admin-api/src/routes/github.ts` call sites (~351, ~960, ~985)

**Context:** `insertRepository` currently returns `void` and writes via raw `pool`. We need the repo id (for `ensureDefaultProject`) and a shared transaction so create-together/rollback-together holds (PR A failure stance = fatal). The raw pool connects as superuser, so no `withUser` is needed for these tables; we use a bare `BEGIN/COMMIT` on a dedicated client (pattern already used in `repositories/users.ts`).

- [ ] **Step 1: Write the failing test**

Add `admin-api/src/routes/__tests__/connect-repo-creates-project.test.ts` (follow the route test pattern in `admin-api/src/routes/*.test.ts`). Mock the pool client to assert that connecting a repo runs both the `repositories` INSERT and `ensureDefaultProject`'s `projects` INSERT in one transaction.

```typescript
import { describe, it, expect, jest } from '@jest/globals';

// Capture every SQL run on the transaction client.
const sqls: string[] = [];
const client = {
  query: jest.fn(async (sql: string) => {
    sqls.push(sql);
    if (/SELECT 1 FROM project_repositories/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO repositories/i.test(sql))           return { rows: [{ id: 'repo-1' }], rowCount: 1 };
    if (/INSERT INTO projects/i.test(sql))               return { rows: [{ id: 'p-1' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }),
  release: jest.fn(),
};

// Assert ordering: BEGIN → repositories insert → projects insert → COMMIT.
it('connecting a repo creates its default project in the same transaction', async () => {
  const { connectRepoWithDefaultProject } = await import('../github.js');
  await connectRepoWithDefaultProject(
    { connect: async () => client } as never,
    'user-1', 'Owner/repo', 'main',
  );
  const order = sqls.map(s =>
    /^BEGIN/i.test(s) ? 'BEGIN'
    : /INSERT INTO repositories/i.test(s) ? 'REPO'
    : /INSERT INTO projects/i.test(s) ? 'PROJ'
    : /^COMMIT/i.test(s) ? 'COMMIT' : '_');
  expect(order.filter(x => x !== '_')).toEqual(['BEGIN', 'REPO', 'PROJ', 'COMMIT']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest admin-api/src/routes/__tests__/connect-repo-creates-project.test.ts`
Expected: FAIL — `connectRepoWithDefaultProject` not exported.

- [ ] **Step 3: Extract a transactional helper + use it at all 3 sites**

In `admin-api/src/routes/github.ts`, replace the standalone `insertRepository` usage with a transactional helper. Add (exported for test):

```typescript
import { ensureDefaultProject } from '../lib/repositories/projects.js';

/**
 * Insert the repositories row AND its default single_repo project in one
 * transaction. Fatal-by-design: if project creation fails, the repo insert
 * rolls back too (a repo with no project is the bug we're preventing).
 * Uses the superuser pool (these tables are written without RLS today).
 */
export async function connectRepoWithDefaultProject(
  pool: Pool,
  userId: string,
  fullName: string,
  defaultBranch: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query<{ id: string }>(
      `INSERT INTO repositories (user_id, provider, full_name, default_branch, index_status)
       VALUES ($1::uuid, 'github', $2, $3, 'pending')
       ON CONFLICT (user_id, provider, full_name) DO UPDATE SET full_name = EXCLUDED.full_name
       RETURNING id`,
      [userId, fullName, defaultBranch],
    );
    const repoId = r.rows[0]!.id;
    await ensureDefaultProject(client, userId, repoId, fullName);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

Note: the original `insertRepository` used `DO NOTHING` (no RETURNING). The helper uses `DO UPDATE SET full_name = EXCLUDED.full_name` so `RETURNING id` always yields the row id even on conflict (idempotent: re-connecting an existing repo returns its id, and `ensureDefaultProject`'s guard then no-ops).

Replace the three call sites:
- Line ~351 (`await insertRepository(pool, userId, repo.full_name, repo.default_branch ?? 'main');`) → `await connectRepoWithDefaultProject(pool, userId, repo.full_name, repo.default_branch ?? 'main');`
- Line ~960 (deferSync) → `await connectRepoWithDefaultProject(pool, uid, repoFullName, defaultBranch);`
- Line ~985 (main path) → `await connectRepoWithDefaultProject(pool, uid, repoFullName, defaultBranch);`

Leave `markRepoPending` / `markSyncTriggered` calls as-is (they follow the insert). Keep the old `insertRepository` only if still referenced elsewhere; otherwise delete it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest admin-api/src/routes/__tests__/connect-repo-creates-project.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full admin-api suite + typecheck**

Run: `npx jest admin-api/ && npx tsc --noEmit -p admin-api/tsconfig.json`
Expected: all green (existing connected-repos tests still pass; if any asserted the old `DO NOTHING` SQL exactly, update them to the new helper).

- [ ] **Step 6: Commit**

```bash
git add admin-api/src/routes/github.ts admin-api/src/routes/__tests__/connect-repo-creates-project.test.ts
git commit -m "feat(projects): create default project transactionally on repo connect"
```

---

## Task 4: `archiveSupersededDefaults` helper

**Files:**
- Modify: `admin-api/src/lib/repositories/projects.ts`
- Test: `admin-api/src/lib/repositories/projects-onboarding.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { archiveSupersededDefaults } from './projects.js';

describe('archiveSupersededDefaults', () => {
  it('archives only pristine single_repo defaults for the confirmed project\'s repos', async () => {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const db = {
      query: async (sql: string, params: readonly unknown[] = []) => {
        calls.push({ sql, params });
        if (/UPDATE projects/i.test(sql)) {
          return { rows: [{ id: 'old-default-1' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Queryable;

    const archived = await archiveSupersededDefaults(db, 'user-1', 'confirmed-1');
    expect(archived).toEqual(['old-default-1']);
    const upd = calls.find(c => /UPDATE projects/i.test(c.sql))!;
    // Guard clauses present: single_repo, not confirmed, no case study, empty overrides.
    expect(upd.sql).toMatch(/status\s*=\s*'archived'/i);
    expect(upd.sql).toMatch(/shape\s*=\s*'single_repo'/i);
    expect(upd.sql).toMatch(/is_user_confirmed\s*=\s*FALSE/i);
    expect(upd.sql).toMatch(/case_study_status\s+IS\s+NULL/i);
    expect(upd.sql).toMatch(/user_overrides/i);
  });

  it('returns empty array when nothing matches', async () => {
    const db = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Queryable;
    expect(await archiveSupersededDefaults(db, 'user-1', 'confirmed-1')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest admin-api/src/lib/repositories/projects-onboarding.test.ts -t archiveSupersededDefaults`
Expected: FAIL — not a function.

- [ ] **Step 3: Implement `archiveSupersededDefaults`**

Add to `admin-api/src/lib/repositories/projects.ts`. Single `UPDATE … RETURNING` — finds pristine single_repo projects whose repo is in the confirmed project, excluding the confirmed project itself:

```typescript
/**
 * When a multi_repo proposal is confirmed, archive the now-redundant default
 * single_repo projects for the same repos — but ONLY pristine ones (untouched
 * by the user). Edited/published defaults survive for manual resolution.
 * Returns the archived project ids. Caller runs this inside withUser (RLS).
 */
export async function archiveSupersededDefaults(
  db: Queryable,
  userId: string,
  confirmedProjectId: string,
): Promise<string[]> {
  const r = await db.query<{ id: string }>(
    `UPDATE projects p
        SET status = 'archived', updated_at = NOW()
      WHERE p.user_id = $1::uuid
        AND p.id <> $2::uuid
        AND p.shape = 'single_repo'
        AND p.is_user_confirmed = FALSE
        AND p.case_study_status IS NULL
        AND COALESCE(p.user_overrides, '{}'::jsonb) = '{}'::jsonb
        AND p.status <> 'archived'
        AND EXISTS (
          SELECT 1
            FROM project_repositories def_pr
            JOIN project_components  def_pc ON def_pc.id = def_pr.project_component_id
           WHERE def_pc.project_id = p.id
             AND def_pr.repository_id IN (
               SELECT con_pr.repository_id
                 FROM project_repositories con_pr
                 JOIN project_components  con_pc ON con_pc.id = con_pr.project_component_id
                WHERE con_pc.project_id = $2::uuid
             )
        )
      RETURNING p.id`,
    [userId, confirmedProjectId],
  );
  return r.rows.map((row) => row.id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest admin-api/src/lib/repositories/projects-onboarding.test.ts -t archiveSupersededDefaults`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add admin-api/src/lib/repositories/projects.ts admin-api/src/lib/repositories/projects-onboarding.test.ts
git commit -m "feat(projects): archiveSupersededDefaults — retire pristine defaults on confirm"
```

---

## Task 5: Call `archiveSupersededDefaults` in the confirm handler

**Files:**
- Modify: `admin-api/src/routes/projects.ts` (the `POST /:id/confirm` handler, ~line 291-318)

- [ ] **Step 1: Write the failing test**

In `admin-api/src/routes/projects.test.ts` (follow existing route-test setup there), add a case asserting the confirm response includes `archivedDefaults`. If route tests mock `withUser`, make the mock run the callback against a fake db whose `UPDATE projects … RETURNING` yields one archived id; assert the JSON body contains `archivedDefaults: ['<id>']`.

```typescript
it('confirm archives superseded defaults and returns their ids', async () => {
  // Arrange: fake db returns one archived default from archiveSupersededDefaults' UPDATE.
  // (Wire via the same withUser mock the other confirm tests use.)
  const res = await app.request('/api/admin/projects/<proposal-uuid>/confirm', { method: 'POST', headers: authHeaders });
  const body = await res.json();
  expect(res.status).toBe(202);
  expect(body.archivedDefaults).toEqual(expect.arrayContaining(['<archived-id>']));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest admin-api/src/routes/projects.test.ts -t "archives superseded"`
Expected: FAIL — `archivedDefaults` undefined in response.

- [ ] **Step 3: Wire the helper into the confirm transaction**

In the confirm handler, inside the existing `withUser` block, after the `UPDATE projects SET is_user_confirmed = TRUE …` query, capture archived ids; thread them out through the `guarded` result and into the response.

```typescript
// import at top:
import { archiveSupersededDefaults } from '../lib/repositories/projects.js';

// inside withUser, replace `return { ok: true as const };` with:
const archivedDefaults = await archiveSupersededDefaults(db, uid, id);
return { ok: true as const, archivedDefaults };
```

Then both success responses include it. In the `dispatch.ok` branch:

```typescript
return ctx.json({
  confirmed:      true,
  dispatched:     true,
  pipelineRunId:  dispatch.pipelineRunId,
  jobName:        dispatch.jobName,
  projectId:      id,
  archivedDefaults: guarded.archivedDefaults,
}, 202);
```

And in the non-fatal `dispatched: false` branch, add `archivedDefaults: guarded.archivedDefaults,` likewise.

TypeScript note: the `withUser` callback now returns a discriminated union. After the `if (!guarded.ok) return …` guard, TS narrows `guarded` to the `ok: true` variant, so `guarded.archivedDefaults` is available in both success branches. The variant shapes:

```typescript
// the two returns inside the withUser callback:
//   { ok: false, code: 404 | 409, msg: string }
//   { ok: true,  archivedDefaults: string[] }
```

No explicit annotation needed if both `return` statements use `as const` on `ok` (the 404/409 returns already use `as const`; the success return uses `ok: true as const`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest admin-api/src/routes/projects.test.ts -t "archives superseded"`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck**

Run: `npx jest admin-api/ && npx tsc --noEmit -p admin-api/tsconfig.json`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add admin-api/src/routes/projects.ts admin-api/src/routes/projects.test.ts
git commit -m "feat(projects): archive superseded defaults on proposal confirm"
```

---

## Task 6: Open PR A

- [ ] **Step 1: Push + PR**

```bash
git push -u origin <pr-a-branch>
gh pr create --base main --title "feat(projects): onboarding orchestrator — default project per repo + dedup on confirm" --body "Implements PR A of the onboarding+clustering spec. ensureDefaultProject at every repo-connect site (transactional, fatal); archiveSupersededDefaults retires pristine single_repo defaults when a multi_repo proposal is confirmed. Tests + typecheck green."
```

---

# PR B — Clustering triggers + gates

## Task 7: Feature-gate seed migration (ai-applications)

**Files:**
- Create: `ai-applications/applications/platform-rds-bootstrap/migrations/044_enable_project_features.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 044_enable_project_features.sql
--
-- Enable the projects clustering + case-study feature gates. run-clustering.ts
-- and run-case-study.ts check these app_config keys at startup and silently
-- skip when absent/disabled. Idempotent: ON CONFLICT DO UPDATE.

BEGIN;

INSERT INTO app_config (key, value) VALUES
  ('projects.clustering.enabled', '{"enabled": true}'::jsonb),
  ('projects.case_study.enabled', '{"enabled": true}'::jsonb)
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value, updated_at = NOW();

COMMIT;
```

- [ ] **Step 2: Verify it parses + is idempotent against a local/dev Postgres (optional but recommended)**

If a local Postgres or the dev tunnel is available, apply it twice and confirm no error and a single row per key:

Run: `psql "$PG" -f applications/platform-rds-bootstrap/migrations/044_enable_project_features.sql && psql "$PG" -f applications/platform-rds-bootstrap/migrations/044_enable_project_features.sql`
Then: `psql "$PG" -c "SELECT key, value FROM app_config WHERE key LIKE 'projects.%';"`
Expected: two rows, both `{"enabled": true}`, second apply errors-free.

- [ ] **Step 3: Commit**

```bash
git add applications/platform-rds-bootstrap/migrations/044_enable_project_features.sql
git commit -m "feat(rds-bootstrap): enable projects clustering + case-study feature gates (044)"
```

> After merge to develop, CI rebuilds the bootstrap image (it watches `applications/platform-rds-bootstrap/**`); the GitOps tag must be bumped to that image for ArgoCD to apply it (per platform-rds-bootstrap README). Break-glass: `AWS_PROFILE=dev-account just db-bootstrap-run`.

---

## Task 8: Pro plan-gate on `POST /clustering/run` (admin-api)

**Files:**
- Modify: `tucaken-app/admin-api/src/routes/projects.ts` (the `/clustering/run` handler, ~line 526)

- [ ] **Step 1: Write the failing test**

In `admin-api/src/routes/projects.test.ts`:

```typescript
it('POST /clustering/run returns 403 for a free-plan user', async () => {
  // Arrange: pool query for `SELECT plan FROM users` returns { plan: 'free' }.
  const res = await app.request('/api/admin/projects/clustering/run', { method: 'POST', headers: authHeaders });
  expect(res.status).toBe(403);
  expect((await res.json()).error).toMatch(/Pro/i);
});

it('POST /clustering/run proceeds for a pro-plan user', async () => {
  // Arrange: `SELECT plan` returns { plan: 'pro' }; K8s + insertPipelineRun mocked ok.
  const res = await app.request('/api/admin/projects/clustering/run', { method: 'POST', headers: authHeaders });
  expect(res.status).toBe(202);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest admin-api/src/routes/projects.test.ts -t "clustering/run"`
Expected: FAIL — free user currently gets 202 (no gate).

- [ ] **Step 3: Add the gate**

In the `/clustering/run` handler, immediately after the `uid` check and before the image lookup:

```typescript
const pool = getPool(config);

// Pro-only: multi_repo clustering is a paid feature. Hard server guard
// (the UI also hides this for non-pro, but never trust the client).
const planRes = await pool.query<{ plan: string }>(
  `SELECT plan FROM users WHERE id = $1::uuid`,
  [uid],
);
if ((planRes.rows[0]?.plan ?? 'free') !== 'pro') {
  return ctx.json({ error: 'Multi-repo projects require Pro' }, 403);
}
```

(Remove the later duplicate `const pool = getPool(config);` if this introduces one — declare `pool` once at the top of the handler.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest admin-api/src/routes/projects.test.ts -t "clustering/run"`
Expected: PASS (both cases).

- [ ] **Step 5: Full suite + typecheck**

Run: `npx jest admin-api/ && npx tsc --noEmit -p admin-api/tsconfig.json`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add admin-api/src/routes/projects.ts admin-api/src/routes/projects.test.ts
git commit -m "feat(projects): gate POST /clustering/run behind Pro plan"
```

---

## Task 9: Expose `plan` in the session (frontend)

**Files:**
- Modify: `tucaken-app/src/server/session.ts` (`AuthUser` + `getUserSessionFn`)

- [ ] **Step 1: Write the failing test**

If `session.ts` has a test, add a case; else add `src/server/__tests__/session.test.ts` asserting the resolved user includes `plan`. (Match how the JWT→user mapping is tested elsewhere; if the session reads only JWT claims today, the test asserts `plan` defaults to `'free'` when absent and reflects the looked-up value otherwise.)

```typescript
it('AuthUser carries plan (defaults to free)', async () => {
  // With a valid session cookie and a users row plan='pro', expect user.plan==='pro'.
  // With no plan available, expect 'free'.
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/server/__tests__/session.test.ts`
Expected: FAIL — `plan` not on `AuthUser`.

- [ ] **Step 3: Add `plan`**

In `src/server/session.ts`:

```typescript
export interface AuthUser {
  id: string
  email: string
  plan: string   // 'free' | 'pro' — drives UI gating; server enforces the hard gate
}
```

In `getUserSessionFn`, after resolving the authenticated user id, look up the plan (via the existing admin-api `/me`-style call or a direct query if the session server already hits the DB). Populate `plan` (default `'free'` on any miss). Keep this resilient — a plan-lookup failure must not break auth; default to `'free'`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/server/__tests__/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/session.ts src/server/__tests__/session.test.ts
git commit -m "feat(auth): expose user plan in session for UI gating"
```

---

## Task 10: Hide the clustering trigger for non-pro (frontend)

**Files:**
- Modify: `tucaken-app/src/features/projects/components/review/ProjectReviewStep.tsx`
- Test: `tucaken-app/src/__tests__/features/projects/ProjectReviewStep.test.tsx` (exists)

- [ ] **Step 1: Write the failing test**

Add to the existing `ProjectReviewStep.test.tsx`:

```typescript
it('hides the run-clustering action for free-plan users', () => {
  // Render with a session/context where user.plan === 'free'.
  // Expect the "Find multi-repo projects" / run-clustering trigger NOT in the document.
});
it('shows the run-clustering action for pro-plan users', () => {
  // user.plan === 'pro' → trigger present and enabled.
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/__tests__/features/projects/ProjectReviewStep.test.tsx -t clustering`
Expected: FAIL — action renders regardless of plan.

- [ ] **Step 3: Gate the trigger**

In `ProjectReviewStep.tsx`, read the session plan (via the router auth context / a `useUserSession`-style hook — match how other components read `AuthUser`). Render the `useRunClustering` trigger only when `plan === 'pro'`. For free users, render nothing (or a disabled "Upgrade to Pro" affordance — minimal: render nothing, per the approved "hidden" decision). Leave the proposal list + confirm/dismiss flow unchanged (those only show when proposals already exist, which only pro could have created).

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/__tests__/features/projects/ProjectReviewStep.test.tsx`
Expected: PASS (existing tests still pass + 2 new).

- [ ] **Step 5: Full frontend check**

Run: `npx jest src/ && npx tsc --noEmit`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/features/projects/components/review/ProjectReviewStep.tsx src/__tests__/features/projects/ProjectReviewStep.test.tsx
git commit -m "feat(projects): hide multi-repo clustering trigger for non-pro users"
```

---

## Task 11: Open PR B + end-to-end proof

- [ ] **Step 1: Push admin-api/frontend branch + PR (tucaken-app)**

```bash
git push -u origin <pr-b-tucaken-branch>
gh pr create --base main --title "feat(projects): Pro-gate clustering trigger + UI gating" --body "PR B (tucaken-app side): Pro plan-gate on POST /clustering/run; expose plan in session; hide the clustering trigger for non-pro. Pairs with ai-applications migration 044 (feature gates). Tests + typecheck green."
```

- [ ] **Step 2: Push migration branch + PR (ai-applications)** — already committed in Task 7; push + PR if not done.

```bash
git push -u origin <pr-b-migration-branch>
gh pr create --base develop --title "feat(rds-bootstrap): enable projects feature gates (044)" --body "Seed migration enabling projects.clustering.enabled + projects.case_study.enabled. Required for PR B clustering to run."
```

- [ ] **Step 3: End-to-end proof (manual, dev — after both PRs merge + bootstrap re-runs)**

Using the existing 2-repo pro user `1d4c645a` (cdk-monitoring + ai-applications):
1. Confirm gates live: `SELECT key, value FROM app_config WHERE key LIKE 'projects.%';` → both enabled.
2. Trigger clustering (UI as pro, or dispatch the Job) → wait for the `pipeline_runs` clustering row to reach `complete`.
3. Verify a `multi_repo` proposal exists: `SELECT slug, shape, is_ai_suggested, proposal_confidence FROM projects WHERE user_id='1d4c645a-...' AND shape='multi_repo';`
4. Confirm the proposal via `POST /:id/confirm` → response includes `archivedDefaults`; verify the two single_repo defaults for those repos now have `status='archived'` and a case-study Job dispatched.

Document the result; close the original "prove clustering end-to-end" thread.

---

## Notes for the implementer

- **RLS:** PR A's repo-insert path uses the **superuser pool** (no `withUser`) because `repositories`/`repo_sync_state` are written that way today; `ensureDefaultProject` receives that same transaction client and sets `user_id` explicitly. The confirm handler (Task 5) runs inside `withUser`, so `archiveSupersededDefaults` is RLS-scoped there — correct and intended.
- **Idempotency:** `ensureDefaultProject` guards on `project_repositories`; safe to call from all sites and re-runs.
- **No schema changes in PR A** — only the migration in PR B (044), and it only seeds `app_config`.
- **Stale-checkout trap:** re-read these files from `origin/main` before editing if the local checkout is old.
