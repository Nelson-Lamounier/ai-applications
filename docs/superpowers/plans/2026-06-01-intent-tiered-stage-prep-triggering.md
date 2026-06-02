# Intent-Tiered Stage-Prep Triggering — Implementation Plan (Spec 2b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fire the Coach on user intent (advance / schedule / select), idempotently, and surface honest per-stage states (teaser → generating → ready), with per-stage lifecycle + user-state persistence and a starting-stage picker at creation.

**Architecture:** `POST /:slug/coach` becomes self-resolving + deduped + gated (one `dispatchCoach` helper). Advance (`/status`) and schedule call it server-side. Migration 050 adds a real `interview_stage` pointer + `interview_stages` lifecycle/user-state columns; `prep_status` is reconciled on read from the coach `pipeline_runs`. UI renders a `(stage_status, prep_status)` state machine.

**Tech Stack:** Hono + `pg` (admin-api), PostgreSQL (migration), React/TanStack (tucaken-app), Jest (admin-api: `NODE_OPTIONS='--experimental-vm-modules' jest`), Vitest (tucaken-app).

**Spec:** `docs/superpowers/specs/2026-06-01-intent-tiered-stage-prep-triggering-design.md`

**Depends on:** Spec 2a + #111/#112/#113 (merged, deployed, E2E-confirmed). Coach produces grounded prep; this spec triggers it + surfaces state.

---

## Three PRs (A→B→C)

- **PR-A** (`tucaken-app/admin-api`): `dispatchCoach` helper — self-resolve + dedup + gate; advance auto-dispatch.
- **PR-B** (`ai-applications` migration + `tucaken-app/admin-api`): migration 050; creation seeding; `interview_stages` PATCH/GET + `prep_status` reconcile; `not_applicable`.
- **PR-C** (`tucaken-app` UI): coach server-fn; StageProgressBar lifecycle; workspace state machine; starting-stage forward; triggers + confirm; localStorage→RDS.

Stage constants (canonical): `INTERVIEW_PREP_STAGES = ['phone-screen','technical','system-design','behavioural','bar-raiser','final']` (i.e. `STAGE_ORDER` minus `applied`).

**Runners:** admin-api → `NODE_OPTIONS='--experimental-vm-modules' npx jest <path>` (per package.json); migration verified by `psql` apply (no migration test harness — same as 049); tucaken-app UI → `npm test` (vitest) / `npm run typecheck`.

---

# PR-A — Self-resolving, deduped, gated coach dispatch (admin-api)

## PR-A File Structure

| File | Responsibility | Action |
|---|---|---|
| `admin-api/src/lib/coach-dispatch.ts` | `INTERVIEW_PREP_STAGES`, `resolveStrategistRunId`, `coachInFlightOrFresh`, `dispatchCoach` | Create |
| `admin-api/src/lib/coach-dispatch.test.ts` | unit tests (gate, dedup, resolve) | Create |
| `admin-api/src/routes/applications.ts` | `/:slug/coach` → use `dispatchCoach`; `/:slug/status` → persist stage + auto-dispatch | Modify |
| `admin-api/__tests__/routes/applications-coach.test.ts` | extend: self-resolve, dedup, gate, advance dispatch | Modify |

## Task A1: `dispatchCoach` helper (gate + resolve + dedup)

**Files:**
- Create: `admin-api/src/lib/coach-dispatch.ts`
- Test: `admin-api/src/lib/coach-dispatch.test.ts`

- [ ] **Step 1: Read context.** Read `admin-api/src/routes/applications.ts` `POST /:slug/coach` (the existing job-build + `insertPipelineRun` + `buildPipelineJob` + `getBatchApi().createNamespacedJob`) and the `GET /:slug` strategist query (`SELECT id ... FROM pipeline_runs WHERE pipeline_type='strategist' AND reference_id=$1 AND status='complete' ORDER BY created_at DESC LIMIT 1`). Note the exact column the app row exposes (`id`, `company`, `role`, `job_description`) and how `reference_id` is set (the application UUID).

- [ ] **Step 2: Write the failing test** `admin-api/src/lib/coach-dispatch.test.ts`:

