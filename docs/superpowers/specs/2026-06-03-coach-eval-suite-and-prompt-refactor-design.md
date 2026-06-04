# Coach Eval Suite + Prompt Refactor — Design

**Date:** 2026-06-03
**Status:** Approved (brainstorming) → ready for implementation plan
**Scope:** `applications/job-strategist`

## Problem

The Interview Coach agent (`src/agents/coach-agent.ts`) uses a single "fat persona"
system prompt (`src/prompts/coach-persona.ts`) carrying every stage's instructions.
Three concrete defects exist today:

1. **Stage-name drift.** The persona branches are keyed on `phone_screen`,
   `behavioral_round`, `technical_round`, `system_design`, `final_round`,
   `offer_negotiation` — *none* of which match the canonical `INTERVIEW_STAGES`
   enum (`trigger.schema.ts`): `applied, phone-screen, technical-1, technical-2,
   behavioural, system-design, take-home, final-round, offer, rejected, withdrawn`.
   The model receives `technical-1` but the prompt branch says `technical_round`,
   forcing a fuzzy self-mapping every run.
2. **Stale output example.** The persona's `OUTPUT FORMAT` JSON example shows
   fields that do not exist in the tool schema (`conceptExplanation`, `kbCoverage`,
   `studyGuide`, `kbCoverageReport`, `topicsCovered`) and omits real fields
   (`skillTransfer`, `careerArcSummary`, `jdTalkingPoints`, `compScript`). Forced
   `tool_use` ignores it for structure, but it pollutes content intent and wastes
   cached tokens.
3. **No quality/grounding evals.** Existing jest tests assert schema + tool config
   only. There is no guard that the coach grounds citations in real evidence,
   focuses on the right stage, or stays honest about gaps. Prompt changes ship
   unmeasured. (Context: PR #67 — `suggestedResources` field drift crash; this is
   the cross-repo type-drift hazard recorded in project memory.)

This design addresses item 8 (per-stage eval suite) and item 4 (base+stage prompt
refactor) from the architecture review. The eval suite is built **first** and acts
as the regression harness for the refactor.

## Decisions (from brainstorming)

| Question | Decision |
|----------|----------|
| Eval execution model | **Tiered** — Tier 1 deterministic graders (jest, every commit, no Bedrock); Tier 2 live coach + LLM-judge (on-demand) |
| Fixture source | **Fully offline for v1** — hand-authored committed inputs AND realistic synthetic outputs. No live-Bedrock baseline capture in v1; the real-run anchor is deferred to Tier 2 (which is already live/on-demand). |
| v1 stage coverage | **phone-screen, technical (technical-1/-2), behavioural** (system-design deferred to when that stage is built) |
| Prompt assembly | **Skills-pattern folders** — `prompts/coach/` with `base.ts` (sole source of shared grounding) + per-branch stage files |

## Architecture

### File layout

```
src/evals/
  graders/
    schema-grader.ts        # parse vs CoachOutputSchema + stage required/forbidden fields
    grounding-grader.ts     # every evidenceRef.id & projectId ∈ candidate ids; no invented ids
    stage-focus-grader.ts   # correct branch fields present/absent for the stage (heuristic)
    honesty-grader.ts       # gap⇒projectId=null+[]; demonstrated/claimed⇒evidence; == validateSkillTransfer
  graders.ts                # Grader type, runGraders(input,output) → GraderReport, shared id-membership helper
  fixtures/
    phone-screen.json       # { input: {analysisXml, candidateSets, stage}, output: hand-authored synthetic }
    technical.json
    behavioural.json
  coach-evals.test.ts       # TIER 1 — jest, every commit, deterministic
  live/
    capture-fixture.ts      # one-time: capture real coach run → seed fixture output
    judge.ts                # LLM-judge (Sonnet) structured verdict for subjective axes
    run-live-evals.ts       # TIER 2 — manual/nightly, gated behind RUN_LIVE_EVALS=1

src/prompts/coach/
  base.ts                   # COACH_BASE: role, truthfulness mandate, output-contract (prose), ESL — SOLE shared source
  stages/
    phone-screen.ts         # phone-screen delta (careerArc / jdTalkingPoints / compScript guidance)
    technical.ts            # technical delta (skill-transfer block, DSA/DevOps)
    behavioural.ts          # behavioural delta (STAR)
    index.ts                # resolveCoachBranch(stage) + assembleCoachSystemPrompt(stage)
# coach-persona.ts is DELETED — hard-cut, no shim (only 2 source importers)
```

