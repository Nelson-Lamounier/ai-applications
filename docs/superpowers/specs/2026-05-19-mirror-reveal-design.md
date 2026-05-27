# SP2 — Mirror + Reveal — Design

**Date:** 2026-05-19
**Status:** Approved (design); pending implementation plan
**Parent initiative:** Profile Intelligence (6 features). **SP2 of SP0–SP5.**
SP0 (PR #11) + SP1 (PR #8) + retrieval-probe (PR #10) merged to default
branches. SP3–SP5 are separate later cycles.

**Repos:** ai-applications (LLM synthesis + persistence) **and** tucaken-app
(read + UI). No new infra; no separate job.

## Problem

SP0's `user_profile_rollup` holds rich per-user aggregates but nothing renders
them and nothing characterizes the user. SP2 adds **Mirror** (one grounded
2nd-person identity paragraph + a visual band) and **Reveal** (3–5 non-obvious,
evidence-grounded inferences), surfaced as the first post-processing "aha" in
onboarding and persistently on user-home.

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Synthesis locus | Ingestion-end best-effort 2nd Bedrock pass, persisted on `user_profile_rollup` (SP0/retrieval-probe twin) |
| LLM calls | **One** forced-tool call returning both Mirror paragraph + Reveal inferences |
| Grounding | Strict evidence-anchored; forbidden categories (commit-timing/personal-rhythm/anything-not-in-rollup); zod-enforced; ungrounded reveals dropped, never faked; hedge per `rollup.methodology` |
| Surface | New onboarding `mirror` step (after `processing`, before `distill`) + user-home; one shared `MirrorPanel`; Reveal expandable within it |
| Integration | Approach A — synthesis folded into `refreshUserProfileRollup`, single atomic upsert (migration 025) |
| Visual band | Pure rollup data, **no LLM** |

## Architecture & Boundaries

```
ai-applications
  platform-rds-bootstrap/migrations/025_user_profile_mirror_reveal.sql
      ALTER user_profile_rollup ADD mirror JSONB, reveal JSONB,
            synthesis_refreshed_at TIMESTAMPTZ  (all nullable; same RLS/table)
  ingestion/src/agents/MirrorRevealSynthesizer.ts   Bedrock forced-tool
  ingestion/src/util/refreshUserProfileRollup.ts    + best-effort synth sub-step,
      single upsert(rollup, mirror?, reveal?)
  ingestion/src/run-ingestion.ts                    construct + inject synthesizer
  shared/src/rds/implementations/RdsUserProfileRollupRepository.ts
      extended upsert + new getRollup(userId)
  shared/src/rds/interfaces/IUserProfileRollupRepository.ts  + getRollup
  shared/src/rds/bedrock-cost.ts  CostRecord.pipeline += 'profile-synthesis'

tucaken-app
  admin-api/src/routes/profile.ts (NEW)  GET /api/admin/profile/summary
  admin-api/src/index.ts  app.route('/api/admin/profile', …)
  src/lib/types/profile.types.ts  ProfileSummary
  src/server/profile.ts  getProfileSummaryFn
  src/features/profile/hooks/use-profile-summary.ts
  src/features/profile/components/MirrorPanel.tsx (shared)
  src/features/onboarding/.../{types,useOnboardingState}.ts + steps/MirrorStep.tsx
      + OnboardingShell.tsx wiring
  src/features/user-home/.../UserDashboard.tsx  mount MirrorPanel
```

The synthesizer is an **injected optional best-effort sub-step**. If no model
env is set or it fails, the upsert writes rollup only; `mirror`/`reveal` stay
NULL; the UI degrades gracefully (visual band still renders from the rollup;
paragraph + Reveal hidden). It MUST NOT fail ingestion (the retrieval-probe
contract, reusing the existing `ingestion.profile_rollup` span/swallow).

> All concrete anchors (latest migration = `024` on origin/develop → SP2 =
> `025`; the real post-PR#8 onboarding `STEPS`/`STEP_INDEX` which already
> contains `distill`; the `refreshUserProfileRollup`/run-ingestion call site)
> are re-derived from the merged default branches at plan time — NOT from any
> stale local ref.

## Migration 025 + Persistence

`025_user_profile_mirror_reveal.sql`, idempotent, lexically after `024`:

```sql
ALTER TABLE user_profile_rollup
    ADD COLUMN IF NOT EXISTS mirror                 JSONB,
    ADD COLUMN IF NOT EXISTS reveal                 JSONB,
    ADD COLUMN IF NOT EXISTS synthesis_refreshed_at TIMESTAMPTZ;
```

All nullable; same table/PK/RLS policy as `024` (no policy change). Bootstrap
re-runs every `.sql` each deploy → `IF NOT EXISTS` keeps it safe.

`RdsUserProfileRollupRepository`:
- `upsert(userId, result, mirror?, reveal?)` — extends the existing
  `ON CONFLICT (user_id) DO UPDATE` to also set `mirror`, `reveal`,
  `synthesis_refreshed_at`. When `mirror`/`reveal` are `undefined` the upsert
  passes `NULL`/leaves them — **but** rollup-only refreshes must NOT clobber a
  previously-good synthesis: when the synthesizer is absent/failed, pass the
  existing columns through (use `COALESCE(EXCLUDED.mirror, user_profile_rollup
  .mirror)` style, and only set `synthesis_refreshed_at = now()` when a fresh
  synthesis is supplied). This preserves the last good Mirror/Reveal across a
  transient synthesis failure while the rollup still refreshes.
- `getRollup(userId): Promise<{ rollup, mirror, reveal, refreshedAt,
  synthesisRefreshedAt } | null>` — new RLS-scoped read
  (`set_config` idiom consistent with the repository's other methods).

## MirrorRevealSynthesizer (ai-applications)

`applications/ingestion/src/agents/MirrorRevealSynthesizer.ts` — twin of
`ProfileExtractor`/`RetrievalProbe`:

- `BedrockRuntimeClient`; one `InvokeModelCommand`; forced
  `tool_choice: { type:'tool', name:'synthesize_profile' }`; single tool.
- Input message = the `UserProfileRollup` (languages, domains, complexity,
  roles, techStackTop, activityArc, totals, classificationCounts, **and
  `methodology`**), serialized compactly.
- zod output schema (`.strict()`):
  ```
  {
    mirror:  { paragraph: string().min(120).max(900) },
    reveals: array({ insight: string().min(20).max(280),
                     evidence: string().min(8).max(160) }).min(1).max(5)
  }
  ```
- System prompt (ProfileExtractor-rule style): second person; characterize,
  don't list stats; **do NOT invent** metrics/scale/outcomes; ground every
  claim in provided rollup fields; **forbidden categories** — commit timing,
  personal rhythm/working hours, anything not present in the rollup ("creepy"
  or ungrounded); hedge in line with `rollup.methodology` (commit-volume is a
  language-share proxy, domain mix is repo-count share). Each `reveal.evidence`
  must name the concrete rollup dimension it derives from.
- Post-validation deterministic filter: drop any reveal whose `evidence` does
  not reference a known rollup dimension keyword (languages, domain(s), role,
  complexity, tech stack, activity/arc, years, repo count). Dropped, never
  fabricated. If all dropped → `reveals: []` (Mirror paragraph still kept).
- `recordBedrockCost(pool, { userId, modelId, pipeline:'profile-synthesis',
  inputTokens, outputTokens })` — add `'profile-synthesis'` to the
  `CostRecord.pipeline` union in `shared/src/rds/bedrock-cost.ts`.
- Model id: `process.env.MIRROR_REVEAL_MODEL_ID ?? process.env
  .PROFILE_EXTRACTOR_MODEL_ID` (env.ts default fallback already exists for the
  latter). `static fromEnvironment(pool, userId)` returns `undefined` when no
  model id resolvable (→ synthesis skipped). `synthesize(rollup)` MUST NOT
  throw — returns `{ mirror, reveal } | undefined`.

## Refresh-wrapper Integration (Approach A)

`refreshUserProfileRollup(repo, userId, synthesizer?)`:
1. `rows = repo.listProfilesForRollup(userId)` (unchanged)
2. `result = computeUserProfileRollup(rows)` (unchanged)
3. if `synthesizer`: `synth = await synthesizer.synthesize(result.rollup)`
   inside the existing `ingestion.profile_rollup` span, wrapped in its own
   try/catch that records + swallows (synth → `undefined` on any failure).
4. `await repo.upsert(userId, result, synth?.mirror, synth?.reveal)` — single
   atomic write; `synthesis_refreshed_at = now()` only when `synth` present;
   otherwise prior mirror/reveal preserved (COALESCE, see Persistence).
5. Whole thing remains best-effort: any throw is swallowed; ingestion never
   fails (retrieval-probe contract).

`run-ingestion.ts`: construct `MirrorRevealSynthesizer.fromEnvironment(pgPool,
env.userId)` next to the existing rollup wiring and pass it into
`refreshUserProfileRollup(...)`. Absent model env → `undefined` → today's
rollup-only behavior preserved exactly.

## Serving + Frontend (tucaken-app)

- **admin-api** `src/routes/profile.ts` (new): `GET /api/admin/profile/summary`
  → `requireUserId` (401 if missing) → `SELECT rollup, mirror, reveal,
  refreshed_at, synthesis_refreshed_at FROM user_profile_rollup WHERE
  user_id = $1::uuid` → 404 `{error:'No profile yet'}` if no row → 200
  `{ rollup, mirror, reveal, refreshedAt, synthesisRefreshedAt }`. RLS +
  `requireUserId` + pool exactly like `github.ts`. Mounted
  `app.route('/api/admin/profile', createProfileRouter(config))`.
- **frontend**: `ProfileSummary` type; `getProfileSummaryFn`
  (`createServerFn`+`apiFetch`, GET, with `pathTemplate`); `useProfileSummary`
  query hook (`adminKeys.profile.summary()`). Shared **`MirrorPanel`**:
  identity `mirror.paragraph`; **visual band purely from `rollup`** — top-5
  `languages` by `sharePct`, `domains.dominant` + counts, `totals
  .activeYearsApprox`, an `activityArc` sparkline (primaryLanguage/domain over
  `lastActiveAt`); **Reveal** = expandable list of `{insight, evidence}`.
  Degraded states: rollup present but `mirror` null → band only; no row →
  "profile still building". Mounted in a new onboarding `mirror` step and on
  user-home (one shared component, two mounts — SP1 pattern).
- **onboarding**: insert `mirror` into `STEPS`/`StepId` **after `processing`,
  before `distill`** and into `STEP_INDEX` (read the real merged post-#8 state;
  `distill`/`review` already exist — shift their indices by 1); `MirrorStep`
  wraps `MirrorPanel` via `useProfileSummary`, `StepFooter` Back/Continue
  (Next always enabled). Dispatch in `OnboardingShell` + add `'mirror'` to the
  terminal/`isTerminal` set consistent with `processing`/`distill`/`review`;
  audit the `z.coerce.number().max(N)` search clamp (bump by 1) and confirm
  `CONNECT_STEP_INDEX` (still index 3) unaffected. User-home: `MirrorPanel`
  above `RepoProfileCards` in `UserDashboard`.

## Testing

- **ai-applications**: `MirrorRevealSynthesizer` with a fake Bedrock client —
  forced-tool body shape, zod-reject → `undefined`, evidence-grounding filter
  drops ungrounded reveals (keeps grounded), never-throws on any failure.
  `refreshUserProfileRollup` extended: synthesizer present → single `upsert`
  carries mirror/reveal + `synthesis_refreshed_at`; absent/throwing →
  rollup-only, prior synthesis preserved (COALESCE), ingestion never fails.
  Repository fake-pool: extended `upsert` params + `getRollup` SQL/RLS.
  `bedrock-cost` union includes `'profile-synthesis'`.
- **tucaken-app**: admin-api `profile.test.ts` (200 shape, 401, 404-no-row,
  user_id scoping). vitest: `getProfileSummaryFn` (URL/method/pathTemplate),
  a pure visual-band selector (top-5 languages + arc mapping), and
  `useOnboardingState` updated for the new 9-step list. `MirrorPanel`/
  `MirrorStep` thin-presentational — covered transitively (no heavy
  component-test harness; SP1 precedent).

## Out of Scope

- Regenerating Mirror/Reveal on demand or via a separate job (locked:
  ingestion-end best-effort).
- Any change to SP0's `computeUserProfileRollup` math or the rollup schema
  (only additive columns on the table).
- The other features (Direction/Reconciliation/Diagnostic) — separate SPs that
  also read this row.
- Backfill: users ingested before SP2 get mirror/reveal on their next repo
  ingest; `getRollup` returns `mirror:null` until then (band-only render).
- Real-time push/websockets — the existing onboarding poll + query
  invalidation suffice.
