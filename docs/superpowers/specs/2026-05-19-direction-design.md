# SP3 — Direction — Design

**Date:** 2026-05-19
**Status:** Approved (design); pending implementation plan
**Parent initiative:** Profile Intelligence (6 features). **SP3 of SP0–SP5.**
SP0 (PR #11), SP1 (PR #8), SP2 Phase A (PR #12) + Phase B (PR #9), retrieval
probe (PR #10) all merged. SP4/SP5 are separate later cycles.

**Repos:** ai-applications (synthesis + persistence) **and** tucaken-app
(serving + UI). Two phases, two PRs — the SP2 structural twin.

## Problem

SP0's `user_profile_rollup` + SP2's Mirror/Reveal characterise *who* the user
is. Nothing tells them *where they fit* — role archetypes, seniority
calibration, and what to deepen — before any JD. SP3 adds **Direction**:
positioning intelligence synthesized from the rollup, surfaced as an onboarding
step (after Mirror, before Distill) and on user-home.

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Data source | **SP0 rollup only** (self-contained; resume↔reality is SP4's job) |
| Synthesis | **Separate `DirectionSynthesizer`** + own `direction` JSONB column (migration 026); independent best-effort, SP2-twin. SP3 does not touch SP2's merged agent. |
| Output shape | Curated **archetype enum** LLM-scored to fit tiers + per-area **seniority** + **whatToDeepen**; strict zod-enforced grounding (Reveal-class) |
| Market/geo | **Excluded entirely** (future "market match" SP; no postings data) |
| Surface | New onboarding `direction` step **after `mirror`, before `distill`** + user-home; extend `/profile/summary` + `ProfileSummary` + shared `DirectionPanel` |
| Integration | Approach A — 2nd independent best-effort synthesizer in `refreshUserProfileRollup`, single atomic upsert |

## Architecture & Boundaries

```
Phase A — ai-applications (branch off develop; latest migration on develop is
          025_user_profile_mirror_reveal → SP3 = 026; re-derive at plan time)
  platform-rds-bootstrap/migrations/026_user_profile_direction.sql
      ALTER user_profile_rollup ADD direction JSONB  (nullable; same RLS/table)
  shared/src/rds/bedrock-cost.ts   CostRecord.pipeline += 'profile-direction'
  ingestion/src/agents/DirectionSynthesizer.ts   Bedrock forced-tool (MirrorReveal twin)
  ingestion/src/agents/__tests__/DirectionSynthesizer.test.ts
  shared/src/rds/interfaces/IUserProfileRollupRepository.ts
      upsert(...,mirror?,reveal?,direction?) ; getRollup → +direction ; +DirectionJson type
  shared/src/rds/implementations/RdsUserProfileRollupRepository.ts (+test)
  shared barrels (rds/index, rds/interfaces/index, src/index) — export DirectionJson
  ingestion/src/util/refreshUserProfileRollup.ts (+test)
      refreshUserProfileRollup(repo,userId,synthesizer?,directionSynthesizer?)
  ingestion/src/run-ingestion.ts   construct DirectionSynthesizer.fromEnvironment + inject

Phase B — tucaken-app (branch off main; profile route / MirrorPanel /
          onboarding `mirror` step all present from SP2 PR #9)
  admin-api/src/routes/profile.ts (+ direction in SELECT + response map) (+test)
  src/lib/types/profile.types.ts   ProfileSummary += direction (+ item types)
  src/features/profile/components/DirectionPanel.tsx (shared)
  src/features/onboarding/.../{types,useOnboardingState}.ts + steps/DirectionStep.tsx
       + OnboardingShell.tsx wiring + src/app/onboarding.tsx clamp
  src/__tests__/features/onboarding/useOnboardingState.test.ts (updated)
  src/features/user-home/components/UserDashboard.tsx (mount DirectionPanel)
  src/server/_dev-mock.ts  /profile/summary fixture += direction block
```

Each synthesizer is **independently best-effort**: absent model env / failure
/ all-ungrounded → that column stays NULL; never affects the other synthesizer
or ingestion (retrieval-probe contract). `COALESCE`-preserve keeps a prior good
`direction` across a transient miss. **SP3 modifies none of SP2's merged
`MirrorRevealSynthesizer`** — it only adds a sibling synthesizer and threads a
new optional param/column through the shared repo + refresh wrapper. All
concrete anchors (migration number, the real post-SP2 onboarding
`STEPS`/`STEP_INDEX`, the `refreshUserProfileRollup` signature now having a
`synthesizer?` 3rd param from SP2, the `/profile/summary` route + `ProfileSummary`
shape) are **re-derived from the merged default branches at plan time**, not
assumed.

## Migration 026

`026_user_profile_direction.sql`, idempotent, lexically after `025`:

```sql
ALTER TABLE user_profile_rollup
    ADD COLUMN IF NOT EXISTS direction JSONB;
```

Nullable; same table / PK / RLS policy as 024/025 (no policy change).
Bootstrap re-runs every `.sql` each deploy → `IF NOT EXISTS` keeps it safe.
**Number is re-confirmed at plan/exec time** from the then-current
`origin/develop` (SP2's 025 is merged → 026; if a higher migration lands first,
shift accordingly to avoid a number collision).

## DirectionSynthesizer (ai-applications)

`applications/ingestion/src/agents/DirectionSynthesizer.ts` — exact twin of the
merged `MirrorRevealSynthesizer` (read it for the canonical idiom):
BedrockRuntimeClient, one `InvokeModelCommand`, forced single tool
`synthesize_direction`, zod `.strict()` validation, `recordBedrockCost`, OTel
span `ingestion.profile_direction`, `fromEnvironment`, `synthesize()` MUST NOT
throw (returns `DirectionOutput | undefined`).

**zod output schema:**

```
{
  archetypes: array({
    archetype: enum('platform','devops','sre','infrastructure','cloud',
                    'backend','fullstack','data','ml'),
    fit:       enum('strong','moderate','weak'),
    rationale: string().min(8).max(200),
  }).min(3).max(9),
  seniority: array({
    area:     string().min(2).max(40),
    level:    enum('junior','mid','mid-senior','senior','staff+'),
    evidence: string().min(8).max(160),
  }).min(1).max(4),
  whatToDeepen: array(string().min(12).max(200)).max(5),   // may be []
}.strict()   // each nested object .strict()
```

**Input:** the `UserProfileRollup` (languages/domains/complexity/roles/
techStackTop/activityArc/totals + **`methodology`**), serialized compactly.

**System prompt (Reveal-class):** assign each archetype a fit tier grounded
ONLY in concrete rollup dimensions; **do NOT invent** scale/outcomes/employers;
hedge per `rollup.methodology` (commit-volume is a primary-language
commit-count proxy; domain mix is repo-count share; **repos alone are not
definitive seniority** — calibrate conservatively and say so); **FORBIDDEN**:
market/geographic/job-posting claims (no data), commit-timing/personal-rhythm,
anything not derivable from the rollup; every `rationale`/`evidence` must name
the rollup dimension it derives from; untrusted-content clause.

**Post-validation deterministic grounding filter:** drop any `archetypes[]` or
`seniority[]` entry whose `rationale`/`evidence` (lowercased) references no
known rollup-dimension keyword (`language(s)`, `domain(s)`, `role(s)`,
`complexity`, `tech`/`stack`, `activity`/`arc`, `year(s)`, `repo(s)`, `commit`,
`project`). If **all `archetypes` drop** → degraded → `synthesize()` returns
`undefined` (so `COALESCE`-preserve keeps any prior good `direction`, exactly
the SP2-Phase-A bug-fix invariant). `whatToDeepen` retained only when ≥1
archetype survives. Dropped, never fabricated.

`recordBedrockCost(pool,{ userId, modelId, pipeline:'profile-direction',
inputTokens, outputTokens })` — add `'profile-direction'` to the
`CostRecord.pipeline` union. Model id:
`process.env.DIRECTION_MODEL_ID ?? process.env.PROFILE_EXTRACTOR_MODEL_ID`;
`fromEnvironment` → `undefined` when unresolved.

`DirectionOutput = { direction: { archetypes:[...], seniority:[...],
whatToDeepen:[...] } }` (the persisted `direction` JSONB shape).

## Repository + Refresh Integration

`upsert(userId, result, mirror?, reveal?, direction?)`:
- Append `direction` to the INSERT column list + a `$N::jsonb` placeholder
  (renumber sequentially — verify column==placeholder==param counts, same
  rigor as SP2-A4).
- Param: `direction == null ? null : JSON.stringify(direction)`.
- `ON CONFLICT (user_id) DO UPDATE SET … direction = COALESCE(EXCLUDED
  .direction, user_profile_rollup.direction)` (preserve prior on rollup-only /
  degraded refresh).
- `synthesis_refreshed_at`: the existing SP2 rule (set to `now()` only when a
  synthesis is supplied) is extended so `direction` ALSO counts — i.e. stamp
  when *any* of mirror/reveal/direction is supplied; the COALESCE on
  `synthesis_refreshed_at` already preserves the prior value otherwise.

`getRollup` / `RollupRow` gain `direction: DirectionJson | null`. New types
(`DirectionJson`, `ArchetypeFit`, `SeniorityCall`) exported through the same
shared barrels SP2 used.

`refreshUserProfileRollup(repo, userId, synthesizer?, directionSynthesizer?)`:
keep the existing list+compute+mirror/reveal sub-step **byte-unchanged**; add a
**separate independent** try/catch best-effort block:
`if (directionSynthesizer) { try { dir = await directionSynthesizer
.synthesize(result.rollup); } catch { dir = undefined; } }`; the single
`repo.upsert(userId, result, mSynth?.mirror, mSynth?.reveal, dir?.direction)`
carries all three. Both sub-steps + the outer catch swallow → ingestion never
fails; a Direction failure cannot affect Mirror/Reveal or vice-versa.
`run-ingestion.ts` constructs `DirectionSynthesizer.fromEnvironment(pgPool,
env.userId)` next to the existing `MirrorRevealSynthesizer.fromEnvironment` and
passes it as the new 4th arg.

## Serving + UI (tucaken-app)

- **admin-api** `GET /api/admin/profile/summary`: add `direction` to the
  `SELECT` and the response map (`direction: r.direction ?? null`). Extend
  `profile.test.ts` (direction present; null mapping). RLS/`requireUserId`
  unchanged.
- **frontend**: `ProfileSummary` += `direction: DirectionJson | null`;
  `DirectionJson`/`ArchetypeFit`/`SeniorityCall` types. Shared
  **`DirectionPanel`** (presentational, no fetch/effects): archetype chips
  colour-tiered by `fit` (strong/moderate/weak) with `rationale` as
  title/expand; a seniority list (`area — level`, `evidence`); a "what to
  deepen" bullet list; degraded — `direction` null → "Your direction is still
  being generated"; whole `summary` absent handled by the existing
  guard. New onboarding `direction` step (`DirectionStep`, `DistillStep`/
  `MirrorStep` idiom, `useProfileSummary` → `DirectionPanel`) inserted **after
  `mirror`, before `distill`** → indices: `mirror=6, direction=7, distill=8,
  review=9`; update `StepId`/`STEPS`/`STEP_INDEX` (consistent with
  `ID_BY_INDEX` derivation), `OnboardingShell` dispatch + add `'direction'` to
  `isTerminal` (alongside mirror/distill/review), bump the
  `z.coerce.number()…max(N)` clamp by 1 (→ max 9), confirm `CONNECT_STEP_INDEX`
  still 3, fix the stale step-list comment, update
  `useOnboardingState.test.ts` (strengthen to the new 10-step truth, not
  weaken). Mount `DirectionPanel` on user-home near `MirrorPanel`. Extend the
  `_dev-mock.ts` `/profile/summary` fixture with a realistic `direction` block.

## Testing

- **ai-applications**: `DirectionSynthesizer` fake-Bedrock (valid grounded →
  archetypes/seniority/whatToDeepen; ungrounded archetype dropped, grounded
  kept; ALL archetypes ungrounded → `undefined`; schema-invalid → `undefined`;
  invoker-throw → `undefined`/never-throws). Repo fake-pool (extended `upsert`
  column/placeholder/param count + `direction` COALESCE-preserve; `getRollup`
  returns `direction`). `refreshUserProfileRollup` (directionSynth present →
  upsert carries direction; absent/throw → unaffected; mirror/reveal path
  independent & unchanged; ingestion never fails). `bedrock-cost` union
  includes `'profile-direction'`.
- **tucaken-app**: `profile.test.ts` (`direction` in response + null mapping);
  `useOnboardingState.test.ts` updated for the 10-step list (direction=7,
  distill=8, review=9). `DirectionPanel`/`DirectionStep` thin-presentational —
  covered transitively (SP1/SP2 precedent; no heavy component-test harness).

## Out of Scope

- Market / geographic / job-posting fit (future "market match" SP — its own
  data dependency).
- Resume cross-source / resume↔GitHub (SP4 Reconciliation).
- Any change to SP0 `computeUserProfileRollup` math or SP2's merged
  `MirrorRevealSynthesizer` / its schema / its tests.
- SP5 Diagnostic consuming `direction` (separate SP; SP5 will read it then).
- Backfill: users ingested pre-SP3 get `direction` on their next repo ingest;
  `getRollup`/the route return `direction:null` until then (panel degrades).
- On-demand/JD-aware positioning (SP3 is JD-free, ingestion-time only).
