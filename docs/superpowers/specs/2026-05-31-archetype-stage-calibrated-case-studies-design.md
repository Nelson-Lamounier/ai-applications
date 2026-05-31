# Archetype/Stage-Calibrated Case Studies — Design

> **Date:** 2026-05-31
> **Status:** Approved (brainstorming) → ready for implementation plan
> **Scope:** ai-applications only, 1 PR. Purely additive + degradable.

## Problem

Case-study generation emits the **same sections for every project**, regardless of
what kind of project it is or the candidate's seniority. A `junior cli_tool` and a
`senior production_saas` get identically-shaped case studies. The system has no
notion of "what a great case study of THIS archetype at THIS stage should
emphasise."

Separately, a rich **archetype/stage ontology already exists** — 9 repo archetypes ×
4 career stages (36 overlays) in the published `@tucaken/ontology@0.6.0` package
(in the *separate* `tucaken-skill` repo) — but it is **stranded**: neither
ai-applications nor tucaken-app consumes it.

## Goal

De-strand the ontology (seed into ai-applications' DB) and use it to **calibrate**
case-study generation: classify each project to an archetype, derive the candidate's
career stage, and feed the resulting "priority sections + stage guidance" into the
case-study prompt as **soft guidance**.

## Non-negotiable principle: additive + degradable

Calibration changes **emphasis, never structure or truthfulness**:
- The output schema, evidence-gating (system-prompt Rule 1), and the
  `BedrockGroundingVerifier` pass are **untouched**.
- Every new field is optional. When classification or stage derivation yields
  nothing (new user, sparse profile, ambiguous repo), the prompt is byte-identical
  to today and generation proceeds unchanged.
- Therefore this feature **cannot regress** the hallucination controls already in
  place, and **cannot break generation** for any user regardless of data maturity.

## Multi-tenancy (explicit)

| Piece | Tenancy | Mechanism |
|-------|---------|-----------|
| Ontology tables (archetypes + overlays) | **Global reference data** | No `user_id`, **no RLS**, `GRANT SELECT TO tucaken_app` — mirrors `technology_ontology`. Seeded once, read by all users. |
| Archetype classification | Per-project, on **the user's own** data | Runs on that user's `projects`/`repositories`/`repository_profiles` rows (already RLS-scoped). |
| Stage derivation | Per-user | Reads that user's DirectionSynthesizer seniority (RLS-scoped). |
| `computed_archetype`/`computed_stage` | Per-project | Columns on `projects` — RLS-inherited (migration 030 pattern). |

The scalable shape is **one shared catalog + per-user application** — identical to the
existing technology ontology. New users with no profile degrade gracefully (see
Fallbacks).

---

## Architecture

```
ONE-TIME (migration 046):
  Seed 9 archetypes + 36 stage overlays into global tables
  (transcribed from @tucaken/ontology v0.6.0 YAML → idempotent SQL seed; version-stamped).
  Add computed_archetype / computed_stage / archetype_computed_at to projects.

CASE-STUDY RUN — inside loadCaseStudyContext, before packContext:
  1. classifyArchetype(project.type/shape, repos[].primaryLanguage/topics/techStack/filePaths)
        → { archetypeId, confidence } | null        (deterministic, no LLM)
  2. deriveStage(userId)  ← map DirectionSynthesizer seniority (5 levels → 4)
        → 'junior'|'mid'|'senior'|'staff' | null
  3. look up overlay: SELECT priority_sections, deemphasized_sections, stage_suggestions
        FROM project_stage_overlays WHERE archetype_id AND stage
        (fallback: archetype.expected_sections when stage is null)
  4. UPDATE projects SET computed_archetype, computed_stage, archetype_computed_at
  5. inject archetype/stage/prioritySections/stageSuggestions into CaseStudyContext
        ↓
  agent: append a "Project calibration" guidance block to the system prompt
         ONLY when archetype is present. Output schema UNCHANGED.
        ↓
  evidence-gating + grounding verifier run exactly as today.
```

### Fallbacks (the multi-tenant safety net)

- **No archetype match / low confidence** → `classifyArchetype` returns `null` →
  no calibration fields → prompt unchanged → today's behavior.
- **No seniority computed** (new/sparse user) → `deriveStage` returns `null` →
  use the archetype's `expected_sections` only (skip the stage overlay). Never blocks.
- **Archetype present, stage null** → archetype-only calibration.

---

## Components

### 1. Migration `046_project_ontology.sql`

Two **global** tables (no `user_id`, no RLS — like `technology_ontology`):

```sql
CREATE TABLE IF NOT EXISTS project_archetypes (
    id                     TEXT PRIMARY KEY,            -- 'production_saas', ...
    name                   TEXT NOT NULL,
    description            TEXT NOT NULL,
    classification_signals JSONB NOT NULL DEFAULT '{}', -- {required_any[],positive[],negative[]}
    expected_sections      JSONB NOT NULL DEFAULT '[]',
    expected_artifacts     JSONB NOT NULL DEFAULT '[]',
    pillar_weights         JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS project_stage_overlays (
    archetype_id          TEXT NOT NULL REFERENCES project_archetypes(id) ON DELETE CASCADE,
    stage                 TEXT NOT NULL CHECK (stage IN ('junior','mid','senior','staff')),
    priority_sections     JSONB NOT NULL DEFAULT '[]',
    priority_artifacts    JSONB NOT NULL DEFAULT '[]',
    deemphasized_sections JSONB NOT NULL DEFAULT '[]',
    required_pillars      JSONB NOT NULL DEFAULT '[]',
    stage_suggestions     JSONB NOT NULL DEFAULT '[]',
    PRIMARY KEY (archetype_id, stage)
);

GRANT SELECT ON project_archetypes, project_stage_overlays TO tucaken_app;

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS computed_archetype    TEXT,
    ADD COLUMN IF NOT EXISTS computed_stage        TEXT,
    ADD COLUMN IF NOT EXISTS archetype_computed_at TIMESTAMPTZ;
```

**Seed:** 9 `INSERT INTO project_archetypes … ON CONFLICT (id) DO UPDATE` + 36
`INSERT INTO project_stage_overlays … ON CONFLICT (archetype_id, stage) DO UPDATE`,
transcribed verbatim from `@tucaken/ontology` v0.6.0 YAML. A header comment stamps
the source version. Idempotent: re-bootstrap reconciles to the migration's values;
the migration file is the source of truth (a future upstream change = a new migration).

**Archetype ids** (9): `production_saas`, `open_source_library`, `internal_tool`,
`ml_research`, `devops_infra`, `monorepo`, `cli_tool`, `mobile_app`, `static_site`.
**Stages** (4): `junior`, `mid`, `senior`, `staff`.

### 2. Ontology read repo — `RdsProjectOntologyRepository`

`applications/shared/src/rds/implementations/RdsProjectOntologyRepository.ts`:
```
getArchetype(id): Promise<ArchetypeDef | null>
getStageOverlay(archetypeId, stage): Promise<StageOverlay | null>
```
Plain `SELECT` (global tables, no RLS context needed). Returns typed objects from the
JSONB columns.

### 3. Archetype classifier — `archetype-classifier.ts`

Pure, deterministic, no LLM/network:
```
classifyArchetype(input: ClassifyInput): { archetypeId: string; confidence: number } | null
```
`ClassifyInput` = `{ projectType, projectShape, repos: { primaryLanguage, topics, techStack, filePaths }[] }`.

Logic (ports tucaken-signal `RepoClassifier`):
1. Derive boolean **signals** best-effort from available data — e.g. `has_notebooks`
   (filePath `*.ipynb`), `has_iac` (paths `terraform|k8s|helm|cdk|argocd` or matching
   topics), `has_workspaces` (monorepo shape / multi-package paths),
   `has_package_publish` (tech_stack/topics), mobile (RN/Flutter/Swift/Kotlin in
   techStack). Missing signals simply don't fire.
2. Seed a **prior from `projectType`**: `production_saas→production_saas`,
   `open_source→open_source_library`, `internal_tool→internal_tool` (others: no prior).
3. **Decisive rules first** (mobile → ml → static → devops → monorepo → cli → oss-lib),
   then **additive scoring** against each archetype's seeded `classification_signals`
   (`required_any` +2, `positive` +1, `negative` −2).
4. **Confidence gate**: no positive score / below threshold → return `null`.

Classifier takes archetype defs as a parameter (loaded via the repo) — keeps it pure
and table-testable.

### 4. Stage derivation — `deriveStage(...)`

Reads the per-area seniority DirectionSynthesizer already computed + stored during
ingestion: `user_profile_rollup.direction` JSONB (one row per user, migration 026),
shape `direction.seniority[] = { area, level, evidence }` where `level ∈
{junior, mid, mid-senior, senior, staff+}`. Maps the 5 levels → 4:
`junior→junior`, `mid→mid`, `mid-senior→senior`, `senior→senior`, `staff+→staff`.
Selects the **highest** area's level (strongest recruiter framing). No seniority data
→ returns `null`.

### 5. Loader wiring — `case-study-loader.ts`

After building `rawContext`, before `packContext`:
- `classifyArchetype(...)` from the loaded project + repos.
- if archetype: `deriveStage(userId)`, then `getStageOverlay(archetypeId, stage)` (or
  `getArchetype(archetypeId).expected_sections` when stage null).
- `UPDATE projects SET computed_archetype, computed_stage, archetype_computed_at`.
- attach `archetype` / `stage` / `prioritySections` / `stageSuggestions` to the context.

### 6. CaseStudyContext fields (`case-study-types.ts`) — optional, additive

```ts
readonly archetype?:        { id: string; name: string } | null;
readonly stage?:            'junior' | 'mid' | 'senior' | 'staff' | null;
readonly prioritySections?: readonly string[];
readonly stageSuggestions?: readonly { title: string; description: string }[];
```

### 7. Prompt guidance (`case-study-agent.ts`)

Append to the system prompt **only when `context.archetype` is set**:
```
Project calibration:
This is a {stage}-level {archetypeName} project. Recruiters at this level look
hardest at: {prioritySections joined}. Prioritise depth and evidence there.
{De-emphasise: {deemphasized} when present.}
Still emit every section the evidence supports — calibration changes emphasis,
never truthfulness. Omit any section you cannot ground.
```
**Tool schema + Zod schema + `required[]` unchanged.** Soft guidance only.

### 8. Cache key (`computeInputHash`)

Append archetype + stage to the hash so calibration changes rotate the cache key.
When archetype is absent, the hash is byte-identical to today (cache back-compat).

---

## Testing (TDD)

- **046**: idempotent re-apply; 9 + 36 rows seeded; global (no RLS) + GRANT; 3 new
  `projects` columns.
- **archetype-classifier**: table-driven per archetype (decisive rule fires); additive
  scoring; `projectType` prior; low-confidence → null; missing signals tolerated.
- **deriveStage**: 5→4 mapping; highest-area selection; no-seniority → null.
- **RdsProjectOntologyRepository**: archetype + overlay lookups; missing → null.
- **loader**: injects fields when classified; absent when null (fallback); persists
  computed columns.
- **computeInputHash**: archetype/stage change rotates; absent archetype = today's hash.
- **agent**: guidance block present only when archetype set; schema unchanged.
- Full `@bedrock/shared` suite green (regression).

## Sequencing (1 PR, ordered commits)

1. Migration 046 (tables + seed + projects columns).
2. `RdsProjectOntologyRepository` + `archetype-classifier` + `deriveStage` (pure, tested).
3. Loader wiring + `CaseStudyContext` fields + persist + `computeInputHash`.
4. Agent prompt guidance block.

## Rollout

Bootstrap applies 046 → the next case-study regeneration auto-classifies (no resync
needed — uses existing data). Verify: `computed_archetype`/`computed_stage` populate,
job logs show the calibration block, output structure unchanged (still grounded).

## Out of scope (YAGNI)

Dynamic-required schema enforcement; UI build (only persisted fields the UI *can* later
read); tucaken-skill changes; LLM-based classification; an upstream-sync generator
script; the anti-pattern catalog and section-template library (grounding already covers
their concern — see the prior review).
