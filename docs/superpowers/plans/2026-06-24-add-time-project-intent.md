# Add-time Project intent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At repo **Add** time let the user choose Build-new-Project / Link-to-existing-Project / KB-only; apply the choice **after the sync completes** (project confirm/merge in the ingestion Job; case-study Job dispatched by an admin-api reconciler).

**Architecture:** The intent is captured in a new `ProjectIntentModal` on Add, threaded through `POST /connected-repos`, and stamped on the repo's default project (`post_sync_action` + `post_sync_target_project_id`, new columns). The ingestion Job applies the DB part on successful completion. A light admin-api reconciler dispatches the case-study Job for confirmed `case_study_status='pending'` projects. Reuses `ensureDefaultProject`, `dispatchCaseStudyJob`, and the merge/regenerate path.

**Tech Stack:** tucaken-app (TanStack Start frontend + vitest; Hono admin-api + jest), ai-applications (platform-rds-bootstrap migration; ingestion worker + jest). Cross-repo.

## Global Constraints

- English (UK) in comments/prose; NO non-ASCII characters in code/comments (ASCII `--`, plain quotes).
- ESLint clean on changed files; no `Co-Authored-By: Claude` trailer; `git commit --no-verify`.
- TDD: failing test first. Frontend = `npx vitest run <path>`; tucaken-app admin-api = `cd admin-api && NODE_OPTIONS='--experimental-vm-modules' npx jest <path>`; ai-applications = `cd applications/<pkg> && npx jest <path>`. ESM/NodeNext (`.js` import extensions).
- **Back-compat:** a connect with NO `projectIntent` behaves exactly as today (KB-only; `post_sync_action` stays NULL).
- **RLS:** every project mutation runs under the user's RLS context (`SELECT set_config('app.current_user_id', $1, true)` inside the txn) — match the existing `withUser`/`ensureDefaultProject` callers.
- **Fail-open / non-fatal:** the ingestion apply step MUST NOT fail the sync; the reconciler MUST be idempotent + debounced (no duplicate Jobs).
- Migrations: numbered, **idempotent** (`ADD COLUMN IF NOT EXISTS`, idempotent GRANTs), header comment; next free number is **102**; runner is `applications/platform-rds-bootstrap/src/bootstrap.ts` (ledger + checksum — never edit an applied migration).
- Branches: ai-applications work on `spec/add-time-project-intent` (spec already committed there); tucaken-app work on a new `feat/add-time-project-intent` off `main`. Stage only the files each task names.
- Scope: the **direct Add** path (`deferSync=false`) only — the onboarding deferred-queue carries no per-repo intent (same boundary the `enrichment` toggle uses).

## File Structure

**ai-applications**
- `applications/platform-rds-bootstrap/migrations/102_projects_post_sync_action.sql` — the two columns.
- `applications/ingestion/src/util/applyPostSyncProjectAction.ts` — reads + applies a default project's `post_sync_action` (build/link) against the DB. Pure-ish (takes a pool).
- `applications/ingestion/src/run-ingestion.ts` — call it best-effort at successful completion.

**tucaken-app**
- `admin-api/src/lib/repositories/projects.ts` — `stampProjectIntent` + extend `ensureDefaultProject`/`connectRepoWithDefaultProject` to carry the intent.
- `admin-api/src/routes/github.ts` — `POST /connected-repos` accepts + validates `projectIntent`/`targetProjectId`.
- `admin-api/src/lib/case-study-reconciler.ts` — the interval reconciler; started from `admin-api/src/index.ts`.
- `src/features/github/components/ProjectIntentModal.tsx` — the modal.
- `src/features/github/components/GitHubRepoPicker.tsx` + `hooks/use-github-ingestion.ts` + `src/server/github.ts` — thread the intent.
- `src/features/projects/components/index/ProjectsIndex.tsx` (+ a small card) — surface pending-action defaults.

---

### Task 1: Migration 102 — post-sync action columns (ai-applications)

**Files:**
- Create: `applications/platform-rds-bootstrap/migrations/102_projects_post_sync_action.sql`

**Interfaces:**
- Produces: `projects.post_sync_action TEXT` (`'build' | 'link' | NULL`), `projects.post_sync_target_project_id UUID`.

- [ ] **Step 1: Write the migration (idempotent)**

Create `applications/platform-rds-bootstrap/migrations/102_projects_post_sync_action.sql`:

```sql
-- 102_projects_post_sync_action.sql
--
-- Add-time Project intent: a repo's default project can carry an action to apply
-- AFTER its first sync completes -- 'build' (confirm + generate a case study) or
-- 'link' (merge this repo into post_sync_target_project_id + regenerate). NULL
-- means no pending action (KB-only / already applied). Set by the connect route
-- from the user's Add-time choice; cleared by the ingestion Job once applied.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; the CHECK is added only when absent.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS post_sync_action          TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS post_sync_target_project_id UUID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.constraint_column_usage
        WHERE table_name = 'projects' AND constraint_name = 'projects_post_sync_action_chk'
    ) THEN
        ALTER TABLE projects
            ADD CONSTRAINT projects_post_sync_action_chk
            CHECK (post_sync_action IS NULL OR post_sync_action IN ('build', 'link'));
    END IF;
END $$;
```

