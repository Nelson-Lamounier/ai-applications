<!-- @format -->

# archetype/

The **archetype/stage calibration** ontology types and pure classifiers. A
case study for a production SaaS should emphasise different sections than
one for a CLI tool, and a staff-level candidate should surface different
evidence than a junior one. This subsystem decides which archetype a project
is and which career stage to calibrate for; the case-study prompt consumes
the result.

## The two axes

**Archetype** (`ARCHETYPE_IDS`, 9 values): `production_saas`,
`open_source_library`, `internal_tool`, `ml_research`, `devops_infra`,
`monorepo`, `cli_tool`, `mobile_app`, `static_site`.

**Stage** (`STAGE_IDS`, 4 values): `junior`, `mid`, `senior`, `staff`.

## How classification works

`classifyArchetype` scores each `ArchetypeDef` against the project's boolean
signal map (derived at ingestion by `../evidence/repo-signals.ts` and stored
in `repo_sync_state.archetype_signals`): any `required_any` match scores +2,
each `positive` +1, each `negative` -2, plus +1 for the archetype matching
the project's declared type. Best positive score wins; confidence is
`min(1, score / 4)`. No LLM, no I/O.

Stage resolution: `stickyStage` (an owner override in
`projects.user_overrides.stage`) wins; otherwise `pickStage` takes the
highest seniority level from `user_profile_rollup.direction`
(`junior → junior, mid → mid, mid-senior/senior → senior, staff+ → staff`).

## Where the definitions live

This folder holds no data. `ArchetypeDef` rows and `StageOverlay` rows
(priority/deemphasised sections per archetype x stage) are seeded in the
`project_archetypes` and `project_stage_overlays` tables and loaded through
`RdsProjectOntologyRepository` (`shared/src/rds/implementations`). The
case-study loader (`../case-study/case-study-loader.ts::computeCalibration`)
wires everything together and folds the result into the agent context.

## Files

| File | Role |
| --- | --- |
| `archetype-types.ts` | The id lists and interfaces: `ArchetypeDef`, `StageOverlay`, `ClassificationSignals`, classify inputs. |
| `archetype-classifier.ts` | `classifyArchetype`: the pure scoring classifier. |
| `derive-stage.ts` | `pickStage` / `mapSeniorityLevel` / `stickyStage`: seniority rollup to stage, with owner override. |
| `__tests__/` | Unit tests for the classifier and stage mapping. |
