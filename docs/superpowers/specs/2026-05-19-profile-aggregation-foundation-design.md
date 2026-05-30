# SP0 — Profile Aggregation Foundation — Design

**Date:** 2026-05-19
**Status:** Approved (design); pending implementation plan
**Parent initiative:** Profile Intelligence product (6 user-facing features). This is
**sub-project 0 of N** — the shared data foundation. The user-facing features
(Mirror, Reveal, Reconciliation, Distillation, Direction, Diagnostic) are each
their own later spec → plan → build cycle and are **out of scope** here.

## Problem

`repository_profiles` (migration 014) holds one `ExtractedRepoData` row **per
(user, repo)**. There is **no per-user aggregation of any kind** — no
languages-by-volume, domain mix, complexity/role distribution, activity
timeline, or totals. Four of the six downstream features (Mirror, Reveal,
Direction, Diagnostic) cannot be built without this rollup. SP0 delivers it as
reusable, testable data infrastructure with no user-facing surface.

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Compute/storage | Precomputed `user_profile_rollup` table (one row/user) |
| Repo scope | `classification='project' AND is_hidden=false AND extraction_status='completed'` |
| Aggregate fidelity | Best-effort proxy from existing signals, **honest methodology labelling** (no new GitHub fetch) |
| Refresh | Best-effort full recompute at end of each ingestion job, in `run-ingestion.ts` |
| Delivery boundary | Data + pure compute fn + repository + refresh wiring + tests. **No HTTP/UI.** Rollup table + documented JSON shape is the contract. |
| Architecture | Approach A — shared pure-fn + JSONB rollup, mirroring the `computeKbQuality` / retrieval-probe pattern |

## Architecture & Boundaries

```
run-ingestion.ts  (after profile extraction reaches status 'completed',
                    beside the existing kb-quality / retrieval-probe block)
  └─ best-effort:
       rows   = UserProfileRollupRepository.listProjectProfilesForRollup(userId)
       rollup = computeUserProfileRollup(rows)          ← PURE, zero I/O
       UserProfileRollupRepository.upsert(userId, rollup)
       wrapped in tracer.startActiveSpan('ingestion.profile_rollup', …)
       catch → record exception, SWALLOW; never fail ingestion / sync state

shared/src/rds/profile/
  computeUserProfileRollup.ts   pure fn + types (twin of computeKbQuality.ts)
  UserProfileRollupRepository.ts (interface + Rds impl, or single impl class
                                  consistent with sibling repositories)
applications/platform-rds-bootstrap/migrations/024_user_profile_rollup.sql
```

`shared` owns the contract + math; the ingestion app owns the refresh trigger.
The `user_profile_rollup` row and its documented JSON shape **is** the contract
later feature SPs consume (tucaken-app admin-api already SELECTs the shared RDS
under Cognito + RLS). SP0 ships no route and no UI.

## Data Model — `024_user_profile_rollup.sql`

```sql
CREATE TABLE IF NOT EXISTS user_profile_rollup (
    user_id             UUID         PRIMARY KEY
                                     REFERENCES users(id) ON DELETE CASCADE,
    project_repo_count  INTEGER      NOT NULL DEFAULT 0,
    total_repo_count    INTEGER      NOT NULL DEFAULT 0,
    methodology_version INTEGER      NOT NULL DEFAULT 1,
    rollup              JSONB        NOT NULL DEFAULT '{}',
    refreshed_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);
```

- RLS enabled with a policy `USING/WITH CHECK
  (user_id = current_setting('app.current_user_id', true)::uuid)` — identical
  pattern to `repository_profiles` (014) and the RLS pipeline tables.
- Idempotent: `CREATE TABLE IF NOT EXISTS`; RLS enable + policy guarded so
  re-running the bootstrap Job is safe (same idempotency rule as all migrations
  — the bootstrap re-runs every `.sql` each deploy, no version tracking).
