# Application Analytics — Phase 1 (funnel + feedback capture) — design

**Date:** 2026-06-05
**Status:** Design — approved (Phase 1 boundary)
**Repos:** ai-applications (migration) + tucaken-app (admin-api endpoints + dashboard/feedback UI)
**Scope:** Per-stage **outcome** tracking + **feedback capture** (user + verbatim company feedback) + a **basic analytics dashboard** that frames the user's funnel against 2026 market typical-ranges. **No insight cards, no cross-user aggregation, no flywheel** (Phases 2-3).

The load-bearing design decision: in a 2026 market where the funnel is structurally harsh (97% eliminated pre-human; median ~108 days to first offer), **raw rates demoralize**. The dashboard surfaces rates *with* typical-range context, time-since-start vs the ~108-day median, and what's user-actionable — never a success score, velocity pressure, cohort comparison, or gamification.

## 1. What exists / what's greenfield
Existing (migration 050): `job_applications.interview_stage` (current-stage pointer), `interview_stages` per-(app,stage) rows with `stage_status` (lifecycle: upcoming/…), `prep_status`, `user_state` JSONB, unique `(job_application_id, stage_type)`. App status enum: applied/interviewing/offer-received/accepted/withdrawn/rejected/failed.

Greenfield (this phase): per-stage **outcome**, **feedback capture**, **ghosting**, the **funnel dashboard**.

## 2. 2026 typical ranges (the framing config — research-grounded)
Stored as a versioned config module in admin-api (`as_of` date, recalibrate quarterly):
| Transition | typical | strong |
|---|---|---|
| applied → phone-screen | 12–20% | 18–25% |
| phone-screen → technical | 30–50% | 40–55% |
| technical/onsite → offer | 15–33% | — |
| offer → accept | 70–85% | — |
Search context: median time-to-first-offer ~108 days (Q1 2026; easing toward ~86 in Q2 2026); ~180–191 applicants/hire (tech). Sources captured in the config module's comments.

## 3. Data model — migration `067_application_analytics.sql`
```sql
BEGIN;
-- Per-stage outcome (distinct from lifecycle stage_status). NULL = not yet resolved.
ALTER TABLE interview_stages
  ADD COLUMN IF NOT EXISTS outcome    TEXT,            -- advanced|rejected|withdrew|not_completed|skipped (ghosted is DERIVED, see §5)
  ADD COLUMN IF NOT EXISTS outcome_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ; -- for ghost derivation; set on any stage write

-- Feedback captured at terminal stages. Owner-scoped (RLS). One row per (app, stage) — UPSERT.
CREATE TABLE IF NOT EXISTS application_stage_feedback (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_application_id        UUID NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  user_id                   TEXT NOT NULL,
  stage_type                TEXT NOT NULL,
  user_category             TEXT,        -- compensation|skills_mismatch|culture_fit|communication|technical_perf|process_timing|unclear|other
  user_note                 TEXT,
  company_feedback          TEXT,        -- verbatim from the company when provided
  company_feedback_verbatim BOOLEAN NOT NULL DEFAULT false,
  prep_self_rating          SMALLINT,    -- 1..5, how prepared the user felt (nullable)
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS asf_app_stage_uniq ON application_stage_feedback (job_application_id, stage_type);
CREATE INDEX IF NOT EXISTS asf_user_idx ON application_stage_feedback (user_id);
ALTER TABLE application_stage_feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY asf_owner ON application_stage_feedback
  USING (user_id = current_setting('app.current_user_id', true));
COMMIT;
```
`outcome` is a free TEXT with app-layer validation (matches existing enum-as-TEXT convention). `ghosted` is **not** stored — derived on read (§5).