```typescript
import { jest, describe, it, expect } from '@jest/globals';
import { INTERVIEW_PREP_STAGES, isPrepStage, coachInFlightOrFresh, resolveStrategistRunId } from '../../src/lib/coach-dispatch.js';

function pool(rows: unknown[]) {
  const query = jest.fn(async () => ({ rows }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { query } as any;
}

describe('isPrepStage', () => {
  it('accepts interview-prep stages, rejects applied/offer', () => {
    expect(isPrepStage('phone-screen')).toBe(true);
    expect(isPrepStage('final')).toBe(true);
    expect(isPrepStage('applied')).toBe(false);
    expect(isPrepStage('offer')).toBe(false);
  });
  it('INTERVIEW_PREP_STAGES excludes applied', () => {
    expect(INTERVIEW_PREP_STAGES).not.toContain('applied');
  });
});

describe('resolveStrategistRunId', () => {
  it('returns the latest complete strategist run id', async () => {
    const id = await resolveStrategistRunId(pool([{ id: 'strat-1' }]), 'app-uuid');
    expect(id).toBe('strat-1');
  });
  it('returns null when none', async () => {
    expect(await resolveStrategistRunId(pool([]), 'app-uuid')).toBeNull();
  });
});

describe('coachInFlightOrFresh', () => {
  it('true when a queued/coaching/complete coach run exists for the stage', async () => {
    expect(await coachInFlightOrFresh(pool([{ status: 'coaching' }]), 'app-uuid', 'phone-screen')).toBe(true);
  });
  it('false when none', async () => {
    expect(await coachInFlightOrFresh(pool([]), 'app-uuid', 'phone-screen')).toBe(false);
  });
});
```

- [ ] **Step 3: Run → FAIL.** `cd admin-api && NODE_OPTIONS='--experimental-vm-modules' npx jest src/lib/coach-dispatch.test.ts`

- [ ] **Step 4: Implement** `admin-api/src/lib/coach-dispatch.ts`:

```typescript
/** @format */
import { randomUUID } from 'node:crypto';
import type { Queryable } from './repositories/applications.js';

export const INTERVIEW_PREP_STAGES = [
  'phone-screen', 'technical', 'system-design', 'behavioural', 'bar-raiser', 'final',
] as const;

export function isPrepStage(stage: string): boolean {
  return (INTERVIEW_PREP_STAGES as readonly string[]).includes(stage);
}

/** Latest COMPLETE strategist run id for an application (reference_id = app UUID). */
export async function resolveStrategistRunId(db: Queryable, applicationId: string): Promise<string | null> {
  const r = await db.query<{ id: string }>(
    `SELECT id FROM pipeline_runs
      WHERE pipeline_type = 'strategist' AND reference_id = $1 AND status = 'complete'
      ORDER BY created_at DESC LIMIT 1`,
    [applicationId],
  );
  return r.rows[0]?.id ?? null;
}

/** True if a coach for (app, stage) is queued/coaching or already complete (dedup). */
export async function coachInFlightOrFresh(db: Queryable, applicationId: string, stage: string): Promise<boolean> {
  const r = await db.query<{ status: string }>(
    `SELECT status FROM pipeline_runs
      WHERE pipeline_type = 'coach' AND reference_id = $1
        AND metadata->>'interviewStage' = $2
        AND status IN ('queued','coaching','complete')
      LIMIT 1`,
    [applicationId, stage],
  );
  return r.rows.length > 0;
}

export interface DispatchResult { status: 'dispatched' | 'skipped' | 'gated' | 'no-analysis'; coachPipelineRunId?: string; reason?: string }

/**
 * Self-resolving, deduped, gated coach dispatch. Caller supplies the application row
 * + stage + options. `createJob` is injected (the route wires K8s job creation) so this
 * stays unit-testable. Returns a structured result; never throws on gate/dedup.
 */
export async function dispatchCoach(
  db: Queryable,
  args: {
    application: { id: string; company: string; role: string; job_description: string };
    slug: string;
    userId: string;
    interviewStage: string;
    compensationTarget?: string;
    region?: string;
    force?: boolean;
  },
  createJob: (env: { coachPipelineRunId: string; strategistPipelineRunId: string; applicationId: string;
    slug: string; userId: string; targetCompany: string; targetRole: string; jobDescription: string;
    interviewStage: string; compensationTarget: string; region: string }) => Promise<void>,
  insertCoachRun: (db: Queryable, row: { id: string; userId: string; referenceId: string; metadata: Record<string, unknown> }) => Promise<void>,
): Promise<DispatchResult> {
  if (!isPrepStage(args.interviewStage)) return { status: 'gated', reason: `not an interview-prep stage: ${args.interviewStage}` };
  if (!args.force && await coachInFlightOrFresh(db, args.application.id, args.interviewStage)) {
    return { status: 'skipped', reason: 'coach already in-flight or complete for this stage' };
  }
  const strategistPipelineRunId = await resolveStrategistRunId(db, args.application.id);
  if (!strategistPipelineRunId) return { status: 'no-analysis', reason: 'no complete strategist run yet' };

  const coachPipelineRunId = randomUUID();
  await insertCoachRun(db, {
    id: coachPipelineRunId, userId: args.userId, referenceId: args.application.id,
    metadata: { applicationSlug: args.slug, interviewStage: args.interviewStage, strategistPipelineRunId },
  });
  await createJob({
    coachPipelineRunId, strategistPipelineRunId, applicationId: args.application.id, slug: args.slug,
    userId: args.userId, targetCompany: args.application.company, targetRole: args.application.role,
    jobDescription: args.application.job_description, interviewStage: args.interviewStage,
    compensationTarget: args.compensationTarget ?? '', region: args.region ?? 'eu-remote',
  });
  return { status: 'dispatched', coachPipelineRunId };
}
```