- One row per user; write path is upsert `ON CONFLICT (user_id) DO UPDATE`.
- `project_repo_count` / `total_repo_count` are denormalised scalars for cheap
  filtering/sorting without parsing JSONB; the full aggregate is `rollup`.

## Pure Aggregation — `computeUserProfileRollup(rows) → UserProfileRollup`

Pure, zero I/O, no Bedrock, deterministic — twin of `computeKbQuality.ts`.

**Input** (`ProfileAggInput[]`): the repository's read returns, for the user,
every extracted profile row projecting only the fields needed:
`classification`, `isHidden`, `extractionStatus`, and from `extracted`:
`primary_language` (nullable), `commit_count`, `last_active_at` (nullable ISO),
`domain`, `complexity`, `role_inferred`, `tech_stack[]`, `repo_full_name`.

The pure fn applies the **headline scope** itself (`classification==='project'
&& !isHidden && extractionStatus==='completed'`) so the rule lives in one
testable place; it also receives the non-qualifying rows so it can compute
`classificationCounts` (context for later SPs) without a second query.

**Output `rollup` JSONB shape:**

- `languages[]` — `{ language, repoCount, commitVolumeProxy, sharePct }`,
  ranked desc by `commitVolumeProxy = Σ signals.commit_count over qualifying
  repos where primary_language === language`. `null`/empty primary_language →
  bucket `language: "unknown"`. `sharePct` = `commitVolumeProxy / Σ all
  commitVolumeProxy`, rounded 2dp. Store **all** languages (top-5 is a render
  concern, not a storage one). Stable tiebreak: language name ascending.
- `domains{}` — `{ counts: { <domain>: n, … }, dominant: <domain|null> }`,
  repo-count by the `domain` enum over qualifying repos. `dominant` = max
  count, tie broken by enum order; `null` when no qualifying repos.
- `complexity{}` — `{ simple, moderate, complex }` counts (qualifying repos).
- `roles{}` — `{ creator, maintainer, contributor }` counts (qualifying repos).
- `techStackTop[]` — `{ tech, repoCount }`, frequency of each entry across
  qualifying repos' `extracted.tech_stack[]`, ranked desc, tiebreak name asc.
  Store all; ranking is the value.
- `activityArc[]` — qualifying repos sorted ascending by `last_active_at`:
  `{ repoFullName, lastActiveAt, primaryLanguage, domain }`. Repos with `null`
  `last_active_at` are excluded from the arc (and from `activeYearsApprox`) but
  still counted everywhere else. This is a **timeline**, not a narrative — the
  career-arc *characterisation* is a later SP's LLM concern.
- `totals{}` — `{ projectRepoCount, totalCommitVolumeProxy, earliestActivity,
  latestActivity, activeYearsApprox }`. `activeYearsApprox` =
  `(latestActivity − earliestActivity)` in years rounded 1dp, `0` when <2
  dated repos.
- `classificationCounts{}` — counts across **all** input rows by
  `classification` (`project/fork/tutorial/abandoned/noise/stale`) plus
  `hiddenCount`. Headline aggregates above ignore these; they exist so
  downstream SPs (e.g. Reveal external-contribution, Reconciliation) are not
  blocked by SP0's narrow scope.
- `methodology{}` — `{ version: 1, commitVolume: "primary-language
  commit-count proxy (not per-line)", domainMix: "repo-count share", scope:
  "classification=project, !hidden, completed", confidence: "aggregates derived from per-repo profile signals; language ranking is a commit-count proxy, not line-level" }`
  so downstream LLM copy hedges honestly instead of overclaiming
  "by commit volume".

**Edge cases:** empty/zero qualifying repos → all arrays empty, all counts 0,
`dominant: null`, `activeYearsApprox: 0`, `methodology` still present — the
row is still upserted so consumers get a deterministic empty contract.
`null` primary_language → `"unknown"` language bucket. `null` last_active_at →
excluded from `activityArc`/`activeYearsApprox` only. All ordering
deterministic (documented tiebreaks) so tests are stable.

