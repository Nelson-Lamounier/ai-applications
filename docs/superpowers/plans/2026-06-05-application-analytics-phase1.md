# Application Analytics Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-stage outcome tracking + opt-in feedback capture + a 2026-typical-range-framed funnel dashboard, so users see what's user-actionable in their job search instead of demoralizing raw rates.

**Architecture:** Extend the existing `interview_stages` table (migration 050) with outcome columns + a new owner-scoped `application_stage_feedback` table; add admin-api endpoints (outcome PATCH, feedback PUT, funnel GET that computes rates + derives ghosting + attaches a static 2026 typical-range config); add tucaken-app UI (opt-in feedback card at terminal stages + a dashboard route whose funnel never shows a bare rate).

**Tech Stack:** ai-applications platform-rds-bootstrap (SQL migrations), tucaken-app admin-api (TS, pg, Cognito-claim auth, RLS via set_config) + frontend (TanStack Start, React/TS, Vitest). Branch `feat/application-analytics-phase1-spec` (ai-applications, migration) already created off develop; a tucaken-app branch off main for admin-api + UI.

**Spec:** `docs/superpowers/specs/2026-06-05-application-analytics-phase1-design.md`

**Reference (copy patterns):** admin-api — `src/lib/repositories/interview-stages.ts` (RLS `set_config`, stage upsert), `src/lib/repositories/applications.ts`, a `src/routes/*.ts` handler (auth-claim → userId, fail-closed). Frontend — `src/app/_dashboard.overview.tsx` / `_dashboard.reports.tsx` (dashboard route + data load), `src/features/applications/stages/workspaces/*` (Card/SummaryGroup).

---

## File Structure
- Create `applications/platform-rds-bootstrap/migrations/067_application_analytics.sql` (ai-applications).
- Create `admin-api/src/lib/market-funnel-ranges.ts` — the 2026 typical-range config.
- Modify `admin-api/src/lib/repositories/interview-stages.ts` — `setStageOutcome`.
- Create `admin-api/src/lib/repositories/stage-feedback.ts` — feedback upsert/read (RLS).
- Create `admin-api/src/lib/repositories/funnel-analytics.ts` — funnel computation + ghost derivation.
- Modify/create `admin-api/src/routes/applications.ts` (or a new `analytics.ts`) — the 3 endpoints.
- Create `src/features/applications/stages/components/StageFeedbackCard.tsx` (tucaken-app).
- Create `src/app/_dashboard.search-analytics.tsx` + `src/features/search-analytics/FunnelView.tsx` + `SearchSummary.tsx`.
- Modify `src/lib/types/applications.types.ts` — outcome/feedback/funnel types.

---

## Task 1: Migration 067 (outcome columns + feedback table + RLS)
**Files:** Create `applications/platform-rds-bootstrap/migrations/067_application_analytics.sql` (ai-applications, branch `feat/application-analytics-phase1-spec`)