### Stage → branch resolver

`resolveCoachBranch(stage: InterviewStage): CoachBranch`

- `phone-screen` → `phone-screen`
- `technical-1`, `technical-2` → `technical`
- `behavioural` → `behavioural`
- all others (`applied`, `system-design`, `take-home`, `final-round`, `offer`,
  `rejected`, `withdrawn`) → `general` (base only) for v1

Branches are keyed on the canonical enum — the underscore-name drift is structurally
eliminated.

### Prompt assembly

`assembleCoachSystemPrompt(stage)` returns:

```
[ { text: COACH_BASE }, { cachePoint: { type: 'default' } }, { text: STAGE_DELTA } ]
```

The cache point sits **after** `COACH_BASE` so the large shared base is cached once
and reused across all stages; only the small stage delta recomputes. Net: less prompt
text per call than today, with comparable cache efficiency.

## Components

### Tier 1 graders (the heart)

`EvalInput = { analysisXml, candidateSets: SkillCandidateSet[], stage: InterviewStage }`
— identical to what the coach receives.

Each grader: `(input, output) => GraderResult { grader, pass, score, failures[] }`.
`runGraders` aggregates → `GraderReport { pass, results[] }`. Tier 1 asserts
**properties, not string-equality**, so captured real outputs anchor realism without
brittleness.

1. **schema-grader** — reuses `CoachOutputSchema` (imported, not redefined). Plus stage
   gate: `phone-screen` ⇒ `careerArcSummary`/`jdTalkingPoints`/`compScript` present;
   all other branches ⇒ those fields absent. Mirrors `coachToolForStage` required-set
   and the "omit entirely" mandate. Catches the PR #67 drift class.
2. **grounding-grader** — core axis. Allowed-id set built from `candidateSets`. Assert:
   every `skillTransfer[].evidenceRefs[].id` ∈ allowed ids; `projectId` ∈ allowed project
   ids or null; one entry per JD skill; **zero invented ids**. Lifts the contract
   `buildSkillCandidateBlock` promises into a graded check.