- [ ] **Step 2: Verify it parses (psql dry-run against a scratch db OR syntax check)**

Run: `psql -h 127.0.0.1 -p 15432 -U postgres -d tucaken -v ON_ERROR_STOP=1 -f applications/platform-rds-bootstrap/migrations/102_projects_post_sync_action.sql`
Expected: `ALTER TABLE` x2 + `DO` succeed; re-running is a no-op (idempotent). (If no DB tunnel, at minimum run `psql -f ... --no-psqlrc` against a local empty `projects` table, or have the reviewer confirm syntax.)

- [ ] **Step 3: Confirm columns exist**

Run: `psql ... -tAc "SELECT column_name FROM information_schema.columns WHERE table_name='projects' AND column_name LIKE 'post_sync%' ORDER BY 1"`
Expected: `post_sync_action` and `post_sync_target_project_id`.

- [ ] **Step 4: Commit**

```bash
git add applications/platform-rds-bootstrap/migrations/102_projects_post_sync_action.sql
git commit --no-verify -m "feat(db): migration 102 -- projects.post_sync_action + target for Add-time intent"
```

---

### Task 2: admin-api — accept + stamp the project intent (tucaken-app)

**Files:**
- Modify: `admin-api/src/lib/repositories/projects.ts` (add `stampProjectIntent`; thread an optional intent through `ensureDefaultProject` is NOT needed — stamp separately after it)
- Modify: `admin-api/src/routes/github.ts` (`connectRepoWithDefaultProject` + `POST /connected-repos` parsing)
- Test: `admin-api/src/lib/repositories/projects-onboarding.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `Queryable` (existing).
- Produces:
  - `export type ProjectIntent = { action: 'build' } | { action: 'link'; targetProjectId: string }`
  - `stampProjectIntent(db: Queryable, userId: string, repoFullName: string, intent: ProjectIntent): Promise<void>` — sets `post_sync_action`/`post_sync_target_project_id` on the repo's `single_repo` default project (matched by slug from `deriveRepoSlug(repoFullName)`).
  - `connectRepoWithDefaultProject(pool, userId, fullName, defaultBranch, githubRepoId, intent?)` gains an optional 6th arg; when present it `stampProjectIntent`s inside the same transaction.

- [ ] **Step 1: Write the failing test**

In `admin-api/src/lib/repositories/projects-onboarding.test.ts`, add (reuse the file's `Queryable` stub style):

```typescript
import { stampProjectIntent } from './projects.js';