`methodology_version`/`methodology.version` is a single integer bumped only if
the derivation logic changes, letting consumers detect stale-shape rows.

## Refresh Flow & Error Handling

Fires in `run-ingestion.ts` after the profile-extraction path sets
`extraction_status = 'completed'`, co-located with the existing best-effort
kb-quality / retrieval-probe block. It recomputes the user's **entire** rollup
on every ingestion run (re-reads all their qualifying profiles), so it is
self-healing: a transiently-missing repo is corrected by the next run; parallel
same-user jobs resolve last-writer-wins, eventually consistent (acceptable —
the KB only changes on ingest).

Wrapped in `tracer.startActiveSpan('ingestion.profile_rollup', …)`. The catch
records the exception on the span and **swallows** it: a rollup failure MUST
NOT throw out of the job, fail `ingestChunks`, or flip sync state to error —
the exact best-effort contract used by the retrieval probe. If the repository
or pool is unavailable the step no-ops and ingestion still succeeds.

## Testing

- **Pure** `computeUserProfileRollup.test.ts` (twin of
  `computeKbQuality.test.ts`, zero I/O, table-driven): determinism for the same
  input; empty input → deterministic empty rollup; `null` primary_language →
  `"unknown"` bucket; `commitVolumeProxy` ranking + `sharePct` rounding;
  `domains.dominant` selection + tie rule; `complexity`/`roles` counts;
  `techStackTop` frequency + tiebreak; `activityArc` ascending order and
  `null` `last_active_at` exclusion; `activeYearsApprox` (0 when <2 dated);
  headline scope honours `project/!hidden/completed` while
  `classificationCounts` reflects **all** input; `methodology.version`
  present.
- **Repository** (fake `pg` Pool capturing query args): `set_config(
  'app.current_user_id', …)` issued before the read (RLS); the list query's
  WHERE filters on `classification='project'`, `is_hidden=false`,
  `extraction_status='completed'` and selects the projected fields; `upsert`
  parameter order + `JSON.stringify(rollup)` + `ON CONFLICT (user_id) DO
  UPDATE`.
- **Ingestion wiring** (extend the existing `run-ingestion`/pipeline test
  pattern): a throwing rollup step does **not** fail the job and does not
  prevent sync-state completion — verifies the best-effort boundary, mirroring
  the retrieval-probe wiring test.

## Existing UI Context (informs later SPs, not SP0)

The user-facing surface is **not greenfield**. A working onboarding flow already
exists in the `tucaken-app` repo under `src/features/onboarding/` (route
`src/app/onboarding.tsx`, `OnboardingShell.tsx`, `useOnboardingState.ts`,
step components under `components/steps/`). In particular
`src/features/onboarding/components/steps/ImportCareerStep.tsx` renders the
"Review extracted career history — Tucaken extracted the following from your
resume. You can edit individual entries later from your profile." review step.

The downstream feature SPs (Mirror / Reveal / Reconciliation / Distillation /
Direction / Diagnostic) will **refactor and extend these existing onboarding
components** to reflect the updated profile-intelligence experience — they do
not build a new frontend from scratch. SP0 still ships **no UI**; this note
exists so the later SP specs scope their work as a refactor of
`tucaken-app/src/features/onboarding/` rather than net-new pages.

## Out of Scope

- Any HTTP route or frontend (each feature SP owns its own read route/page,
  realised as a refactor of the existing onboarding components above).
- True per-language commit/LOC stats from the GitHub API (explicitly deferred;
  proxy + honest labelling chosen instead).
- The six user-facing features themselves (Mirror/Reveal/Reconciliation/
  Distillation/Direction/Diagnostic) — separate sub-projects that consume this
  rollup.
- Backfill of rollups for users whose repos were ingested before SP0 ships
  (acceptable: the next ingestion of any of their repos refreshes it; a
  one-off backfill can be its own tiny follow-up if needed).
