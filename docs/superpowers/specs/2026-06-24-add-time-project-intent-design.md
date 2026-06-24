# Add-time Project intent — design

**Date:** 2026-06-24
**Status:** approved (design)
**Repos:** tucaken-app (frontend modal + admin-api intent/reconciler) + ai-applications (ingestion post-sync apply).

## Problem

A free-tier sync of a repo creates a project via `ensureDefaultProject` with
`is_user_confirmed = FALSE` (a "default"). The Projects page only renders
`isCurated` = `is_user_confirmed = TRUE`; defaults are hidden. So a single-repo
default has **no UI path** to become a confirmed project and generate a case
study (only AI proposals or manual project creation do). The user wants, at
**Add** time, to choose what happens to the repo — build a new Project, link it
to an existing one, or just add it to the knowledge base — and have the Project
generation run **after the sync completes** (the case study needs the synced
commits/PRs/KB).

## Decisions (locked)

1. **Timing:** the case-study workflow fires **after the ingestion Job completes
   successfully**, not at Add (the case study needs the synced data).
2. **Options:** **Build new** / **Link to existing** / **KB-only**.
3. **Scope:** the Project-intent choice is for **ALL users**. The free/premium
   enrichment toggle stays **test-user-gated** (shows first, for the test user).
4. **Dispatch (mechanism A):** a small **admin-api reconciler** dispatches the
   case-study Job for confirmed `case_study_status='pending'` projects with no
   active run — fully server-side, robust regardless of the browser.

## Building blocks reused (no new generation logic)

- `POST /projects/:id/confirm` (admin-api): flips `is_user_confirmed=TRUE`, sets
  `case_study_status='pending'`, dispatches the case-study Job.
- `mergeProjectsFn` + `regenerateProjectFn` (frontend `useIntegrateRepo`):
  merge a source project into a target + regenerate.
- `dispatchCaseStudyJob` (admin-api): K8s `job-strategist` Job, `run-case-study.js`.
- `ensureDefaultProject` (admin-api): already creates the single-repo default on connect.

## Components

### 1. Frontend — `ProjectIntentModal` (tucaken-app)

A sibling of `EnrichmentModal` in `src/features/github/components/`. On **Add** in
`GitHubRepoPicker`, after the repo is chosen, present three choices:

- **Build a new Project** — confirm this repo's default project + generate (after sync).
- **Link to an existing Project** — a picker of the user's confirmed projects
  (`projectsQueries.list`, `is_user_confirmed=true`); merge this repo in + regenerate (after sync).
- **Add to knowledge base only** — today's behaviour (no project action).

Flow in `GitHubRepoPicker.handleAdd`:
- Test user: `EnrichmentModal` (free/premium) -> then `ProjectIntentModal`.
- Everyone else: `ProjectIntentModal` only.
- The chosen `{ projectIntent: 'build' | 'link' | 'none', targetProjectId? }` is
  passed to `doAdd` -> `useGitHubIngestion` -> `triggerGitHubIngestionFn` ->
  admin-api `POST /connected-repos` (alongside the existing `enrichment` field).

### 2. Durable intent on the default project (migration)

A numbered migration adds to `projects`:
- `post_sync_action TEXT` — `'build' | 'link' | NULL` (NULL = nothing pending).
- `post_sync_target_project_id UUID` — the link target (NULL for build).

`ensureDefaultProject` / the connect route stamps these on the repo's default
project when the connect carries a project intent. KB-only leaves them NULL.

### 3. admin-api — accept + store the intent

`POST /connected-repos` accepts `projectIntent` + `targetProjectId`
(validated; `targetProjectId` required when `projectIntent='link'`, must be a
confirmed project owned by the user). `connectRepoWithDefaultProject` stamps
`post_sync_action` + `post_sync_target_project_id` on the default project (inside
the same transaction that creates it).

### 4. Ingestion Job — apply the DB part at sync-completion (ai-applications)

At the end of a **successful** ingestion (where the profile rollup already runs),
a new best-effort step reads the repo's default project's `post_sync_action` and
applies it against the DB (the job has the pool); never fatal to the sync:

- **build** -> `is_user_confirmed=TRUE`, `case_study_status='pending'`, clear `post_sync_action`.
- **link** -> re-point this repo's `project_repositories` rows onto the target
  project's primary component, archive the now-empty single-repo default
  (status='archived'), set the target `case_study_status='pending'`, clear the action.
- **NULL** -> no-op.

This fires even if the user closed the browser. It only writes DB; it does NOT
dispatch the Job (admin-api owns dispatch).

### 5. admin-api — case-study reconciler (mechanism A)

A light interval loop in the existing admin-api service (e.g. every 30s) that:
- selects projects with `is_user_confirmed=TRUE AND case_study_status='pending'`
  AND no active case-study pipeline run AND not dispatched within a debounce window,
- dispatches `dispatchCaseStudyJob` for each (reusing the existing dedup/gate),
- is idempotent and self-resolving (a project moves out of `pending` once its run starts).

This decouples the trigger from the browser and from the ingestion Job: any
project left in `pending` (by the ingestion apply step OR `confirm`) gets its
Job dispatched. The existing on-demand `confirm`/`regenerate` dispatch stays.

### 6. Projects page — surface pending-action defaults (also unblocks today)

A single-repo default with `post_sync_action` set (or freshly confirmed but
`case_study_status` null/pending) renders on the Projects page as an actionable
**"Finishing setup… / Generate"** card rather than being hidden, so the user can
see/complete it. This gives any stuck default a UI path (and is how
`frontend-portfolio` was unblocked manually for this iteration).

## Data flow

```text
Add (GitHubRepoPicker)
  -> ProjectIntentModal: build | link(target) | none
  -> triggerGitHubIngestionFn({ repoFullName, enrichment?, projectIntent, targetProjectId? })
  -> admin-api POST /connected-repos
       connectRepoWithDefaultProject -> ensureDefaultProject
         + stamp post_sync_action / post_sync_target_project_id on the default project
       dispatch ingestion Job
            |
            v  (ingestion runs; on success, post-sync apply step)
  build -> default project confirmed + case_study_status='pending'
  link  -> repo re-pointed into target component; default archived; target pending
            |
            v  (admin-api reconciler, ~30s)
  pending projects with no active run -> dispatchCaseStudyJob (job-strategist)
            |
            v
  case study generated + persisted; Projects page shows the curated project
```

## Error handling / safety

- The ingestion apply step is **best-effort, never fatal** (a failure leaves the
  intent pending; the user can complete it from the Projects card).
- The reconciler is idempotent + debounced (no duplicate Jobs); a dispatch
  failure is retried on the next tick.
- `link` validates the target is a confirmed project owned by the same user
  (checked at `POST /connected-repos` accept time AND defensively in the apply step).
- KB-only is the default when no intent is sent (back-compat: existing callers
  that send no `projectIntent` behave exactly as today).
- RLS: all project mutations run under the user's RLS context
  (`set_config('app.current_user_id', ...)`), matching existing repositories.

## Testing

- **Frontend:** `ProjectIntentModal` renders the 3 choices + the existing-project
  picker (link); `handleAdd` routes test-user (enrichment then intent) vs others
  (intent only); the chosen intent is threaded to the mutation. vitest.
- **admin-api:** `POST /connected-repos` stamps `post_sync_action`/target on the
  default project for build/link, validates the link target, leaves NULL for
  KB-only; the reconciler selects only confirmed+pending+no-active-run and
  dispatches once (dedup). Jest.
- **ingestion apply:** build confirms; link re-points + archives + sets target
  pending; NULL no-ops; a thrown error is non-fatal. Jest.
- **migration:** the two new columns + a runnable up; the migration ledger
  accepts it (checksum).

## Out of scope

- Changing the case-study agent / generation logic.
- Auto-generating for KB-only repos.
- Multi-repo "build" at Add (one repo at a time; clustering stays the AI-proposal path).
- Backfilling existing hidden defaults (only new Adds carry an intent; existing
  defaults remain reachable via the new Projects-page card).