## 4. admin-api endpoints (tucaken-app/admin-api)
All authenticated: `userId` from verified authorizer claims (`custom:user_id`/`user_id`/`sub`), fail-closed; RLS set inside the txn via `SELECT set_config('app.current_user_id', $1, true)` (NOT parameterized SET LOCAL).
- **`PATCH /applications/:id/stages/:stage/outcome`** — `{ outcome }`; validates enum; sets `outcome`+`outcome_at`+`last_activity_at`; owner-scoped.
- **`PUT /applications/:id/stages/:stage/feedback`** — `{ userCategory?, userNote?, companyFeedback?, companyFeedbackVerbatim?, prepSelfRating? }`; UPSERT into `application_stage_feedback`; owner-scoped. All fields optional (opt-in).
- **`GET /applications/analytics/funnel`** — computes, for the authed user, the funnel (counts per stage reached) + per-transition advancement rate + search summary (total applied, days since earliest applied, counts active/advanced/final/offer); attaches the typical-range config (§2). Computed on read (SQL aggregation over the user's `interview_stages` outcomes + `job_applications`). Efficient enough for on-load; no stored aggregate.

## 5. Ghosting (derived, no cron in Phase 1)
A stage is reported `ghosted` in the funnel/UI when: it is the application's current non-terminal stage, `outcome IS NULL`, and `now() - last_activity_at > GHOST_DAYS` (admin-api env, default 21). Derived in the analytics query + the detail read — **not** persisted in Phase 1 (avoids a reconciler/cron). A scheduled auto-mark can persist it later (Phase 2) if needed.

## 6. UI (tucaken-app)
**Feedback capture** — on the application detail, when a stage is terminal (`outcome ∈ {rejected, withdrew}` or derived `ghosted`), show a supportive, **opt-in** feedback card: category chips (one-click) + optional freeform + a separate "verbatim from the company" field + an optional prep self-rating. Skip is obvious and free. Copy acknowledges difficulty ("Sorry this one didn't work out. If you have a sense of what happened … no need to write anything if you'd rather move on."). Calls the feedback PUT.

**Dashboard** — a new route (e.g. `_dashboard.search-analytics`). Three sections:
1. **Search summary** (plain language): "You've applied to N roles over D days. X active, Y advanced past screening, Z reached final, W offers. Day D of the typical ~108-day 2026 search." 
2. **Funnel viz**: Applied → Phone screen → Technical → System Design → Behavioural → Bar Raiser → Final, each transition showing the user's rate **with its typical-range context** ("30% — above the typical 15–20%; your applications are getting attention" / "below typical — focus area"). Never a bare rate.
3. **Feedback prompts**: recently-terminal applications without feedback yet → one-click "add feedback". Opt-in.

NO success score, NO predictions, NO "apply to more" velocity nudges, NO cohort comparison, NO ghost-rate shaming, NO gamification.

## 7. Privacy / GDPR
Feedback + outcomes are personal/sensitive → owner-scoped RLS; `ON DELETE CASCADE` from `job_applications` (right-to-deletion works). No cross-user exposure anywhere in Phase 1 (no aggregation). Company feedback stored verbatim only in the user's own row.

## 8. Testing
- Migration applies idempotently; RLS policy blocks cross-user reads.
- admin-api: outcome PATCH validates enum + owner-scopes; feedback PUT upserts; funnel GET computes correct rates + derives ghosting + attaches ranges. Auth fail-closed when claim missing.
- UI: feedback card renders at terminal stages, skip works, submits; dashboard renders funnel with typical-range context (assert a rate never renders without context); search summary math.
- **Honest-framing test (the key one):** the funnel component must not render a transition rate without its typical-range qualifier.

## 9. Out of scope (Phases 2-3)
- Insight cards (pattern-based), time-window trends, feedback-theme aggregation (Phase 2 — needs the data accruing).
- Cross-user aggregate range recalibration, company intel, skill-gap recs, the prompt-iteration flywheel (Phase 3 — needs anonymized aggregate + privacy review).
- Persisted ghosting via cron, multi-offer comparison, reference management.

## 10. Implementation order (Phase 1 → writing-plans)
1. Migration `067` (outcome columns + `application_stage_feedback` + RLS) — applies to dev via the direct-apply pipeline.
2. admin-api: typical-range config module (§2) + outcome PATCH + feedback PUT (+ repository, owner-scoped, RLS) + tests.
3. admin-api: funnel GET (SQL aggregation + ghost derivation + attach ranges) + tests.
4. tucaken-app: feedback capture card (terminal-stage, opt-in) + types + test.
5. tucaken-app: dashboard route (search summary + funnel-with-context + feedback prompts) + the honest-framing test.
6. Dogfood: set outcomes + feedback on the Stripe app; confirm the funnel reads honestly (rates always contextualized, day-N-of-108 framing).

Longest pole: the dashboard's honest-framing component (step 5) — getting the typical-range qualifiers right and never showing a bare rate.
