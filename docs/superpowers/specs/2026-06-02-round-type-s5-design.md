# Round-Type Extension + Coach Awareness — S5: Design

> **Date:** 2026-06-02
> **Status:** Approved design. Plan next.
> **Goal:** Add the DevOps/AI interview-round shapes (`troubleshooting`, `architecture-review`, `hands-on-lab`) to `round_type` end-to-end, make the Coach prep round-appropriate, and seed them on the few companies where the format is documented.
> **Repos:** `ai-applications` (enum + coach + migration) + `tucaken-app` (admin-api + UI types). **Migration 061.**
> **Fifth sub-project** (S5). Builds on S1 (round_type concept) + the DSA round_type plumbing.

## The load-bearing fact
`admin-api` resolves `technicalRoundType` only if the value is in `VALID_ROUND_TYPES`; otherwise safe-mode rewrites it to `dsa`. So the 3 new values MUST be added in **all three type-sites** — `ProcessStage.round_type` (stage-prep-types.ts:36), admin-api `TechnicalRoundType`+`VALID_ROUND_TYPES` (applications.ts), UI `technicalRoundType` (applications.types.ts:497) — or seeded data silently mis-renders.

## round_type ≠ pillar
`round_type` is the company's actual interview *format* (from `process_shape`); S2's `pillarClassification` is the JD's *topic* focus. They can disagree (a DevOps-pillar role at a company that still runs a DSA round). S5 keeps them separate — round_type is NOT derived from pillar.

## Components

### PR1 — ai-applications
**A. `stage-prep-types.ts`** — extend the union:
```ts
round_type?: 'dsa' | 'practical' | 'take-home' | 'system-design' | 'behavioural' | 'mixed'
  | 'troubleshooting' | 'architecture-review' | 'hands-on-lab';
```

**B. `constraint-block.ts`** — a `ROUND_TYPE_GUIDANCE: Record<string,string>` map; when `c.roundType` has an entry, append it after the existing `This interview round's type: X.` line:
- `architecture-review` → "Be ready to walk a system you built end-to-end: starting context, key decisions, tradeoffs, outcomes, and what you'd change."
- `troubleshooting` → "Expect incident-style debugging: log/metric analysis, hypothesis → isolate → fix, and an on-call/postmortem narrative."
- `hands-on-lab` → "Expect a time-boxed hands-on exercise (build/debug/eval); prioritise a working, tested, explainable result over cleverness."
Text-only; the Coach already consumes the constraint block. (The other 6 round types are unchanged — no guidance line, as today.)

**C. migration `061_round_type_devops_ai_backfill.sql`** — curated, **cited** backfill of `company_interview_profiles.process_shape` (UPDATE the technical stage's `round_type`), **only** for companies whose round format is documented as one of the 3 new types (2024–2026 source, confidence recorded in the SQL comment + the stage `note`). No force-fit: a type with no honest case is left unseeded (round_type can still be set per-application later). The exact rows are finalised in the plan after a quick source check; idempotent UPDATE.

### PR2 — tucaken-app
**D. admin-api `applications.ts`** — add the 3 to the `TechnicalRoundType` union AND `VALID_ROUND_TYPES`.
**E. UI `applications.types.ts`** — add the 3 to `technicalRoundType`. `DSA_ROUND_TYPES` (={dsa,mixed,practical}) is unchanged → the new types correctly **hide** the DSA section. No new UI surface (architecture-review's system-tour is S7).

## Data flow
```
company process_shape.round_type ∈ {troubleshooting|architecture-review|hands-on-lab}
  → admin-api technicalRoundType (now validates → no longer rewritten to dsa)
  → Technical workspace: DSA section hidden (not a DSA round)
  → coach constraint-block: 'This interview round's type: X.' + ROUND_TYPE_GUIDANCE[X]
  → round-appropriate coach prep
```

## Error handling & honesty
- New types validated in admin-api (no silent dsa fallback).
- Backfill cited-only; unseeded types await per-application data (no fabrication).
- Coach guidance is generic prep emphasis, never invented company specifics.
- DSA section correctly suppressed for the new types; DevOps section (S1) is evidence-driven, unaffected.

## Testing
- **A:** round_type round-trips the new values through `process_shape` (resolveStagePrepConstraints / repo).
- **B:** `buildStagePrepConstraintBlock` emits the matching guidance line for each new type; emits none for the existing 6.
- **C:** migration applies; re-tagged rows carry a cited `note`; values are within the enum.
- **D:** admin-api accepts + returns the new `technicalRoundType` values (no dsa fallback); rejects garbage (still → dsa).
- **E:** UI hides the DSA section when `technicalRoundType` is a new type; type compiles.

## Decomposition (2 PRs)
- **PR1 (ai-applications):** stage-prep-types enum + constraint-block guidance + migration 061 + tests.
- **PR2 (tucaken-app):** admin-api + UI type extensions + tests.

## Out of scope
- System-tour generation for architecture-review (S7); deriving round_type from pillar; new workspace surfaces for the new types (coach + DSA-suppression are the S5 effect).