> `Queryable` is the existing type in `admin-api/src/lib/repositories/applications.ts` (a `{ query }` interface). If its name/path differs, import the actual one.

- [ ] **Step 5: Run → PASS.** Then `cd admin-api && npx tsc --noEmit`.

- [ ] **Step 6: Commit**
```bash
git add admin-api/src/lib/coach-dispatch.ts admin-api/src/lib/coach-dispatch.test.ts
git commit -m "feat(admin-api): coach-dispatch helper — gate + dedup + self-resolve strategist run"
```

## Task A2: Wire `/:slug/coach` to `dispatchCoach`

**Files:** Modify `admin-api/src/routes/applications.ts` (the `POST /:slug/coach` handler), extend `admin-api/__tests__/routes/applications-coach.test.ts`.

- [ ] **Step 1:** Change the handler body type to `{ interviewStage?: string; compensationTarget?: string|number; region?: string; force?: boolean }` (drop the now-resolved required fields). Load the application row by slug (reuse the existing slug→app lookup the GET handler uses) to get `{ id, company, role, job_description }`. Build `createJob` from the existing `buildPipelineJob` + `getBatchApi().createNamespacedJob` block (move the env array into the `createJob` closure passed to `dispatchCoach`; `COMPENSATION_TARGET`/`REGION` already added in #112-era code). Build `insertCoachRun` from the existing `insertPipelineRun(db, {... pipelineType:'coach' ...})`. Call:

```typescript
const result = await dispatchCoach(db, {
  application: appRow, slug, userId,
  interviewStage: body.interviewStage?.trim() ?? '',
  compensationTarget: body.compensationTarget != null ? String(body.compensationTarget).trim() : undefined,
  region: body.region?.trim() || undefined,
  force: body.force === true,
}, createJob, (d, row) => insertPipelineRun(d, { id: row.id, userId: row.userId, pipelineType: 'coach', referenceId: row.referenceId, metadata: row.metadata }));
```
Map results to responses: `dispatched` → 202 `{ status:'queued', coachPipelineRunId }`; `skipped` → 200 `{ status:'skipped' }`; `gated` → 400; `no-analysis` → 409 `{ error: result.reason }`.

- [ ] **Step 2: Extend the coach route test.** Update `applications-coach.test.ts`: the mocked pg must return the app row for the slug lookup, the strategist run for resolve, and `[]` for the dedup check (then assert 202 + a Job created); add a test where dedup returns a row → 200 skipped + NO job; a test with `interviewStage:'applied'` → 400 gated; a test with no strategist run → 409. Reuse the existing k8s/pg/pipeline-runs mocks.

- [ ] **Step 3:** Run the suite + tsc.
```
cd admin-api && NODE_OPTIONS='--experimental-vm-modules' npx jest __tests__/routes/applications-coach.test.ts && npx tsc --noEmit
```

- [ ] **Step 4: Commit**
```bash
git add admin-api/src/routes/applications.ts admin-api/__tests__/routes/applications-coach.test.ts
git commit -m "feat(admin-api): /coach self-resolves + dedups + gates via dispatchCoach"
```

## Task A3: Advance auto-dispatch in `/:slug/status`

**Files:** Modify `admin-api/src/routes/applications.ts` (`POST /:slug/status`) + `admin-api/src/lib/repositories/applications.ts`.

- [ ] **Step 1:** Add a repo fn `updateInterviewStage(db, appId, stage)` in `applications.ts` repo:
```typescript
export async function updateInterviewStage(pool: Queryable, id: string, stage: string): Promise<void> {
  await pool.query(`UPDATE job_applications SET interview_stage = $1, updated_at = NOW() WHERE id = $2`, [stage, id]);
}
```
(Column added in PR-B migration 050; PR-A can land first but this UPDATE no-ops gracefully only if the column exists — so **PR-A merges after PR-B's migration is applied**, OR guard with a try/catch. Simplest: sequence PR-B's migration before deploying PR-A. Note this in the PR description.)

- [ ] **Step 2:** In `POST /:slug/status`, after `pgUpdateStatus(db, slug, body.status!)`, if `body.interviewStage` is set: load the app row, `await updateInterviewStage(db, app.id, body.interviewStage)`, then **fail-open dispatch**:
```typescript
    if (body.interviewStage && isPrepStage(body.interviewStage)) {
      try {
        await dispatchCoach(db, { application: app, slug, userId, interviewStage: body.interviewStage }, createJob, insertCoachRunAdapter);
      } catch (err) {
        console.error('[applications/status] coach dispatch failed (non-fatal)', err);
      }
    }
```
(The status update has already committed; dispatch failure must not 500 the advance.)

- [ ] **Step 3: Test.** Extend the status-route test (or coach test): advancing with `interviewStage:'phone-screen'` updates stage + creates a coach Job (dedup empty); advancing with `interviewStage:'applied'` updates stage but creates NO job; dispatch throwing still returns 200.

- [ ] **Step 4:** Run + tsc + commit.
```bash
git add admin-api/src/routes/applications.ts admin-api/src/lib/repositories/applications.ts <test>
git commit -m "feat(admin-api): advance persists interview_stage + auto-dispatches coach (fail-open)"
```

## Task A4: PR-A gate + PR
- [ ] `cd admin-api && NODE_OPTIONS='--experimental-vm-modules' npx jest && npx tsc --noEmit` (green).
- [ ] Open PR-A → `develop`/`main` (tucaken-app default): "feat: self-resolving deduped coach dispatch + advance trigger". Note dependency: **apply migration 050 (PR-B) before deploying** (the `interview_stage` UPDATE needs the column).

---

# PR-B — Persistence: migration 050 + stage endpoints + creation seeding

## PR-B File Structure

| File | Responsibility | Action |
|---|---|---|
| `ai-applications/applications/platform-rds-bootstrap/migrations/050_interview_stage_lifecycle.sql` | add `job_applications.interview_stage` + `interview_stages` cols + UNIQUE | Create |
| `tucaken-app/admin-api/src/lib/repositories/interview-stages.ts` | upsert/get per-stage rows; reconcile prep_status | Create |
| `tucaken-app/admin-api/src/lib/repositories/interview-stages.test.ts` | unit tests | Create |
| `tucaken-app/admin-api/src/routes/applications.ts` | `PATCH /:slug/stages/:stage`; per-stage map in `GET /:slug` | Modify |
| `tucaken-app/admin-api/src/routes/pipelines.ts` | accept + persist starting stage; seed earlier=completed | Modify |

## Task B1: Migration 050

**Files:** Create `ai-applications/applications/platform-rds-bootstrap/migrations/050_interview_stage_lifecycle.sql`

- [ ] **Step 1: Write it** (idempotent, mirrors 049 style):
```sql
-- 050_interview_stage_lifecycle.sql
-- Adds the authoritative current-stage pointer to job_applications and per-stage
-- lifecycle + user-state + coach-dispatch tracking to interview_stages.
-- Idempotent: IF NOT EXISTS guards.
BEGIN;

ALTER TABLE job_applications
  ADD COLUMN IF NOT EXISTS interview_stage TEXT NOT NULL DEFAULT 'applied';

ALTER TABLE interview_stages
  ADD COLUMN IF NOT EXISTS user_state   JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS coach_run_id UUID,
  ADD COLUMN IF NOT EXISTS prep_status  TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS stage_status TEXT NOT NULL DEFAULT 'upcoming';

-- One row per (application, stage)
CREATE UNIQUE INDEX IF NOT EXISTS interview_stages_app_stage_uniq
  ON interview_stages (job_application_id, stage_type);

COMMIT;
```

- [ ] **Step 2: Apply + verify** (no migration test harness — same as 049):
`psql "$DATABASE_URL" -f applications/platform-rds-bootstrap/migrations/050_interview_stage_lifecycle.sql`
then `psql "$DATABASE_URL" -c "\d interview_stages"` — confirm the 4 new columns + unique index, and `\d job_applications` shows `interview_stage`.

- [ ] **Step 3: Commit** (in ai-applications):
```bash
git add applications/platform-rds-bootstrap/migrations/050_interview_stage_lifecycle.sql
git commit -m "feat(rds): migration 050 — interview_stage pointer + interview_stages lifecycle/user_state"
```

## Task B2: `interview-stages` repository (upsert/get + reconcile)

**Files:** Create `tucaken-app/admin-api/src/lib/repositories/interview-stages.ts` + test.

- [ ] **Step 1: Failing test** `interview-stages.test.ts`:
```typescript
import { jest, describe, it, expect } from '@jest/globals';
import { reconcilePrepStatus, upsertStageUserState } from '../../src/lib/repositories/interview-stages.js';

describe('reconcilePrepStatus', () => {
  it('maps coach run status → prep_status', () => {
    expect(reconcilePrepStatus(null, false)).toBe('none');
    expect(reconcilePrepStatus('queued', false)).toBe('queued');
    expect(reconcilePrepStatus('coaching', false)).toBe('queued');
    expect(reconcilePrepStatus('complete', true)).toBe('ready');
    expect(reconcilePrepStatus('failed', false)).toBe('failed');
    expect(reconcilePrepStatus('complete', false)).toBe('queued'); // run done, content not yet visible
  });
});

describe('upsertStageUserState', () => {
  it('issues an UPSERT keyed on (app, stage)', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await upsertStageUserState({ query } as any, 'app-1', 'phone-screen', { compTarget: '95000' }, '2026-06-05T14:00');
    const sql = query.mock.calls[0]![0] as string;
    expect(sql).toMatch(/INSERT INTO interview_stages/);
    expect(sql).toMatch(/ON CONFLICT \(job_application_id, stage_type\)/);
  });
});
```

- [ ] **Step 2: Run → FAIL.** Step 3: implement:
```typescript
/** @format */
import type { Queryable } from './applications.js';

export type PrepStatus = 'none' | 'queued' | 'ready' | 'failed';

/** Map coach pipeline_runs.status (+ coaching_content presence) → UI prep_status. */
export function reconcilePrepStatus(coachRunStatus: string | null, hasContent: boolean): PrepStatus {
  if (!coachRunStatus) return 'none';
  if (coachRunStatus === 'failed') return 'failed';
  if (coachRunStatus === 'complete') return hasContent ? 'ready' : 'queued';
  return 'queued'; // queued | coaching
}

export async function upsertStageUserState(
  db: Queryable, appId: string, stage: string, userState: Record<string, unknown>, scheduledAt: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO interview_stages (job_application_id, stage_type, user_state, scheduled_at)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (job_application_id, stage_type) DO UPDATE SET
       user_state = EXCLUDED.user_state,
       scheduled_at = COALESCE(EXCLUDED.scheduled_at, interview_stages.scheduled_at)`,
    [appId, stage, JSON.stringify(userState), scheduledAt],
  );
}