3. **stage-focus-grader** — branch-appropriate content via field-presence + marker-string
   heuristics (no NLP — that is Tier 2's job). phone-screen: comp/career-arc populated;
   technical: `skillTransfer` non-empty when candidates exist + checklist rationale
   references matched projects; behavioural: difficult/behavioural questions present,
   STAR-shaped frameworks.
4. **honesty-grader** — reuses `validateSkillTransfer` semantics (imported, not
   duplicated). Assert: `tier='gap'` ⇒ `projectId=null` AND `evidenceRefs=[]`;
   `tier∈{demonstrated,claimed,declared}` ⇒ non-empty evidenceRefs all in candidate set.
   Then assert grader output **equals** `validateSkillTransfer` output (gold is already
   honest → no demotions). Divergence = drift tripwire → test fails.

The id-membership predicate shared by grounding-grader and honesty-grader is factored
into one helper in `graders.ts` so the two cannot drift.

### Tier 2 live evals + LLM-judge

`run-live-evals.ts` (manual/nightly, gated behind `RUN_LIVE_EVALS=1`, excluded from
default `jest`):

- Runs the real coach (Sonnet) over the 3 gold *inputs*.
- Pipes output through all Tier-1 graders + the LLM-judge.
- `judge.ts` — Sonnet, forced-tool structured verdict `{ axis, pass, score 0-1,
  reasoning }` per subjective axis:
  - **narrative-faithfulness** — each `skillTransfer` narrative actually follows from
    its cited evidence, no embellishment.
  - **stage-focus** — content genuinely right for the stage (not just field-present).
  - **hallucination-scan** — any claim not traceable to analysis/candidates.
- Emits a markdown report to stdout. Costs money — run before prompt changes.

## Data flow

```
EvalInput (analysisXml, candidateSets, stage)
   │
   ├─ Tier 1 ─→ runGraders(input, fixture.output) ──→ GraderReport  (jest, every commit)
   │
   └─ Tier 2 ─→ real coach (Sonnet) ─→ output ─→ runGraders + judge ─→ markdown report
                                                  (RUN_LIVE_EVALS=1)
```

## Refactor mechanics (item B)

1. `coach/base.ts` — extract role + truthfulness mandate + output-contract (prose,
   pointing at the tool — **delete the stale JSON example**) + ESL from current persona.
2. `coach/stages/*.ts` — each branch's delta lifted from current STAGE sections,
   renamed to canonical enum vocabulary.
3. `coach/stages/index.ts` — `resolveCoachBranch` + `assembleCoachSystemPrompt`.
4. `coach-agent.ts` `getConfig` — `systemPrompt: assembleCoachSystemPrompt(ctx.interviewStage)`;
   drop static `COACH_PERSONA_SYSTEM_PROMPT` from config.
5. **Hard-cut, no shim.** Delete `coach-persona.ts` and `COACH_PERSONA_SYSTEM_PROMPT`.
   Only two source importers exist — `coach-agent.ts` (now uses
   `assembleCoachSystemPrompt`) and `coach-persona.test.ts` (replaced by `coach/`
   tests). Both updated in this work; no transitional re-export retained.

## Testing & sequence

1. Write graders + `coach-evals.test.ts` against hand-authored fixtures (red→green on
   graders themselves).
2. Hand-author realistic synthetic outputs per stage (committed fixtures). Confirm
   graders green on them → graders encode the contract. *If a grader fails on a
   known-good synthetic output, the grader is wrong, not the fixture.* (Anchoring
   against a real captured run is deferred — see Tier 2 and Out of scope.)
3. Refactor B. Re-run `jest` → graders must stay green (regression guard). Replace
   `coach-persona.test.ts` with `coach/` unit tests: base has mandate + no stale fields;
   each stage file has its markers + canonical name; `assembleCoachSystemPrompt('technical-1')`
   includes technical delta and excludes phone-screen fields.
4. Run Tier 2 live once pre/post refactor — confirm no quality regression.

## Out of scope (v1, YAGNI)

- **system-design stage evals** — build with the stage when that work starts.
- **Haiku→Sonnet config flip** — separate trivial change (item 7); Tier 2 assumes Sonnet.
- **CI wiring of Tier 2** — manual env flag for now; no new eval-framework dependency.
- **Real-run fixture anchor** — v1 is fully offline (synthetic outputs). Anchoring
  fixtures against a captured real run is deferred; it can be added later via
  `capture-fixture.ts` once there is a reason to, and Tier 2 already exercises the
  real model on-demand in the meantime.

## Risks

- **Synthetic outputs may not mirror real model messiness.** Accepted for v1: Tier 2
  (live + judge) is the realism backstop and runs on-demand before prompt changes;
  the offline Tier 1 stays deterministic and CI-cheap. Revisit if a prompt regression
  ships that Tier 1 should have caught.
- **Hard-cut of `COACH_PERSONA_SYSTEM_PROMPT`** — two source importers
  (`coach-agent.ts`, `coach-persona.test.ts`) are updated in this work; no shim. The
  `dist/` copy is build output and regenerates. Re-grep before deletion to confirm no
  new importer has appeared.
