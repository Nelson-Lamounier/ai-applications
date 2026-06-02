# Intent-Tiered Stage-Prep Triggering — Design (Spec 2b)

> **Date:** 2026-06-01
> **Status:** Approved design (brainstorming complete). Implementation plan next.
> **Goal:** Trigger the Coach on user-demonstrated intent (advance / schedule / select),
> idempotently, with an honest per-stage UX (teaser → generating → ready). Persist
> per-stage lifecycle + user state. Handle joining mid-process.
> **Repos:** `ai-applications` (RDS migration) + `tucaken-app` (admin-api + UI).
> **Depends on:** Phone Screen prep generation (Spec 2a) + career-data pipeline
> (#111/#112/#113), all merged + confirmed live. The coach now produces grounded prep;
> this spec makes it *fire at the right time* and surfaces state.

## The four-tier intent model

Each application progresses through tiers of demonstrated intent; the system spends
progressively more compute as intent strengthens.

- **Tier 0 — JD analyzed.** User submits a JD. Runs the existing analysis pipeline
  (Research → Strategist). **No stage prep.** *Already exists.*
- **Tier 1 — Applied data.** The Applied workspace renders the analysis output
  (JD↔evidence map, resume, cover letter, tracking). **Zero new LLM** — it renders Tier-0
  output. *Already exists.*
- **Tier 2 — User advances to / schedules / selects a stage.** The strong signal. **Dispatch
  the full coach for that stage.** This is the work this spec wires.
- **Tier 3 — User opens the workspace.** Reads cached prep. If generated at Tier 2 it's
  instant; otherwise a clear loading/teaser state.

## Current state (verified)

- **App creation == Tier 0 analyse trigger** (`POST /api/admin/pipelines/strategist-job`):
  INSERTs `job_applications` (`kanban_status='analysing'`), INSERTs `pipeline_runs`,
  dispatches `run-pipeline`. The new-application form *collects* `interviewStage` but
  **drops it** (never forwarded/persisted).
- `job_applications` has **no `interview_stage` column**; the detail endpoint's
  `interviewStage` is effectively a fixed pointer. Stage display is pure index math
  (`stageProgress(stage, current)`) — **no per-stage lifecycle** (no completed/not_applicable).
- `POST /:slug/coach` exists + works but: requires the caller to pass
  `strategistPipelineRunId` + 5 fields, has **no dedup**, **no stage gate**, and **nothing
  calls it** (the UI `triggerStrategistCoachFn` is dead, wrong endpoint).
- `GET /:slug` already resolves + exposes `latestAnalysisRunId` (latest complete strategist run).
- `interview_stages` table is **unused** (cols: `id, job_application_id, stage_type,
  scheduled_at, completed_at, outcome, notes, created_at`). Next migration: **050**.
- Canonical `STAGE_ORDER` (tucaken-app): `applied, phone-screen, technical, system-design,
  behavioural, bar-raiser, final`. Interview-prep stages = all except `applied`.

## Components

### Component A — Self-resolving, deduped, gated coach dispatch (admin-api)

Refactor `POST /:slug/coach` so the body is just `{ interviewStage, compensationTarget?,
region?, force? }`:
- **Self-resolve** `strategistPipelineRunId` via a shared helper (the latest-complete
  strategist query already in `GET /:slug`), plus `targetCompany`/`targetRole`/
  `jobDescription` from the `job_applications` row.
- **Gate:** dispatch only for interview-prep stages (`phone-screen, technical,
  system-design, behavioural, bar-raiser, final`); reject `applied` and non-stage statuses
  with a clear 4xx.
- **Dedup:** skip dispatch if a coach for `(application, stage)` is in-flight
  (`pipeline_runs` type=`coach` status `queued|coaching`) or already complete — **unless
  `force=true`** (Regenerate / retroactive). Guarantees one in-flight coach per stage and
  no double-fire when advance + schedule coincide.
- On dispatch: keep the existing coach `pipeline_runs` insert + K8s Job; **upsert the
  `interview_stages` row** with `coach_run_id`.
- Extract the dispatch into an internal function `dispatchCoach(db, app, stage, opts)` so
  `/status` (advance) can call it directly.

### Component B — Persistence: lifecycle + user state (RDS + admin-api)

**Migration 050:**
- `ALTER TABLE job_applications ADD COLUMN interview_stage TEXT NOT NULL DEFAULT 'applied'`
  (the current-stage pointer — authoritative, replaces the derived pointer).
- `ALTER TABLE interview_stages ADD COLUMN user_state JSONB NOT NULL DEFAULT '{}'`,
  `ADD COLUMN coach_run_id UUID`, `ADD COLUMN prep_status TEXT NOT NULL DEFAULT 'none'`,
  `ADD COLUMN stage_status TEXT NOT NULL DEFAULT 'upcoming'`,
  `ADD CONSTRAINT interview_stages_app_stage_uniq UNIQUE (job_application_id, stage_type)`.
  - `stage_status` ∈ `upcoming | current | completed | not_applicable`.
  - `prep_status` ∈ `none | queued | ready | failed` — **reconciled on read** from the coach
    `pipeline_runs(coach_run_id).status` + `coaching_content` presence (no write into
    `run-coach`; admin-api owns the mapping).

**Endpoints (admin-api):**
- `PATCH /:slug/stages/:stage` — upsert `user_state` (compTarget/checkedItems/scheduleAt/
  formatNote/notes) + `scheduled_at`; supports `{ markNotApplicable: true }` →
  `stage_status='not_applicable'`. When `scheduleAt` is set, **also dispatch the coach now**
  (immediate, via `dispatchCoach`, deduped).
- `GET /:slug` — include a per-stage map: `{ [stage]: { stage_status, prep_status,
  scheduled_at, user_state, coach_run_id } }` (prep_status reconciled).

**Advance (`POST /:slug/status`):** after updating `kanban_status`, **persist
`job_applications.interview_stage = newStage`**, upsert `interview_stages`: previous current
→ `completed`, new → `current`; then **`dispatchCoach`** for the new stage (deduped,
fail-open — a dispatch failure must NOT fail the status update).

**Creation seeding (the analyse-trigger endpoint):** accept + forward the form's
`interviewStage` (today dropped). On create: set `job_applications.interview_stage =
startingStage`; seed `interview_stages`: every stage **before** startingStage →
`stage_status='completed'` (no prep), startingStage → `current`. → joining mid-process
generates no retroactive prep.

### Component C — UI: triggers + honest per-stage states (tucaken-app)

- **Coach-dispatch server-fn** (replaces dead `triggerStrategistCoachFn`) → `POST /:slug/coach
  { interviewStage, compensationTarget?, region?, force? }`.
- **`StageProgressBar`** reads `interview_stages` lifecycle (`stage_status`/`prep_status`)
  when present — `completed/current/upcoming/not_applicable`, plus a "Generating…" indicator
  when `prep_status='queued'` — falling back to index math when no rows exist.
- **Workspace state machine** per `(stage_status, prep_status)`:
  - `upcoming` + `none` → **teaser**: *"<Stage> prep — generate when you reach this stage"* +
    CTAs **"Schedule <stage>"** and **"Advance to <stage>"**.
  - `prep_status='queued'` → "Generating…"; `ready` → render prep; `failed` → error + **Retry**.
  - `not_applicable` → clean "marked not applicable — no prep"; a "Mark not applicable" action.
  - `completed` + `none` → "this stage is done" + a **"Generate prep anyway"** CTA (retroactive,
    `force`).
- **Triggers:** Advance button → existing `/status` (now auto-dispatches). Schedule set →
  `PATCH /:slug/stages/:stage` (persist + immediate dispatch). Stage-select → **confirm
  dialog** ("Generate prep for this stage?") → dispatch.
- **New-application form:** keep the `interviewStage` select as the **starting-stage picker**;
  forward it through the server-fn + admin-api trigger.
- **`useStageDraft`:** migrate localStorage → `PATCH /:slug/stages/:stage` (RDS-backed), keep
  localStorage as an optimistic cache; reads hydrate from `GET /:slug` per-stage `user_state`.
- Poll `GET /:slug` while any visible stage `prep_status='queued'` (reuse the existing
  detail-poll-while-analysing pattern) so the segment transitions to Ready live.

## Data flow

```
create app (pick starting stage)
  └─ INSERT job_applications(interview_stage=start) + seed interview_stages(earlier=completed)
  └─ Tier 0 analyse (run-pipeline)                       [existing]

Tier 2 trigger (advance | schedule-set | select+confirm)
  └─ POST /:slug/coach { interviewStage }  (or /status advance → dispatchCoach)
       ├─ gate (interview stage?) + dedup (in-flight/fresh? unless force)
       ├─ resolve strategistPipelineRunId + app fields
       ├─ insert coach pipeline_run + K8s coach Job; upsert interview_stages.coach_run_id
  └─ run-coach → coaching_content (Spec 2a grounded prep)

Tier 3 (open workspace)
  └─ GET /:slug → per-stage { stage_status, prep_status(reconciled), user_state, scheduled_at }
  └─ workspace renders teaser/generating/ready/failed/not_applicable; Regenerate = force
```

## Error handling & safety
- Advance dispatch is **fail-open**: status update commits even if dispatch fails; prep is
  retryable via the workspace.
- Dedup prevents double-dispatch (advance + schedule) and runaway cost; one in-flight coach
  per stage; `force` is the only override.
- Gate prevents prep for non-interview stages.
- `prep_status` reconcile is read-only and defensive (missing coach run → `none`/`queued`).
- `PATCH` user_state is last-writer-wins per `(app, stage)`; localStorage stays an optimistic
  cache so a failed PATCH never loses the user's typing.

## Testing
- **A:** dedup (in-flight/fresh skip; `force` overrides), gate (non-interview rejected),
  self-resolve (missing strategist run → 4xx), dispatchCoach reuse from `/status`.
- **B:** migration applies; PATCH upsert + markNotApplicable; advance sets pointer + lifecycle
  + dispatch (fail-open); creation seeds earlier=completed; prep_status reconcile mapping.
- **C:** workspace state machine per `(stage_status, prep_status)`; StageProgressBar lifecycle
  vs fallback; starting-stage forwarded; schedule/select trigger; localStorage→RDS hydrate.
- **E2E (manual, dev):** create app at Technical → earlier stages completed, no prep; advance
  to a stage → coach dispatched once (advance+schedule doesn't double-fire); open → teaser→
  generating→ready.

## Decomposition (3 PRs)
- **PR-A** (`tucaken-app/admin-api`): `/coach` self-resolve + dedup + gate + `dispatchCoach`;
  `/status` advance → persist pointer + lifecycle + auto-dispatch (fail-open).
- **PR-B** (`ai-applications` migration + `tucaken-app/admin-api`): migration 050; creation
  seeding (forward/persist starting stage); `PATCH/GET` stage endpoints; `prep_status`
  reconcile; `not_applicable`.
- **PR-C** (`tucaken-app` UI): coach server-fn; `StageProgressBar` lifecycle; workspace
  state machine (teaser/generating/ready/failed/not_applicable/regenerate); new-app
  starting-stage forward; schedule/select triggers + confirm; localStorage→RDS.

PR-A and PR-B are admin-api/RDS; PR-C is the UI repo. A → B → C order (A+B backend first,
then UI consumes).

## Out of scope
- Auto-staleness detection / auto-regenerate on open (v1 = manual **Regenerate** button; JD/
  résumé/ontology-version staleness deferred).
- Timed/scheduled background dispatch (schedule = immediate dispatch, no cron/worker).
- Story bank / StoryMiningAgent (Behavioural) and other not-yet-built stage agents.
- Changing the coach/analysis generation itself (Spec 2a, done).
