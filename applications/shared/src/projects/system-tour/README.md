<!-- @format -->

# system-tour/

Re-projects a finished case study into the narrative order a candidate walks
in an **architecture-review interview**: what the system is, the key
decisions and their rationale, the tradeoffs taken, the system map, the
outcomes, and what they would change next. The only input is the
already-grounded `CaseStudy`; there is no separate context loader and no
second grounding pass, so the tour can never introduce a claim the case
study did not already carry.

## Data flow

```text
CaseStudy (in memory, from ../case-study)
   ↓
computeCaseStudyHash (sha256 of the case study JSON)
   ↓
Redis exact cache (scope systemtour:<userId>:<projectId>, key = hash)
   ↓ miss
bedrockSystemTourAgent (Sonnet 4.6, tool emit_system_tour, 16k max tokens,
                        fail-fast: any schema violation throws, nothing partial persists)
   ↓
RdsSystemTourRepository.upsert → project_system_tours (one row per project)
```

Persist always runs, even on a cache hit, so a missing tour row self-heals.
Because the cache keys on the case-study hash, an unchanged case study
(including a case-study cache hit upstream) serves the tour from Redis
without a model call.

## Payload

`SystemTourSchema` (`.strict()`):

| Field | Shape |
| --- | --- |
| `area` | string, what part of the system the tour covers |
| `context` | string, the situation and constraints |
| `keyDecisions` | 1-6 x `{ decision, rationale }` |
| `tradeoffs` | up to 6 x `{ tension, chosenPath, cost }` |
| `systemMap` | the case study's `ArchitectureSchema`, reused verbatim |
| `outcomes` | up to 6 strings |
| `whatIdChange` | up to 4 strings; grounded improvements only, may be empty, never fabricated |

## Storage

`project_system_tours` (migration 063): `content` JSONB + `content_hash`,
`project_id` UNIQUE (one tour per project), upsert refreshes
`generated_at`. Every repository call sets the RLS context inside its
transaction with `SELECT set_config('app.current_user_id', $1, true)`; this
class is the reference pattern for RLS-parity persistence in the repo.

## Files

| File | Role |
| --- | --- |
| `system-tour-types.ts` | `SystemTourSchema` + `KeyDecision` / `Tradeoff` types. |
| `system-tour-agent.ts` | The Bedrock agent: honesty-disciplined prompt, forced tool `emit_system_tour`, fail-fast parse (no schema repair, no retry). Model `SYSTEM_TOUR_MODEL`, default Sonnet 4.6. |
| `system-tour-orchestrator.ts` | `runSystemTour`: hash, cache lookup (hits re-validated against the schema, every failure degrades to a miss), agent, cache write, persist. |
| `system-tour-persistence.ts` | `RdsSystemTourRepository`: RLS-scoped upsert + read of `project_system_tours`. |
| `__tests__/` | Unit tests for all four modules. |

## Entrypoint

No standalone Job. The case-study Job
(`applications/job-strategist/src/run-case-study.ts`) runs the tour inline
after persisting the case study; a tour failure is logged and never fails
the job.