export async function markNotApplicable(db: Queryable, appId: string, stage: string): Promise<void> {
  await db.query(
    `INSERT INTO interview_stages (job_application_id, stage_type, stage_status)
     VALUES ($1, $2, 'not_applicable')
     ON CONFLICT (job_application_id, stage_type) DO UPDATE SET stage_status = 'not_applicable'`,
    [appId, stage],
  );
}

export interface StageRow { stage_type: string; stage_status: string; prep_status: PrepStatus; scheduled_at: string | null; user_state: Record<string, unknown>; coach_run_id: string | null }

/** Load per-stage rows for an app, reconciling prep_status from the coach run + coaching_content. */
export async function getStagesForApp(db: Queryable, appId: string): Promise<StageRow[]> {
  const r = await db.query<{ stage_type: string; stage_status: string; scheduled_at: string | null;
    user_state: Record<string, unknown>; coach_run_id: string | null; coach_status: string | null; has_content: boolean }>(
    `SELECT s.stage_type, s.stage_status, s.scheduled_at, s.user_state, s.coach_run_id,
            pr.status AS coach_status,
            EXISTS (SELECT 1 FROM coaching_content c WHERE c.job_application_id = s.job_application_id AND c.stage_type = s.stage_type) AS has_content
       FROM interview_stages s
       LEFT JOIN pipeline_runs pr ON pr.id = s.coach_run_id
      WHERE s.job_application_id = $1`,
    [appId],
  );
  return r.rows.map(row => ({
    stage_type: row.stage_type, stage_status: row.stage_status,
    prep_status: reconcilePrepStatus(row.coach_status, row.has_content),
    scheduled_at: row.scheduled_at, user_state: row.user_state ?? {}, coach_run_id: row.coach_run_id,
  }));
}
```

- [ ] **Step 4: Run → PASS; tsc.** Step 5: commit.
```bash
git add admin-api/src/lib/repositories/interview-stages.ts admin-api/src/lib/repositories/interview-stages.test.ts
git commit -m "feat(admin-api): interview-stages repo (upsert user_state, reconcile prep_status, not_applicable)"
```

## Task B3: `PATCH /:slug/stages/:stage` + per-stage map in `GET /:slug`

**Files:** Modify `admin-api/src/routes/applications.ts`.

- [ ] **Step 1:** Add `PATCH /:slug/stages/:stage`: auth-guard; load app by slug; body `{ userState?: object; scheduleAt?: string|null; markNotApplicable?: boolean }`. If `markNotApplicable` → `markNotApplicable(db, app.id, stage)`. Else `upsertStageUserState(db, app.id, stage, body.userState ?? {}, body.scheduleAt ?? null)`; **if `scheduleAt` was set AND `isPrepStage(stage)` → `dispatchCoach(...)` (fail-open)** + set `interview_stages.coach_run_id` on dispatch (extend dispatch to also write coach_run_id into the stage row — add `UPDATE interview_stages SET coach_run_id=$1 WHERE job_application_id=$2 AND stage_type=$3` in the dispatch path or after). Return `{ success: true }`.

- [ ] **Step 2:** In `GET /:slug`, add `stages: Object.fromEntries((await getStagesForApp(db, app.id)).map(s => [s.stage_type, s]))` to the response, and include `interviewStage: app.interview_stage`.

- [ ] **Step 3:** When `dispatchCoach` creates a run, persist `coach_run_id` into the stage row (so `getStagesForApp` can join). Add to the dispatch path:
```typescript
await db.query(
  `INSERT INTO interview_stages (job_application_id, stage_type, coach_run_id, prep_status, stage_status)
   VALUES ($1,$2,$3,'queued', COALESCE((SELECT stage_status FROM interview_stages WHERE job_application_id=$1 AND stage_type=$2),'current'))
   ON CONFLICT (job_application_id, stage_type) DO UPDATE SET coach_run_id=EXCLUDED.coach_run_id, prep_status='queued'`,
  [appId, stage, coachPipelineRunId]);