- [ ] **Step 1: write the migration** (mirror 050's idempotent ALTER pattern + the RLS pattern from an existing owner-scoped table):
```sql
-- 067_application_analytics.sql — per-stage outcome + feedback capture. Idempotent.
BEGIN;
ALTER TABLE interview_stages
  ADD COLUMN IF NOT EXISTS outcome          TEXT,
  ADD COLUMN IF NOT EXISTS outcome_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS application_stage_feedback (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_application_id        UUID NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  user_id                   TEXT NOT NULL,
  stage_type                TEXT NOT NULL,
  user_category             TEXT,
  user_note                 TEXT,
  company_feedback          TEXT,
  company_feedback_verbatim BOOLEAN NOT NULL DEFAULT false,
  prep_self_rating          SMALLINT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS asf_app_stage_uniq ON application_stage_feedback (job_application_id, stage_type);
CREATE INDEX IF NOT EXISTS asf_user_idx ON application_stage_feedback (user_id);
ALTER TABLE application_stage_feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS asf_owner ON application_stage_feedback;
CREATE POLICY asf_owner ON application_stage_feedback
  USING (user_id = current_setting('app.current_user_id', true));
COMMIT;
```
Confirm 067 is the next free number and `gen_random_uuid()`/RLS match how an existing owner-scoped table (e.g. the one interview-stages reads) is declared.

- [ ] **Step 2: commit.** `git add applications/platform-rds-bootstrap/migrations/067_application_analytics.sql && git commit -m "feat(analytics): migration 067 — stage outcome + feedback capture"` (no Co-Authored-By). PR this branch to develop separately (applies to dev via direct-apply).

---

## Task 2: 2026 typical-range config (admin-api)
**Files:** Create `admin-api/src/lib/market-funnel-ranges.ts`; Test `admin-api/src/lib/market-funnel-ranges.test.ts` (tucaken-app, new branch `feat/application-analytics` off main)

- [ ] **Step 1: failing test** — `classifyRate(transition, rate)` returns `{ band: 'above'|'typical'|'below', context: string }`:
```ts
import { classifyRate, FUNNEL_RANGES } from './market-funnel-ranges.js'
it('classifies applied→phone-screen', () => {
  expect(classifyRate('applied_to_phone_screen', 0.30).band).toBe('above')
  expect(classifyRate('applied_to_phone_screen', 0.15).band).toBe('typical')
  expect(classifyRate('applied_to_phone_screen', 0.05).band).toBe('below')
})
it('exposes as_of + median days', () => {
  expect(FUNNEL_RANGES.asOf).toBe('2026-Q2'); expect(FUNNEL_RANGES.medianDaysToOffer).toBe(108)
})
```

- [ ] **Step 2: implement** — `FUNNEL_RANGES` with the §2 ranges (applied→phone-screen 0.12–0.20; phone-screen→technical 0.30–0.50; technical→offer 0.15–0.33; offer→accept 0.70–0.85), `asOf:'2026-Q2'`, `medianDaysToOffer:108`, source comments. `classifyRate` → band + a short honest context string per band/transition ("above the typical 15–20% — your applications are getting attention" etc.). No `any`.

- [ ] **Step 3: run test → pass. Commit.** `feat(analytics): 2026 funnel typical-range config`

---

## Task 3: setStageOutcome endpoint
**Files:** Modify `admin-api/src/lib/repositories/interview-stages.ts`, a route file (`src/routes/applications.ts` or new `analytics.ts`); Test alongside

- [ ] **Step 1: failing repo test** — `setStageOutcome(pool, userId, appId, stage, outcome)` validates `outcome ∈ {advanced,rejected,withdrew,not_completed,skipped}`, sets `outcome`+`outcome_at`+`last_activity_at=now()` on the `(appId,stage)` row, owner-scoped via the RLS `set_config` txn already used in this repo. Throws on invalid outcome.

- [ ] **Step 2: implement** mirroring the existing upsert + `SELECT set_config('app.current_user_id', $1, true)` txn pattern in `interview-stages.ts`. Add `const STAGE_OUTCOMES = ['advanced','rejected','withdrew','not_completed','skipped'] as const`.

- [ ] **Step 3: route** `PATCH /applications/:id/stages/:stage/outcome` — derive `userId` from verified claims (`custom:user_id`/`user_id`/`sub`), **fail-closed** if absent; call the repo; 400 on invalid outcome, 200 on success. Mirror an existing authed route's claim extraction.

- [ ] **Step 4: tests pass → commit.** `feat(analytics): set per-stage outcome endpoint`

---

## Task 4: feedback upsert endpoint
**Files:** Create `admin-api/src/lib/repositories/stage-feedback.ts` + route; Tests

- [ ] **Step 1: failing repo test** — `upsertStageFeedback(pool, userId, appId, stage, fields)` UPSERTs into `application_stage_feedback` on `(job_application_id, stage_type)`, sets `user_id`, `updated_at=now()`; all content fields optional; owner-scoped (RLS set_config). `getStageFeedback` reads it back.

- [ ] **Step 2: implement** the repo (RLS txn pattern). Validate `user_category ∈` the §3 set when present; `prep_self_rating` 1..5 when present.

- [ ] **Step 3: route** `PUT /applications/:id/stages/:stage/feedback` — claim→userId fail-closed; body `{userCategory?,userNote?,companyFeedback?,companyFeedbackVerbatim?,prepSelfRating?}`; upsert; 200.

- [ ] **Step 4: tests pass → commit.** `feat(analytics): stage feedback capture endpoint`

---

## Task 5: funnel analytics endpoint (compute + ghost-derive + attach ranges)
**Files:** Create `admin-api/src/lib/repositories/funnel-analytics.ts` + route `GET /applications/analytics/funnel`; Tests

- [ ] **Step 1: failing test** — `computeFunnel(pool, userId, ghostDays)` returns `{ summary, transitions[] }`:
  - `summary`: `{ totalApplied, daysSinceFirstApplied, active, advancedPastScreen, reachedFinal, offers }`.
  - `transitions[]`: per stage-pair `{ key, fromCount, toCount, rate }`.
  - **ghost derivation:** a current non-terminal stage with `outcome IS NULL` and `now()-last_activity_at > ghostDays` counts as `ghosted` (terminal), not active.
  Seed two apps at different stages + assert counts/rates + a ghosted one.

- [ ] **Step 2: implement** the SQL aggregation over the user's `job_applications` + `interview_stages` (owner-scoped via set_config). Stage order: applied, phone-screen, technical, system-design, behavioural, bar-raiser, final.

- [ ] **Step 3: route** `GET /applications/analytics/funnel` — claim→userId fail-closed; `computeFunnel`; attach `FUNNEL_RANGES` + `classifyRate` band+context per transition; return `{ summary, transitions: [{...,band,context}], ranges }`.

- [ ] **Step 4: tests pass → commit.** `feat(analytics): funnel computation endpoint with 2026 framing`

---

## Task 6: feedback capture UI (opt-in, terminal stages)
**Files:** Create `src/features/applications/stages/components/StageFeedbackCard.tsx`; Modify `src/lib/types/applications.types.ts`; Test in `stage-components.test.tsx`

- [ ] **Step 1: types** — `StageOutcome`, `StageFeedback` (the §3 fields) on the application detail types.

- [ ] **Step 2: component** — renders only when a stage is terminal (`outcome ∈ {rejected,withdrew}` or derived `ghosted`). Supportive copy ("Sorry this one didn't work out … no need to write anything if you'd rather move on."). Category chips (one-click), optional freeform, separate "verbatim from the company" field, optional prep rating (1–5). A clear Skip. Submit calls the feedback PUT (via the app's existing admin-api client). Factor sub-components for complexity ≤10.

- [ ] **Step 3: test** — renders at terminal stage; skip present; submitting fires the PUT with the chosen fields. Mirror an existing workspace component test.

- [ ] **Step 4: commit.** `feat(analytics): opt-in stage feedback capture card`

---

## Task 7: dashboard route (search summary + funnel-with-context + prompts)
**Files:** Create `src/app/_dashboard.search-analytics.tsx`, `src/features/search-analytics/FunnelView.tsx`, `SearchSummary.tsx`; Test `src/__tests__/features/search-analytics/funnel-view.test.tsx`

- [ ] **Step 1: failing honest-framing test (THE key test)** — render `FunnelView` with a transitions payload; assert each rendered transition shows its `context` string (the typical-range qualifier) and that **no rate renders without context** (query the DOM: every element showing a `%` has an accompanying context node). Also assert no element with text matching `/score|rank|compared to other/i`.

- [ ] **Step 2: `SearchSummary`** — plain-language panel from `summary` + `ranges.medianDaysToOffer` ("Day D of the typical ~108-day 2026 search").

- [ ] **Step 3: `FunnelView`** — the stage funnel; each transition shows `rate` + `band` color + `context`. Never a bare rate. Reuse Card/SummaryGroup.

- [ ] **Step 4: route `_dashboard.search-analytics.tsx`** — loads `GET /applications/analytics/funnel`, renders `SearchSummary` + `FunnelView` + a feedback-prompts list (recently-terminal apps w/o feedback → link to add). NO score/velocity/cohort/gamification.

- [ ] **Step 5: tests pass; `yarn typecheck` + eslint clean → commit + PR (base main).** `feat(analytics): search-analytics dashboard (2026-framed funnel)`

---

## Task 8: Dogfood
- [ ] **Step 1:** merge the migration PR (067 applies to dev) + the tucaken-app PR.
- [ ] **Step 2:** set outcomes (advanced/rejected) + add feedback on a few of the owner's apps (incl. the Stripe one); open the dashboard.
- [ ] **Step 3: quality gate** — every funnel rate shows its typical-range context; search summary frames day-N against ~108; feedback card felt supportive + skippable. No demoralizing bare metric anywhere.

---

## Self-review notes
- Spec coverage: data model §3→T1; ranges §2→T2; outcome §4→T3; feedback §4/§6→T4/T6; funnel+ghost §4/§5→T5; UI §6→T6/T7; dogfood §10→T8. All covered.
- Security (CLAUDE.md): every endpoint derives userId from claims fail-closed; RLS via `set_config('app.current_user_id',$1,true)` inside the txn (NOT parameterized SET LOCAL); feedback table cascade-deletes (GDPR). Stated in T3/T4/T5.
- Honest-framing is enforced by a TEST (T7 step 1), not just convention — the highest-value guardrail.
- Anti-patterns (no score/velocity/cohort/gamification) asserted in T7 step 1 + T7 step 4.
- Ghosting is derived (T5), not a cron — matches spec §5.
- Type names consistent: `STAGE_OUTCOMES`, `StageOutcome`, `StageFeedback`, `upsertStageFeedback`, `computeFunnel`, `classifyRate`, `FUNNEL_RANGES`, `FunnelView`, `SearchSummary`.
- Cross-repo: T1 ships in ai-applications (migration PR → develop); T2-T7 in tucaken-app (PR → main). T5's funnel endpoint must be deployed before T7's dashboard reads it.
