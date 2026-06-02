# DevOps/AI Story Scaffolds — S6: Design

> **Date:** 2026-06-02 · **Status:** Approved design. Plan next.
> **Goal:** Give the Coach honest STAR-style *structures* for DevOps/AI interview narratives (incident, migration, cost, eval, reliability) — and wire the Coach to actually consume story scaffolds (it ignores them today).
> **Repo:** `ai-applications` (single PR). **Migration 062.** **Branch:** `feat/story-scaffolds-s6` off develop.
> **Sixth sub-project** (S6). Builds on Spec 1 `prep_scaffolds` (049). Design-input §7.

## The real gap
`prep_scaffolds` already has `story_scaffold` rows (star/car/sar) but `constraint-block.loadStagePrepConstraints` only loads `'gap_handling'` — so **every story scaffold is seeded-but-inert**. S6's core is the wiring; the new rows are additive.

## Components (single PR)

### A. migration `062_devops_ai_story_scaffolds.sql`
Add ~5 `story_scaffold` rows (reuse the existing kind — no CHECK migration), **constraint-only** `structure = {"steps":[{key,label,prompt}]}` (mirrors the `star` row; prompts ask the candidate questions, never supply example content). Idempotent `ON CONFLICT (id) DO UPDATE`:
- `incident-response` — detection → diagnosis (hypothesis→isolate) → mitigation → root cause → prevention
- `system-migration` — motivation → approach & rollback plan → cutover → validation → outcome
- `cost-optimization` — baseline cost → hypothesis → change → measured before/after → tradeoff
- `ai-eval-building` — quality problem → eval design (golden set/rubric) → baseline → iteration → regression guard
- `reliability-scaling` — SLO/target → bottleneck → change → load/impact → next step

### B. `constraint-block.ts` (the wiring)
- `StagePrepConstraints` += `readonly storyScaffolds: PrepScaffold[]`.
- `loadStagePrepConstraints`: add `repo.listScaffolds('story_scaffold')` to the existing `Promise.all`; set `storyScaffolds` on the result.
- `buildStagePrepConstraintBlock`: when `storyScaffolds.length`, push one concise line:
  `Story structures the candidate can borrow (fill with their OWN verified evidence — never fabricate): <title>; <title>; …`
  Titles only (cheap; coach picks the relevant one). Always rendered (no pillar/round_type gating → no coupling to the open S2/S5 PRs). The existing `TRUTHFULNESS` line already reinforces evidence-grounding.

## Data flow
```
prep_scaffolds (story_scaffold: star/car/sar + 5 new) → loadStagePrepConstraints (listScaffolds('story_scaffold'))
  → StagePrepConstraints.storyScaffolds → buildStagePrepConstraintBlock 'Story structures…' line
  → coach prompt → coach offers a relevant structure, grounded in the candidate's real evidence
```

## Honesty
Structure not content (Spec-1 principle); the render line + `TRUTHFULNESS` make scaffolds explicitly fill-with-real-evidence; the seeded `structure` is prompts/labels only — no example narratives.

## Testing
- **A:** migration applies; the 5 new `story_scaffold` rows present; structure parses as `{steps:[…]}`.
- **B:** `loadStagePrepConstraints` calls `listScaffolds('story_scaffold')` and populates `storyScaffolds`; `buildStagePrepConstraintBlock` renders the 'Story structures…' line with the titles; omits the line when `storyScaffolds` is empty. (FULL test fixture gains a `storyScaffolds` field; the existing `loadStagePrepConstraints` fakeReader already returns `[]` for listScaffolds.)

## Decomposition
Single PR (`ai-applications`): migration 062 + constraint-block wiring + tests.

## Out of scope
Per-pillar/round_type gating (universal availability; coach filters); example stories (never); a UI surface (coach-side only).