```
(Put this in `dispatchCoach` after `insertCoachRun`, passed an upsert callback so it stays testable; or inline in the route. Keep `prep_status` column as a cache; the read still reconciles authoritatively.)

- [ ] **Step 4: Test** the PATCH route (upsert + schedule-dispatch + markNotApplicable) and GET stages map. Run suite + tsc. Commit.
```bash
git add admin-api/src/routes/applications.ts <tests>
git commit -m "feat(admin-api): PATCH stages user_state/schedule/not-applicable + per-stage map in detail"
```

## Task B4: Creation seeding (starting stage)

**Files:** Modify `admin-api/src/routes/pipelines.ts` (the `POST /api/admin/pipelines/strategist-job` create path).

- [ ] **Step 1:** Accept `interviewStage` from the request body (default `'applied'`). After the `job_applications` INSERT, set the pointer + seed:
```typescript
const startStage = (body.interviewStage ?? 'applied').trim();
await db.query(`UPDATE job_applications SET interview_stage = $1 WHERE id = $2`, [startStage, applicationId]);
// Seed every stage BEFORE the starting stage as completed (no prep).
const order = ['applied','phone-screen','technical','system-design','behavioural','bar-raiser','final'];
const startIdx = Math.max(0, order.indexOf(startStage));
for (let i = 0; i < startIdx; i++) {
  await db.query(
    `INSERT INTO interview_stages (job_application_id, stage_type, stage_status)
     VALUES ($1,$2,'completed') ON CONFLICT (job_application_id, stage_type) DO NOTHING`,
    [applicationId, order[i]]);
}
if (startIdx > 0) {
  await db.query(
    `INSERT INTO interview_stages (job_application_id, stage_type, stage_status)
     VALUES ($1,$2,'current') ON CONFLICT (job_application_id, stage_type) DO UPDATE SET stage_status='current'`,
    [applicationId, order[startIdx]]);
}
```
(Do NOT dispatch coach at creation — Tier 0 only. Seeding earlier-stages-completed is what prevents retroactive prep.)

- [ ] **Step 2: Test** that creating with `interviewStage:'technical'` sets the pointer + seeds applied/phone-screen completed + technical current, and creating with default `'applied'` seeds nothing extra. Run + tsc. Commit.
```bash
git add admin-api/src/routes/pipelines.ts <test>
git commit -m "feat(admin-api): persist starting stage at creation + seed earlier stages completed"
```

## Task B5: PR-B gate + PR
- [ ] admin-api suite green + tsc; migration applied to dev. Open two commits/PRs: the migration (ai-applications → develop) and the admin-api changes (tucaken-app). Note: **apply migration before deploying admin-api / PR-A**.

---

# PR-C — UI: triggers + honest per-stage states (tucaken-app)

> Read each file before editing (line numbers drift). Verified seams: `NewAnalysisPanel.tsx` (form has `interviewStage` select, dropped today), `src/server/pipelines.ts` `triggerApplicationsAnalysisFn` (omits interviewStage) + dead `triggerStrategistCoachFn`, `StageProgressBar.tsx` `stageProgress(stage,current)`, `ApplicationDetailContainer.tsx` `handleAdvance`/`handleStageSelect`, `useStageDraft.ts` (localStorage), `applications.types.ts` `ApplicationDetail`.

## Task C1: Types + coach-dispatch server-fn
- [ ] Extend `ApplicationDetail` (`src/lib/types/applications.types.ts`) with `readonly interviewStage: InterviewStage` (authoritative) and `readonly stages?: Record<string, StageState>` where:
```typescript
export interface StageState {
  readonly stage_status: 'upcoming' | 'current' | 'completed' | 'not_applicable'
  readonly prep_status: 'none' | 'queued' | 'ready' | 'failed'
  readonly scheduled_at: string | null
  readonly user_state: Record<string, unknown>
  readonly coach_run_id: string | null
}
```
- [ ] Replace dead `triggerStrategistCoachFn` in `src/server/pipelines.ts` with `triggerCoachFn`:
```typescript
export const triggerCoachFn = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ slug: z.string().min(1), interviewStage: z.string().min(1),
    compensationTarget: z.string().optional(), region: z.string().optional(), force: z.boolean().optional() }))
  .handler(async ({ data }) => {
    await requireAuth()
    return apiFetch(`/applications/${encodeURIComponent(data.slug)}/coach`, {
      method: 'POST', pathTemplate: '/applications/:slug/coach',
      body: JSON.stringify({ interviewStage: data.interviewStage, compensationTarget: data.compensationTarget, region: data.region, force: data.force }),
    })
  })
