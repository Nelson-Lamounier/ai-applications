# Projects: Onboarding Orchestrator + UI Clustering Triggers — Design

> **Date:** 2026-05-30
> **Status:** Approved (design); pending implementation plan
> **Scope:** One spec, two independent PRs. Closes the two remaining open items from the projects feature: (item 3) Phase-4 onboarding orchestrator, and (item 2) production trigger for clustering/case-study.

## Context

The portfolio **Project** domain (tables `projects`, `project_components`, `project_repositories`, + case-study children) sits above git `repositories`. A project's `shape` is `single_repo | multi_repo | monorepo_subset`. Two gaps remain after prior work:

- **Item 3 — onboarding:** migration `031` backfills one default `single_repo` project per repo *at bootstrap time only*. A repo connected **after** bootstrap gets no project (documented "Phase 4 work"). The repo is then invisible to the Project UI.
- **Item 2 — clustering trigger:** the clustering + case-study K8s Jobs (`applications/job-strategist/src/run-clustering.ts`, `run-case-study.ts`) and their admin-api dispatch endpoints already exist (shipped 2026-05-21: `POST /api/admin/projects/clustering/run`, `/:id/confirm`, `/:id/regenerate`). But **nothing calls them automatically**, and the feature gates `projects.clustering.enabled` / `projects.case_study.enabled` are **OFF by default** (missing `app_config` key → disabled → Job silently skips).

### Product rules (drive the design)

- **Free plan (production): 1 repo sync max.** That repo's default `single_repo` project **is** the free user's only project. Free users can **view** it in the Project UI.
- **Multiple projects / multi_repo clustering: Pro only.** (Consistent with clustering already short-circuiting at `< 2 repos`.)

## Scope

Two independent, separately-reviewable PRs sharing the projects domain in `tucaken-app/admin-api`:

- **PR A — Onboarding orchestrator (item 3):** every repo gets a default `single_repo` project at connect time (plan-agnostic). Redundant *pristine* defaults auto-archive when a multi_repo proposal is confirmed.
- **PR B — UI clustering triggers (item 2):** wire the existing dispatch endpoints to UI actions, enable the feature gates via a seed migration, and plan-gate multi_repo behind Pro.

### Out of scope (YAGNI)

- Event-driven post-ingestion auto-clustering (no ingestion-completion hook exists; not building one).
- 24h auto-confirm cron (explicitly deferred in prior decision).
- The free-tier repo-quota value change (currently `free = 3/mo`; product rule says 1). **Noted as a dependency**, not built here — it's a quota-config change in `github.ts`, separate from projects.
- Frontend visual-design polish.

---

## PR A — Onboarding orchestrator

### A1. `ensureDefaultProject` helper

New function in `tucaken-app/admin-api/src/lib/repositories/projects.ts`:

```
ensureDefaultProject(db: PoolClient, userId: string, repositoryId: string, repoFullName: string): Promise<void>
```

Mirrors migration `031` for a single repo, fully idempotent:

1. **Guard:** no-op if the repo already has any `project_repositories` link (`WHERE NOT EXISTS (SELECT 1 FROM project_repositories WHERE repository_id = $repositoryId)`) — same guard as `031`.
2. Otherwise insert, in the caller's transaction:
   - `projects`: `shape='single_repo'`, `is_ai_suggested=FALSE`, `is_user_confirmed=FALSE`, `status='active'`, `role_exhibited='sole_builder'`, `visibility='private'`, `slug` derived from `full_name` (lower-case, non-`[a-z0-9]`→`-`, trim dashes — identical to `031`), `name` = repo short name.
   - `project_components`: `name='Main'`, `kind='shared'`, `order_index=0`.
   - `project_repositories`: link component → repository, `subpath=''`.

Plan-agnostic: runs for free and pro. For a free user this is the one project they see.

### A2. Call sites

Call `ensureDefaultProject` wherever a `repositories` row is created — all already inside a `withUser` transaction (RLS + tx handled):

- `POST /connected-repos` main dispatch path (immediately after `insertRepository`).
- `POST /connected-repos` **deferSync** branch (after `insertRepository`).
- GitHub webhook installation path **if** it inserts `repositories` rows (verify during implementation; wire only if it does).

Idempotent guard makes all sites safe and re-runnable.

### A3. Failure stance — transactional / fatal

`ensureDefaultProject` runs in the **same transaction** as the repo insert. If it throws, the repo insert rolls back too. Rationale: a repo with no project is precisely the bug being fixed — fail loudly rather than silently recreate the gap. (Contrast: tech-extract dispatch is intentionally best-effort/non-fatal; default-project creation is not.)

### A4. Dedup on confirm — `archiveSupersededDefaults`

New helper, called inside the existing `POST /:id/confirm` handler, in the same `withUser` transaction, after `is_user_confirmed=TRUE` is set:

```
archiveSupersededDefaults(db: PoolClient, userId: string, confirmedProjectId: string): Promise<string[]>  // archived project ids
```

1. Resolve the repo ids linked to the confirmed multi_repo project (`project_repositories → project_components WHERE project_id = confirmedProjectId`).
2. Find **other** `single_repo` projects for this user whose component links any of those repos.
3. Archive only **pristine** defaults — guard:
   `shape='single_repo' AND is_user_confirmed=FALSE AND case_study_status IS NULL AND (user_overrides = '{}'::jsonb OR user_overrides IS NULL)`.
4. `UPDATE ... SET status='archived'` (reversible; drops out of public + default list views). **No deletion.**

Edited/published single_repo projects (case study present, or `user_overrides` non-empty) **survive** — the user keeps both and resolves manually. No silent loss of work.

### A5. Confirm response