describe('stampProjectIntent', () => {
  function db(capture: { sql: string; params: readonly unknown[] }[]) {
    return { query: async (sql: string, params: readonly unknown[] = []) => { capture.push({ sql, params }); return { rows: [], rowCount: 1 }; } } as unknown as import('../pg.js').Queryable;
  }
  it('build: sets post_sync_action=build on the single_repo default by slug', async () => {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    await stampProjectIntent(db(calls), 'user-1', 'Owner/My-Repo', { action: 'build' });
    const u = calls.find(c => /UPDATE projects/i.test(c.sql))!;
    expect(u.sql).toMatch(/post_sync_action\s*=\s*\$/i);
    expect(u.sql).toMatch(/shape\s*=\s*'single_repo'/i);
    expect(u.params).toEqual(['user-1', 'owner-my-repo', 'build', null]);
  });
  it('link: stores the target project id', async () => {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    await stampProjectIntent(db(calls), 'user-1', 'Owner/My-Repo', { action: 'link', targetProjectId: 'proj-9' });
    const u = calls.find(c => /UPDATE projects/i.test(c.sql))!;
    expect(u.params).toEqual(['user-1', 'owner-my-repo', 'link', 'proj-9']);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd admin-api && NODE_OPTIONS='--experimental-vm-modules' npx jest src/lib/repositories/projects-onboarding.test.ts -t stampProjectIntent`
Expected: FAIL — `stampProjectIntent is not a function`.

- [ ] **Step 3: Implement `stampProjectIntent` + the connect arg**

In `admin-api/src/lib/repositories/projects.ts`, after `ensureDefaultProject`, add:

```typescript
export type ProjectIntent = { action: 'build' } | { action: 'link'; targetProjectId: string };

/**
 * Stamp a post-sync action on a repo's single_repo DEFAULT project (matched by
 * the slug deriveRepoSlug yields). Applied by the ingestion Job once the first
 * sync completes. Caller owns the transaction + RLS context.
 */
export async function stampProjectIntent(
  db: Queryable,
  userId: string,
  repoFullName: string,
  intent: ProjectIntent,
): Promise<void> {
  const slug = deriveRepoSlug(repoFullName);
  const target = intent.action === 'link' ? intent.targetProjectId : null;
  await db.query(
    `UPDATE projects
        SET post_sync_action = $3,
            post_sync_target_project_id = $4::uuid,
            updated_at = NOW()
      WHERE user_id = $1::uuid AND slug = $2 AND shape = 'single_repo'`,
    [userId, slug, intent.action, target],
  );
}
```

In `admin-api/src/routes/github.ts`, change `connectRepoWithDefaultProject` to take an optional intent and stamp it in the same txn (after `ensureDefaultProject(client, ...)`):

```typescript
export async function connectRepoWithDefaultProject(
    pool: Pool,
    userId: string,
    fullName: string,
    defaultBranch: string,
    githubRepoId: number,
    intent?: ProjectIntent,
): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
        const r = await client.query<{ id: string }>(
            `INSERT INTO repositories (user_id, provider, full_name, default_branch, index_status, github_repo_id)
             VALUES ($1::uuid, 'github', $2, $3, 'pending', $4)
             ON CONFLICT (user_id, github_repo_id) DO UPDATE SET full_name = EXCLUDED.full_name
             RETURNING id`,
            [userId, fullName, defaultBranch, githubRepoId],
        );
        const repoId = r.rows[0]!.id;
        await ensureDefaultProject(client, userId, repoId, fullName);
        if (intent) await stampProjectIntent(client, userId, fullName, intent);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}
```

(Import `ProjectIntent`, `stampProjectIntent` from `../lib/repositories/projects.js`. If `set_config` was not already in this function, adding it is correct — RLS context for the stamp; verify the existing function did not rely on RLS being off.)

- [ ] **Step 4: Parse + validate the intent in `POST /connected-repos`**

In the `POST /connected-repos` handler, extend the body type + parse (after the `enrichment` line):

```typescript
        let body: { repoFullName?: string; defaultBranch?: string; forceReindex?: boolean; deferSync?: boolean; enrichment?: 'premium' | 'free'; projectIntent?: 'build' | 'link' | 'none'; targetProjectId?: string };
        // ... existing parse ...
        const rawIntent = body.projectIntent;
        let intent: ProjectIntent | undefined;
        if (rawIntent === 'build') {
            intent = { action: 'build' };
        } else if (rawIntent === 'link') {
            const target = body.targetProjectId?.trim();
            if (!target) return ctx.json({ error: '"targetProjectId" is required when projectIntent is "link"' }, 400);
            // Target must be a confirmed project owned by the caller.
            const ok = await pool.query<{ one: number }>(
                `SELECT 1 AS one FROM projects WHERE id = $1::uuid AND user_id = $2::uuid AND is_user_confirmed = TRUE AND status <> 'archived' LIMIT 1`,
                [target, uid],
            );
            if (ok.rowCount === 0) return ctx.json({ error: 'targetProjectId is not a confirmed project you own' }, 400);
            intent = { action: 'link', targetProjectId: target };
        }
        // 'none'/undefined -> KB-only -> intent stays undefined (back-compat).
```

Pass `intent` to BOTH the deferSync connect and the direct connect:
```typescript
await connectRepoWithDefaultProject(pool, uid, repoFullName, defaultBranch, deferId, intent);
// ... and on the direct path:
await connectRepoWithDefaultProject(pool, uid, repoFullName, defaultBranch, id, intent);
```

- [ ] **Step 5: Run the tests + lint**

Run: `cd admin-api && NODE_OPTIONS='--experimental-vm-modules' npx jest src/lib/repositories/projects-onboarding.test.ts && npx tsc --noEmit && npx eslint src/lib/repositories/projects.ts src/routes/github.ts`
Expected: green; no type/lint errors.

- [ ] **Step 6: Commit**

```bash
git add admin-api/src/lib/repositories/projects.ts admin-api/src/routes/github.ts admin-api/src/lib/repositories/projects-onboarding.test.ts
git commit --no-verify -m "feat(admin-api): accept + stamp Add-time project intent on the default project"
```

---

### Task 3: Ingestion — apply the intent at sync-completion (ai-applications)

**Files:**
- Create: `applications/ingestion/src/util/applyPostSyncProjectAction.ts`
- Test: `applications/ingestion/src/util/applyPostSyncProjectAction.test.ts`
- Modify: `applications/ingestion/src/run-ingestion.ts` (best-effort call near the end of a successful run)

**Interfaces:**
- Produces: `applyPostSyncProjectAction(pool: Pool, userId: string, repoFullName: string): Promise<'build' | 'link' | 'none'>` — reads the repo's `single_repo` default project's `post_sync_action`; applies it; clears it; returns what it did. Never throws into the caller.

- [ ] **Step 1: Write the failing test**

Create `applications/ingestion/src/util/applyPostSyncProjectAction.test.ts`:

```typescript
/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { applyPostSyncProjectAction } from './applyPostSyncProjectAction.js';

function poolFrom(rows: Record<string, unknown>[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/SELECT .*post_sync_action/i.test(sql)) return { rows, rowCount: rows.length };
    return { rows: [], rowCount: 1 };
  });
  return { pool: { query } as never, calls };
}

describe('applyPostSyncProjectAction', () => {
  it('build: confirms the default project + sets case_study_status pending + clears the action', async () => {
    const { pool, calls } = poolFrom([{ id: 'proj-1', post_sync_action: 'build', post_sync_target_project_id: null }]);
    const out = await applyPostSyncProjectAction(pool, 'u1', 'Owner/Repo');
    expect(out).toBe('build');
    const upd = calls.find(c => /UPDATE projects/i.test(c.sql) && /is_user_confirmed\s*=\s*TRUE/i.test(c.sql))!;
    expect(upd.sql).toMatch(/case_study_status\s*=\s*'pending'/i);
    expect(upd.sql).toMatch(/post_sync_action\s*=\s*NULL/i);
  });
  it('none: no-op when there is no pending action', async () => {
    const { pool } = poolFrom([{ id: 'proj-1', post_sync_action: null, post_sync_target_project_id: null }]);
    expect(await applyPostSyncProjectAction(pool, 'u1', 'Owner/Repo')).toBe('none');
  });
  it('never throws -- a query error resolves to none', async () => {
    const pool = { query: jest.fn(async () => { throw new Error('boom'); }) } as never;
    await expect(applyPostSyncProjectAction(pool, 'u1', 'Owner/Repo')).resolves.toBe('none');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd applications/ingestion && npx jest src/util/applyPostSyncProjectAction.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `applyPostSyncProjectAction.ts`**

Create `applications/ingestion/src/util/applyPostSyncProjectAction.ts`:

```typescript
/** @format */
import type { Pool } from 'pg';

/**
 * After a successful sync, apply the Add-time intent stamped on the repo's
 * single_repo default project. build -> confirm + queue a case study; link ->
 * move the repo into the target project + queue the target's case study; clears
 * post_sync_action either way. Sets RLS context. NEVER throws into the caller --
 * a failure leaves the intent pending so the user can finish it from the UI.
 * Does NOT dispatch the case-study Job (the admin-api reconciler does).
 */
export async function applyPostSyncProjectAction(
  pool: Pool,
  userId: string,
  repoFullName: string,
): Promise<'build' | 'link' | 'none'> {
  const client = await pool.connect().catch(() => null);
  if (!client) return 'none';
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
    const { rows } = await client.query<{ id: string; post_sync_action: string | null; post_sync_target_project_id: string | null }>(
      `SELECT p.id, p.post_sync_action, p.post_sync_target_project_id
         FROM projects p
         JOIN project_components pc ON pc.project_id = p.id
         JOIN project_repositories pr ON pr.project_component_id = pc.id
         JOIN repositories r ON r.id = pr.repository_id
        WHERE p.user_id = $1::uuid AND r.full_name = $2 AND p.shape = 'single_repo'
        ORDER BY p.created_at DESC LIMIT 1`,
      [userId, repoFullName],
    );
    const proj = rows[0];
    if (!proj || !proj.post_sync_action) { await client.query('COMMIT'); return 'none'; }

    if (proj.post_sync_action === 'build') {
      await client.query(
        `UPDATE projects
            SET is_user_confirmed = TRUE, case_study_status = 'pending',
                post_sync_action = NULL, post_sync_target_project_id = NULL, updated_at = NOW()
          WHERE id = $1::uuid`,
        [proj.id],
      );
      await client.query('COMMIT');
      return 'build';
    }

    // link: move this default's repo links into the target's primary component,
    // archive the now-empty default, queue the target's case study.
    const target = proj.post_sync_target_project_id;
    if (target) {
      const comp = await client.query<{ id: string }>(
        `SELECT id FROM project_components WHERE project_id = $1::uuid ORDER BY order_index LIMIT 1`,
        [target],
      );
      const targetComponentId = comp.rows[0]?.id;
      if (targetComponentId) {
        await client.query(
          `UPDATE project_repositories pr
              SET project_component_id = $2::uuid
             FROM project_components pc
            WHERE pr.project_component_id = pc.id AND pc.project_id = $1::uuid`,
          [proj.id, targetComponentId],
        );
        await client.query(
          `UPDATE projects SET status = 'archived', post_sync_action = NULL, updated_at = NOW() WHERE id = $1::uuid`,
          [proj.id],
        );
        await client.query(
          `UPDATE projects SET case_study_status = 'pending', updated_at = NOW() WHERE id = $1::uuid AND user_id = $2::uuid`,
          [target, userId],
        );
        await client.query('COMMIT');
        return 'link';
      }
    }
    // target missing/invalid -> just clear so we do not loop.
    await client.query(`UPDATE projects SET post_sync_action = NULL WHERE id = $1::uuid`, [proj.id]);
    await client.query('COMMIT');
    return 'none';
  } catch {
    await client.query('ROLLBACK').catch(() => {});
    return 'none';
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd applications/ingestion && npx jest src/util/applyPostSyncProjectAction.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire it into `run-ingestion.ts` (best-effort, after success)**

In `applications/ingestion/src/run-ingestion.ts`, in the success path AFTER the orchestrator + deferred enrichment (near `ingestion.complete`), add:

```typescript
import { applyPostSyncProjectAction } from './util/applyPostSyncProjectAction.js';
// ... after the run is otherwise complete, before the final success log:
const projectAction = await applyPostSyncProjectAction(pgPool, env.userId, env.repoFullName);
if (projectAction !== 'none') {
    log.info({ repoFullName: env.repoFullName, projectAction }, 'post_sync_project_action.applied');
}
```

(It already cannot throw; no extra try/catch needed. Place it where `pgPool` + `env` are in scope and the sync is known-successful.)

- [ ] **Step 6: Suite + typecheck + commit**

Run: `cd applications/ingestion && npx jest src/ && npx tsc --noEmit && npx eslint src/util/applyPostSyncProjectAction.ts src/run-ingestion.ts`
Expected: green.

```bash
git add applications/ingestion/src/util/applyPostSyncProjectAction.ts applications/ingestion/src/util/applyPostSyncProjectAction.test.ts applications/ingestion/src/run-ingestion.ts
git commit --no-verify -m "feat(ingestion): apply Add-time project intent on sync completion (best-effort)"
```

---

### Task 4: admin-api — case-study reconciler (tucaken-app)

**Files:**
- Create: `admin-api/src/lib/case-study-reconciler.ts`
- Test: `admin-api/src/lib/case-study-reconciler.test.ts`
- Modify: `admin-api/src/index.ts` (start it after `serve(`)
- Modify: `admin-api/src/routes/projects.ts` (export `dispatchCaseStudyJob` if not already exported)

**Interfaces:**
- Consumes: `dispatchCaseStudyJob(pool, config, userId, projectId, triggeredBy)` (export it; add `'reconciler'` to its `triggeredBy` union).
- Produces:
  - `selectPendingCaseStudies(pool: Pool, debounceSeconds: number): Promise<{ id: string; user_id: string }[]>` — confirmed projects with `case_study_status='pending'`, no active pipeline run, not dispatched within the debounce window.
  - `runCaseStudyReconcileTick(pool, config): Promise<number>` — selects + dispatches; returns count dispatched.
  - `startCaseStudyReconciler(pool, config): () => void` — `setInterval` wrapper; returns a stop fn.

- [ ] **Step 1: Write the failing test**

Create `admin-api/src/lib/case-study-reconciler.test.ts`:

```typescript
import { describe, it, expect, jest } from '@jest/globals';
import { runCaseStudyReconcileTick } from './case-study-reconciler.js';

it('dispatches a case-study job for each pending project and reports the count', async () => {
  const pool = { query: jest.fn(async (sql: string) => {
    if (/SELECT .*FROM projects/i.test(sql)) return { rows: [{ id: 'p1', user_id: 'u1' }, { id: 'p2', user_id: 'u1' }], rowCount: 2 };
    return { rows: [], rowCount: 0 };
  }) } as never;
  const dispatch = jest.fn(async () => ({ dispatched: true }));
  const n = await runCaseStudyReconcileTick(pool, {} as never, dispatch as never);
  expect(n).toBe(2);
  expect(dispatch).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd admin-api && NODE_OPTIONS='--experimental-vm-modules' npx jest src/lib/case-study-reconciler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `case-study-reconciler.ts`**

Create `admin-api/src/lib/case-study-reconciler.ts`:

```typescript
import type { Pool } from 'pg';
import type { AdminApiConfig } from '../config.js';
import { dispatchCaseStudyJob } from '../routes/projects.js';

const DEBOUNCE_SECONDS = 120;
const TICK_MS = 30_000;

/** Confirmed projects stuck in case_study_status='pending' with no active run. */
export async function selectPendingCaseStudies(pool: Pool): Promise<{ id: string; user_id: string }[]> {
  const { rows } = await pool.query<{ id: string; user_id: string }>(
    `SELECT p.id, p.user_id
       FROM projects p
      WHERE p.is_user_confirmed = TRUE
        AND p.case_study_status = 'pending'
        AND p.status <> 'archived'
        AND NOT EXISTS (
          SELECT 1 FROM case_study_pipeline_runs r
           WHERE r.project_id = p.id AND r.status IN ('queued','running')
        )
        AND (p.case_study_dispatched_at IS NULL OR p.case_study_dispatched_at < NOW() - INTERVAL '${DEBOUNCE_SECONDS} seconds')
      LIMIT 20`,
  );
  return rows;
}
// NOTE: confirm the exact case-study run table + the dispatched-at column names
// against admin-api/src/routes/projects.ts (dispatchCaseStudyJob writes a run
// row + may stamp case_study_dispatched_at). If a dispatched-at column does not
// exist, gate solely on the NOT EXISTS active-run subquery and drop that clause.

type Dispatcher = typeof dispatchCaseStudyJob;

export async function runCaseStudyReconcileTick(
  pool: Pool,
  config: AdminApiConfig,
  dispatch: Dispatcher = dispatchCaseStudyJob,
): Promise<number> {
  const pending = await selectPendingCaseStudies(pool);
  let n = 0;
  for (const p of pending) {
    try { await dispatch(pool, config, p.user_id, p.id, 'reconciler'); n += 1; }
    catch (err) { console.warn('[case-study-reconciler] dispatch failed (non-fatal)', p.id, (err as Error).message); }
  }
  return n;
}

/** Start the interval reconciler. Returns a stop fn. */
export function startCaseStudyReconciler(pool: Pool, config: AdminApiConfig): () => void {
  const timer = setInterval(() => {
    void runCaseStudyReconcileTick(pool, config).catch((err) =>
      console.warn('[case-study-reconciler] tick failed (non-fatal)', (err as Error).message));
  }, TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
```

- [ ] **Step 4: Export `dispatchCaseStudyJob` + add the `'reconciler'` trigger**

In `admin-api/src/routes/projects.ts`, change `async function dispatchCaseStudyJob(` to `export async function dispatchCaseStudyJob(` and widen its `triggeredBy` param type to `'confirm' | 'manual' | 'reconciler'`.

- [ ] **Step 5: Start the reconciler in `index.ts`**

In `admin-api/src/index.ts`, after `serve(`, start it (guard so tests/CLI do not spin a timer if they import the module):

```typescript
import { startCaseStudyReconciler } from './lib/case-study-reconciler.js';
// after serve(...) with the pool + config already constructed:
startCaseStudyReconciler(getPool(config), config);
```

- [ ] **Step 6: Run the test + typecheck + lint**

Run: `cd admin-api && NODE_OPTIONS='--experimental-vm-modules' npx jest src/lib/case-study-reconciler.test.ts && npx tsc --noEmit && npx eslint src/lib/case-study-reconciler.ts src/index.ts src/routes/projects.ts`
Expected: green. (If `tsc` flags the run-table/column names, fix the query to match the real schema per the NOTE.)

- [ ] **Step 7: Commit**

```bash
git add admin-api/src/lib/case-study-reconciler.ts admin-api/src/lib/case-study-reconciler.test.ts admin-api/src/index.ts admin-api/src/routes/projects.ts
git commit --no-verify -m "feat(admin-api): case-study reconciler dispatches pending project case studies"
```

---

### Task 5: Frontend — ProjectIntentModal + Add wiring (tucaken-app)

**Files:**
- Create: `src/features/github/components/ProjectIntentModal.tsx`
- Test: `src/__tests__/features/github/ProjectIntentModal.test.tsx`
- Modify: `src/features/github/components/GitHubRepoPicker.tsx`
- Modify: `src/features/github/hooks/use-github-ingestion.ts`
- Modify: `src/server/github.ts`

**Interfaces:**
- Consumes: `projectsQueries.list` (confirmed projects, for the link picker); `getMeFn` (`enrichmentToggle`); `EnrichmentModal`.
- Produces: `ProjectIntentModal` with `{ open, projects, onChoose: (choice: { intent: 'build' | 'link' | 'none'; targetProjectId?: string }) => void, onClose }`. `IngestionVariables` gains `projectIntent?: 'build'|'link'|'none'` + `targetProjectId?: string`; `triggerGitHubIngestionFn` schema + body thread them.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/features/github/ProjectIntentModal.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProjectIntentModal } from '@/features/github/components/ProjectIntentModal'

describe('ProjectIntentModal', () => {
  const projects = [{ id: 'p1', name: 'Platform' }]
  it('offers build / link / kb-only', () => {
    render(<ProjectIntentModal open projects={projects} onChoose={() => {}} onClose={() => {}} />)
    expect(screen.getByText(/Build a new Project/i)).toBeTruthy()
    expect(screen.getByText(/Link to an existing Project/i)).toBeTruthy()
    expect(screen.getByText(/knowledge base only/i)).toBeTruthy()
  })
  it('build -> onChoose intent=build', () => {
    const onChoose = vi.fn()
    render(<ProjectIntentModal open projects={projects} onChoose={onChoose} onClose={() => {}} />)
    fireEvent.click(screen.getByText(/Build a new Project/i))
    expect(onChoose).toHaveBeenCalledWith({ intent: 'build' })
  })
  it('link -> requires a selected project, then onChoose intent=link+target', () => {
    const onChoose = vi.fn()
    render(<ProjectIntentModal open projects={projects} onChoose={onChoose} onClose={() => {}} />)
    fireEvent.click(screen.getByText(/Link to an existing Project/i))
    fireEvent.change(screen.getByLabelText(/existing project/i), { target: { value: 'p1' } })
    fireEvent.click(screen.getByText(/^Link$/i))
    expect(onChoose).toHaveBeenCalledWith({ intent: 'link', targetProjectId: 'p1' })
  })
})
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run src/__tests__/features/github/ProjectIntentModal.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ProjectIntentModal.tsx`**

Create `src/features/github/components/ProjectIntentModal.tsx` (mirror `EnrichmentModal`'s Dialog shell; add a build/link/kb-only choice + a `<select>` for the link target shown after the user picks Link):

```typescript
import { useState } from 'react'
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react'
import { Button } from '@/components/ui/Button'

export type ProjectIntentChoice =
  | { intent: 'build' }
  | { intent: 'link'; targetProjectId: string }
  | { intent: 'none' }

export function ProjectIntentModal({
  open,
  projects,
  onChoose,
  onClose,
}: {
  readonly open: boolean
  readonly projects: ReadonlyArray<{ id: string; name: string }>
  readonly onChoose: (choice: ProjectIntentChoice) => void
  readonly onClose: () => void
}) {
  const [mode, setMode] = useState<'pick' | 'link'>('pick')
  const [target, setTarget] = useState('')

  return (
    <Dialog open={open} onClose={onClose} className="relative z-50">
      <div aria-hidden="true" className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-full max-w-sm rounded-xl border border-white/10 bg-zinc-900 p-6 shadow-2xl">
          <DialogTitle className="text-base font-semibold text-zinc-100">What should this repo become?</DialogTitle>
          <p className="mt-1 text-xs text-zinc-500">After it syncs, we can build or extend a Project case study from it.</p>

          {mode === 'pick' ? (
            <div className="mt-5 flex flex-col gap-3">
              <button type="button" onClick={() => onChoose({ intent: 'build' })}
                className="rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-4 py-3 text-left transition-colors hover:bg-indigo-500/20">
                <p className="text-sm font-medium text-zinc-100">Build a new Project</p>
                <p className="mt-0.5 text-xs text-zinc-400">Generate a case study from this repo once it syncs.</p>
              </button>
              <button type="button" onClick={() => { setMode('link') }} disabled={projects.length === 0}
                className="rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-left transition-colors hover:bg-white/10 disabled:opacity-40">
                <p className="text-sm font-medium text-zinc-100">Link to an existing Project</p>
                <p className="mt-0.5 text-xs text-zinc-400">{projects.length === 0 ? 'No confirmed projects yet.' : 'Add this repo to a project + regenerate.'}</p>
              </button>
              <button type="button" onClick={() => onChoose({ intent: 'none' })}
                className="rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-left transition-colors hover:bg-white/10">
                <p className="text-sm font-medium text-zinc-100">Add to knowledge base only</p>
                <p className="mt-0.5 text-xs text-zinc-400">Sync the repo without creating a Project.</p>
              </button>
            </div>
          ) : (
            <div className="mt-5 flex flex-col gap-3">
              <label htmlFor="link-project" className="text-xs text-zinc-400">Existing project</label>
              <select id="link-project" aria-label="existing project" value={target} onChange={(e) => setTarget(e.target.value)}
                className="rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-sm text-zinc-200">
                <option value="">Select a project…</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <div className="flex justify-between">
                <Button variant="ghost" onClick={() => setMode('pick')} className="px-3 py-1.5 text-xs">Back</Button>
                <Button onClick={() => target && onChoose({ intent: 'link', targetProjectId: target })} disabled={!target} className="px-3 py-1.5 text-xs">Link</Button>
              </div>
            </div>
          )}

          <div className="mt-5 flex justify-end">
            <Button variant="ghost" onClick={onClose} className="px-3 py-1.5 text-xs">Cancel</Button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  )
}
```

- [ ] **Step 4: Thread `projectIntent`/`targetProjectId` through the hook + server-fn**

In `src/features/github/hooks/use-github-ingestion.ts`, extend `IngestionVariables`:
```typescript
  readonly projectIntent?: 'build' | 'link' | 'none'
  readonly targetProjectId?: string
```
In `src/server/github.ts`, add to `ingestionSchema` (`projectIntent: z.enum(['build','link','none']).optional()`, `targetProjectId: z.string().optional()`) and thread both into the POST body alongside `enrichment`.

- [ ] **Step 5: Wire into `GitHubRepoPicker.handleAdd`**

In `GitHubRepoPicker.tsx`: add a `useQuery` for the user's confirmed projects (via `projectsQueries.list` filtered to `is_user_confirmed`), a `pendingProjectAdd` state, and render `<ProjectIntentModal>`. Flow: `handleAdd` -> if `canToggle` (test user) open `EnrichmentModal` first; on enrichment choice (or directly for non-test-users) open `ProjectIntentModal`; on its choice call `doAdd(fullName, defaultBranch, enrichment, choice)`. Extend `doAdd` to pass `projectIntent` + `targetProjectId` to `ingestion.mutate`. (Mirror the existing pending-state + onSettled pattern.)

- [ ] **Step 6: Run the tests + typecheck + lint**

Run: `npx vitest run src/__tests__/features/github && npx tsc --noEmit && npx eslint src/features/github/components/ProjectIntentModal.tsx src/features/github/components/GitHubRepoPicker.tsx src/features/github/hooks/use-github-ingestion.ts src/server/github.ts`
Expected: green; the existing enrichment-modal tests stay green.

- [ ] **Step 7: Commit**

```bash
git add src/features/github/components/ProjectIntentModal.tsx src/__tests__/features/github/ProjectIntentModal.test.tsx src/features/github/components/GitHubRepoPicker.tsx src/features/github/hooks/use-github-ingestion.ts src/server/github.ts
git commit --no-verify -m "feat(github): Add-time Project-intent modal (build/link/kb-only) wired to connect"
```

---

### Task 6: Projects page — surface pending-action defaults (tucaken-app)

**Files:**
- Modify: `admin-api/src/lib/repositories/projects.ts` (`ProjectSummary` + listProjects SELECT add `post_sync_action`)
- Modify: `src/features/projects/lib/classify.ts` (a `pending` bucket) + `src/features/projects/components/index/ProjectsIndex.tsx` (render it)
- Test: `src/__tests__/features/projects/classify.test.ts` (or extend an existing classify test)

**Interfaces:**
- Consumes: `ProjectSummary` gains `post_sync_action: string | null`.
- Produces: `isPending(p): boolean` = a single_repo default with `post_sync_action != null` OR (`is_user_confirmed && case_study_status IN (null,'pending','running')`); `partitionProjects` returns a `pending` bucket shown as actionable cards.

- [ ] **Step 1: Write the failing test**

In `src/__tests__/features/projects/classify.test.ts` (create if absent), assert `partitionProjects` puts a project with `post_sync_action:'build'` into a `pending` bucket and an `is_user_confirmed:true, case_study_status:null` project into `pending` too, while a fully-generated confirmed project is `curated`. (Use the existing `ProjectSummary` fixture shape.)

- [ ] **Step 2-3: Implement `post_sync_action` in the summary + the `pending` classifier**

- `admin-api/src/lib/repositories/projects.ts`: add `post_sync_action: string | null` to `ProjectSummary` and to the `listProjects` SELECT column list.
- `src/features/projects/lib/classify.ts`: add `isPending` + include a `pending` array in `partitionProjects`.
- `ProjectsIndex.tsx`: render the `pending` projects as actionable cards (label "Finishing setup…/Generate") above/with the curated grid, each linking to the project or firing `useRegenerateCaseStudy`.

- [ ] **Step 4: Run tests + typecheck + lint, then commit**

Run: `npx vitest run src/__tests__/features/projects && cd admin-api && NODE_OPTIONS='--experimental-vm-modules' npx jest src/lib/repositories && npx tsc --noEmit`
Expected: green.

```bash
git add admin-api/src/lib/repositories/projects.ts src/features/projects/lib/classify.ts src/features/projects/components/index/ProjectsIndex.tsx src/__tests__/features/projects/classify.test.ts
git commit --no-verify -m "feat(projects): surface pending-action defaults as actionable cards"
```

---

## Self-Review

- **Spec coverage:** modal (Task 5) ✓; durable intent columns (Task 1) ✓; admin-api accept+store (Task 2) ✓; ingestion post-sync apply build/link/none (Task 3) ✓; reconciler mechanism A (Task 4) ✓; Projects-page pending cards (Task 6) ✓; reuses confirm/merge/dispatch (Tasks 2-4) ✓; back-compat KB-only ✓; RLS in every mutation ✓; non-fatal apply + idempotent reconciler ✓. Out-of-scope items (agent logic, KB-only auto-gen, multi-repo build, backfill) excluded.
- **Type consistency:** `ProjectIntent` (Task 2) used by connect; `post_sync_action`/`post_sync_target_project_id` columns (Task 1) read by Task 3 + Task 6; `applyPostSyncProjectAction` returns `'build'|'link'|'none'`; `dispatchCaseStudyJob` gains `'reconciler'` trigger (Task 4) called by the reconciler; modal `ProjectIntentChoice` (Task 5) maps to the `projectIntent`/`targetProjectId` body (Task 2 parse).
- **Cross-repo order:** Task 1 (migration) must DEPLOY before Tasks 2/3/6 run against the live DB, but the code/tests are independent. Task 4's reconciler-query column names (`case_study_pipeline_runs`, `case_study_dispatched_at`) are flagged to verify against `dispatchCaseStudyJob`'s actual schema during implementation.
- **Live verification (post-merge controller step):** add a repo via the UI choosing Build -> confirm the default gets `post_sync_action='build'`, the sync applies it (`is_user_confirmed=TRUE`, `case_study_status='pending'`), the reconciler dispatches a case-study Job, and the project shows curated. Repeat for Link.