```
- [ ] Add a `patchStageFn` server-fn → `PATCH /applications/:slug/stages/:stage` (body userState/scheduleAt/markNotApplicable). Typecheck + commit.

## Task C2: Forward starting stage at creation
- [ ] In `triggerApplicationsAnalysisFn` (`src/server/pipelines.ts`) + `analyseTriggerSchema`, add `interviewStage` and forward it in the POST body to `/pipelines/strategist-job`. In `NewAnalysisPanel.tsx`, ensure the existing `interviewStage` select value is passed through the mutation. Typecheck; commit `"feat(ui): forward starting stage at application creation"`.

## Task C3: StageProgressBar lifecycle
- [ ] Modify `StageProgressBar.tsx` to accept an optional `stages?: Record<string, StageState>` and, when present, derive each segment's display from `stages[stage].stage_status` (+ a "Generating…" badge when `prep_status==='queued'`), falling back to `stageProgress(stage, current)` when absent. Add a vitest for: completed/current/upcoming/not_applicable rendering + generating badge. Commit.

## Task C4: Workspace state machine (teaser/generating/ready/failed/not_applicable)
- [ ] Create a small shared `StagePrepGate` component: given `StageState | undefined` + the stage, render:
  - `not_applicable` → "Marked not applicable — no prep." 
  - `prep_status==='queued'` → "Generating your <stage> prep…" (spinner).
  - `prep_status==='failed'` → error + **Retry** (`triggerCoachFn force`).
  - `prep_status==='ready'` → render `children` (the actual workspace).
  - else (`upcoming/none`) → **teaser**: "<Stage> prep — generate when you reach this stage" + CTAs **Schedule** + **Advance to <stage>**; if `stage_status==='completed'` show **"Generate prep anyway"** (force).
- [ ] Wrap each non-Applied workspace (PhoneScreen/Technical/etc.) render in `StagePrepGate`. The Applied workspace always renders (Tier 1). Vitest the gate's branches. Commit.

## Task C5: Triggers (advance/schedule/select) + confirm + poll
- [ ] `handleAdvance` already calls status (auto-dispatch server-side) — ensure it passes `interviewStage: next` (it does). `handleStageSelect` → wrap in a confirm dialog ("Generate prep for this stage?") that on confirm calls `triggerCoachFn({ slug, interviewStage: stage })` then navigates. Schedule (ScheduleCard `setSchedule`) → call `patchStageFn({ slug, stage, scheduleAt })` (which dispatches server-side).
- [ ] In the detail hook (`use-admin-applications.ts`), extend the refetch-while-busy predicate to also poll while any `detail.stages?.[*].prep_status==='queued'` (so segments flip to Ready live). Commit.

## Task C6: useStageDraft → RDS
- [ ] Modify `useStageDraft.ts`: hydrate initial draft from `detail.stages?.[stage]?.user_state` (fallback localStorage); on change, debounce a `patchStageFn({ slug, stage, userState })` while keeping the localStorage write as an optimistic cache. Keep `compTarget` flowing into the coach dispatch (schedule/advance) via the dispatch body. Vitest where feasible; commit.

## Task C7: PR-C gate + PR
- [ ] `npm run typecheck` + `npm test` (vitest) green (note any pre-existing failures unrelated). Open PR-C (tucaken-app) → main. Depends on PR-A + PR-B deployed.

---

## Final E2E (manual, dev — after A+B+C merged + deployed + migration 050 applied)
- [ ] Create an app with starting stage **Technical** → applied/phone-screen show `completed` no prep, Technical `current` teaser.
- [ ] Advance to a stage → exactly ONE coach job (advance + an immediate schedule must NOT double-fire — dedup).
- [ ] Open the stage → teaser → Generating… → Ready; comp/career fields populated (Spec 2a).
- [ ] Mark a stage not_applicable → clean state, no prep.

## Self-review notes
- **Sequencing:** migration 050 (PR-B) must be applied before PR-A/B admin-api deploy (the `interview_stage` UPDATE + `interview_stages` columns). State this in PR descriptions.
- **Dedup is the safety net:** advance auto-dispatch + schedule immediate-dispatch both route through `dispatchCoach`'s `coachInFlightOrFresh` guard → no double-fire; `force` only via explicit Regenerate/retroactive.
- **prep_status authority:** stored as a cache on dispatch (`queued`) but the GET reconciles from the coach run + coaching_content, so a crashed/stale cache self-heals on read.
- **Fail-open everywhere:** advance/schedule dispatch failures never fail the user action.
- **No run-coach change** — status surface stays in admin-api + the coach `pipeline_runs` it already manages.