Extend the confirm handler's JSON: `{ confirmed, dispatched, pipelineRunId, jobName, projectId, archivedDefaults: string[] }`. Log archived ids. UI can show "N standalone projects merged in."

---

## PR B — UI clustering triggers + gates

Spans **two repos** (admin-api in tucaken-app; the gate seed migration in ai-applications).

### B1. Plan gate on `POST /clustering/run` (admin-api)

Resolve `users.plan` (reuse the existing plan-lookup pattern in `github.ts`). Reject non-`pro` with `403 { error: 'Multi-repo projects require Pro' }`. Defense-in-depth so a bypassed UI still can't cluster. `/:id/confirm` and `/:id/regenerate` need no new gate — they act only on existing proposals, which only Pro could have created.

### B2. Feature-gate seed migration (ai-applications)

New migration `applications/platform-rds-bootstrap/migrations/044_enable_project_features.sql`:

```sql
INSERT INTO app_config (key, value) VALUES
  ('projects.clustering.enabled', '{"enabled": true}'::jsonb),
  ('projects.case_study.enabled', '{"enabled": true}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
```

Idempotent (`ON CONFLICT DO UPDATE`), matches existing migration style, applies on bootstrap across envs. These are the keys `run-clustering.ts` / `run-case-study.ts` check at startup.

> Migration sequencing note: `044` must follow the bootstrap-idempotency work already merged; the runner re-applies every `.sql` each boot (no `schema_migrations` table), so the seed is safe to re-run.

### B3 + B4. Frontend — clustering trigger + proposal review (tucaken-app)

> **Correction (verified against `origin/main` during planning):** the review flow is **already built and wired** — route `src/app/_dashboard/projects/review.tsx` → `ProjectReviewStep` (`src/features/projects/components/review/ProjectReviewStep.tsx`) already calls `useRunClustering()` + `useConfirmProject()` and lists proposals via `projectsQueries.proposals()`. Server fn `runClusteringFn` exists. So B3/B4 are **not** net-new builds — the only frontend gap is **plan-gating**, and `AuthUser` (`src/server/session.ts`) currently exposes only `{ id, email }` — **no `plan`**.

Scope of frontend work, therefore:
- **Add `plan` to the session/`AuthUser`.** Extend `getUserSessionFn` to read `users.plan` and add `plan: string` to `AuthUser`. (Server gate on `/clustering/run` is the real enforcement; this is for UX hiding.)
- **Hide the run-clustering trigger for non-pro.** In `ProjectReviewStep` (and any entry point that surfaces "Find multi-repo projects"), gate the `useRunClustering` action on `plan === 'pro'`; show nothing (or a disabled state) for free. Server still rejects non-pro (B1) as the hard guard.
- **No rebuild** of the confirm/dismiss/proposal-list UI — it exists. Verify it renders the superseded-default archival result if surfaced (optional; `archivedDefaults` is additive in the confirm response).

---

## Data flow

```
connect repo ──> insertRepository + ensureDefaultProject ──> single_repo project (all plans)
                                                                    │
pro user ─> "Find multi-repo" ─> POST /clustering/run ─> Job ─> multi_repo proposal (is_ai_suggested)
                                                                    │
review ─> Confirm ─> POST /:id/confirm ─> is_user_confirmed = TRUE
                                          ├─> dispatch case-study Job
                                          └─> archiveSupersededDefaults (pristine single_repo → archived)
```

---

## Testing

### PR A (tucaken-app, jest + pg mock — existing admin-api pattern)

- `ensureDefaultProject`: creates default when absent; no-op when repo already linked (idempotent); correct slug derivation; rolls back with the repo insert on failure.
- `archiveSupersededDefaults`: archives pristine single_repo defaults for confirmed repos; **leaves** edited ones (case_study_status set / user_overrides non-empty / is_user_confirmed); returns archived ids; user-scoped only.
- confirm handler: still flips confirm + dispatches case-study; now returns `archivedDefaults`.

### PR B

- `POST /clustering/run`: `403` for non-pro, `202` for pro.
- Migration `044`: idempotent re-run (`ON CONFLICT`); both keys present and enabled.
- Frontend: action hidden for free; visible/functional for pro (component test).

### End-to-end proof (manual, dev)

With the existing 2-repo pro user (`1d4c645a`, repos cdk-monitoring + ai-applications): enable gates → "Find multi-repo" → verify a real `multi_repo` proposal row → Confirm → case-study dispatches + the two pristine single_repo defaults archive. Closes the original "prove clustering end-to-end" thread.

---

## Dependencies & assumptions

- Free-tier repo limit should become **1 repo** in prod (product rule). The current quota is `free = 3/mo` in `github.ts`; changing it is a separate config/plan change, **not** in these PRs.
- The clustering/case-study Jobs and dispatch endpoints already exist and work (verified). This spec adds *callers, gates, and onboarding*, not the Jobs.
- Ingestion image already carries the Titan token-overflow fix (PR #97) and CI rebuilds on `applications/shared/**` (PR #98).

## Files touched (anticipated)

**tucaken-app:**
- `admin-api/src/lib/repositories/projects.ts` — `ensureDefaultProject`, `archiveSupersededDefaults`
- `admin-api/src/routes/github.ts` — call `ensureDefaultProject` at repo-insert sites
- `admin-api/src/routes/projects.ts` — plan gate on `/clustering/run`; dedup + response in `/:id/confirm`
- `src/features/projects/**`, `src/server/projects.ts` — clustering action (pro-gated) + proposal review wiring
- corresponding `*.test.ts`

**ai-applications:**
- `applications/platform-rds-bootstrap/migrations/044_enable_project_features.sql`
