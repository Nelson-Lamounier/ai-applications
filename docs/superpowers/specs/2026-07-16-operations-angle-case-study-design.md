# Operations-angle case-study bullets + generation-time style gate

Date: 2026-07-16. Status: awaiting user spec review.

## Why

Convergence run d3d9ab76 shipped a style-clean projects section EXCEPT for two
CURATED bullets the style guard can only flag, never fix: "100+" (bare plus
numeric) and "(RETRIEVAL_PREFILTER)" (internal identifier). Curated bullets are
verbatim-by-id quotes from `project_resume_bullets`, so the only durable fix is
to make the case-study generator produce clean bullets in the first place --
and, while there, produce an operations-angle set so the projects agent's
operations composition has curated material, not just per-run research facts.

## What exists already (verified in code, 2026-07-16)

- `project_resume_bullets` (migration 030) already carries an `angle` column,
  `UNIQUE (project_id, angle)`, CHECK-constrained to six role-flavour angles:
  backend, frontend, infrastructure, fullstack, data_ml, product_leadership.
- The case-study agent (`applications/shared/src/projects/case-study-agent.ts`)
  emits "at most 3 sets -- pick only the angles this project supports"; the
  zod gate accepts up to 6; `upsertResumeBullets` upserts per (project, angle).
- The strategist pool loader (`loadProjectResumeBullets` in
  `project-evidence-block.ts`) flattens ALL angles per project and de-duplicates
  -- a new angle's rows enter the curated `[p{i}.b{j}]` lane with ZERO pool
  changes.

So this is NOT new machinery. It is: one new enum member, persona rules, a
deterministic style gate, and a migration.

## Components

### C1: `operations` angle (migration 120 + enum)

- Migration `120_operations_resume_bullet_angle.sql`: drop and re-add the
  `project_resume_bullets.angle` CHECK to include `'operations'`. Idempotent,
  ledger-checksummed like every numbered migration.
- `RESUME_BULLET_ANGLES` in `case-study-types.ts` gains `'operations'` (the
  comment says the enum mirrors migrations 030/031 -- migration 120 becomes
  the new source note).
- Deploy order: migration BEFORE the image that emits the new angle, or the
  insert fails the CHECK (same discipline as F12/119).

### C2: persona -- operations set + four-beat + style rules

`case-study-agent.ts` prompt section 7 changes:

- "at most 3 sets" becomes "at most 4 sets"; an `operations` set is REQUIRED
  whenever the project has run in a live environment (deploys, databases,
  caches, monitoring -- evidence-gated, never invented).
- Operations bullets follow the four-beat profile: what I did / what concept /
  why / result-value. Mirrors the projects-agent persona v3 composition rules.
- Style rules stated for ALL angles (writing rules, not a safety control --
  C3 is the control): no internal identifiers (SCREAMING_SNAKE), no bare
  "N+" counts (write "more than N" or the real number), acronyms introduced
  with their concept, no function() calls in prose.

### C3: deterministic style gate at generation (the actual control)

- Move the three regexes + `checkComposedBulletStyle` from
  `applications/job-strategist/src/agents/writer/projects-style.ts` into
  `applications/shared/src/projects/bullet-style.ts`; job-strategist
  re-imports from shared (single source, no duplication; shared is already a
  workspace dependency).
- In the case-study flow, after the agent returns: run the check over every
  `resumeBullets[].bullets[]`. Any finding -> ONE bounded retry carrying the
  violations back to the model (existing retry lane precedent:
  `case-study-agent-retry.ts`). Still dirty after the retry -> drop ONLY the
  dirty bullets (fail-open, keep the clean ones), log a
  `case_study_style_dropped` warning with the findings.
- Persisted bullets are therefore style-clean BY CONSTRUCTION; the
  strategist-side curated advisory count should trend to 0 for regenerated
  projects.

### C4: regeneration + rollout

- No automatic regeneration (curated bullets are user-facing portfolio
  content; Sonnet cost per case-study refresh). The user triggers
  `run-case-study` per project when ready; upsert-per-angle replaces the old
  sets, which retires "100+" and "(RETRIEVAL_PREFILTER)" for that project.
- Until regeneration, behaviour is unchanged (old angles still load; the
  style guard keeps flagging the two dirty bullets as advisory).

## Testing

- Migration: constraint accepts `operations`, rejects an unknown angle.
- Style gate: dirty fixture (the two live bullets verbatim) -> retry payload
  carries findings; still-dirty retry -> only dirty bullets dropped, clean
  siblings persist; fully-clean output -> byte-identical passthrough.
- Shared move: job-strategist style tests keep passing against the re-export
  (import path only; behaviour byte-identical).
- Persona: eval case asserting an operations set appears for a fixture with
  live-environment evidence and does NOT appear for a static-site fixture
  (per-phase eval, house rule 5).
- Pool: existing loader tests already cover angle flattening; add one fixture
  with an `operations` row proving it lands in the curated lane.

## Out of scope

- Backfilling/regenerating any project's case study (user-triggered later).
- tucaken-app UI (bullets render through existing surfaces).
- Touching `buildProjectPool`, `keyword-match.ts`, `summary-coverage.ts`.
