# Final Stage Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `final` coach stage producing grounded pre-final-interview prep (why-this-role narrative, mutual-fit talking points, substantive questions, honest long-term framing), rendered in FinalWorkspace's pre-offer state.

**Architecture:** Mirror the just-shipped **bar-raiser** coach stage (prompt → per-phase schema → light validation → run-coach wiring → workspace render), but with **no ontology/migration** — final prep grounds in the career-arc + JD + research context the coach already receives.

**Tech Stack:** ai-applications job-strategist (TS, Bedrock Converse forced tool_use, Sonnet), tucaken-app React/TS. Branch `feat/final-stage-phase1-spec` (ai-applications, already created off develop) for backend; a tucaken-app branch off main for the UI. PRs per repo.

**Spec:** `docs/superpowers/specs/2026-06-05-final-stage-phase1-design.md`

**Reference (copy the pattern — these were built last):** bar-raiser — `applications/shared/src/stage-prep/bar-raiser-types.ts`, `coach-agent.ts` (`barRaiserWalkthrough` tool schema + `BarRaiserPrincipleSchema` Zod + `BAR_RAISER_FIELDS` + `STAGE_REQUIRED_FIELDS` map), `prompts/coach/stages/bar-raiser.ts` + `index.ts` registration, `run-coach.ts` (`buildBarRaiserInputs` + `barRaiserBlock` threading + validate), `evals/graders/bar-raiser-grader.ts` + `fixtures/bar-raiser.json`, tucaken-app `BarRaiserWalkthrough.tsx` + `BarRaiserWorkspace.tsx`.

---

## File Structure
- Create `applications/shared/src/stage-prep/final-types.ts` — `FinalPrep`, `FinalTalkingPoint`, `FinalQuestion` (+ export from `stage-prep/index.ts`).
- Modify `applications/shared/src/strategist-types.ts` — `InterviewCoachResult.finalPrep?`.
- Modify `applications/job-strategist/src/agents/coach-agent.ts` — tool schema + Zod + `FINAL_FIELDS` + `coachToolForStage`.
- Create `applications/job-strategist/src/lib/final-validation.ts` — `validateFinalPrep`.
- Create `applications/job-strategist/src/prompts/coach/stages/final.ts` — `FINAL_DELTA`.
- Modify `applications/job-strategist/src/prompts/coach/stages/index.ts` — register `final`.
- Create `applications/job-strategist/src/evals/graders/final-grader.ts` + `fixtures/final.json`; modify `stage-focus-grader.ts` + `schema-grader.ts`.
- Modify `applications/job-strategist/src/run-coach.ts` — `buildFinalInputs` + wiring.
- tucaken-app: modify `src/lib/types/applications.types.ts`, `src/features/applications/stages/workspaces/FinalWorkspace.tsx`, `src/__tests__/features/applications/stage-components.test.tsx`.

---

## Task 1: FinalPrep types + schema

**Files:** Create `applications/shared/src/stage-prep/final-types.ts`; Modify `applications/shared/src/stage-prep/index.ts`, `applications/shared/src/strategist-types.ts`, `applications/job-strategist/src/agents/coach-agent.ts`

- [ ] **Step 1: shared types** — `final-types.ts`:
```ts
export interface FinalTalkingPoint { point: string; grounding: string }
export interface FinalQuestion { question: string; rationale: string }
export interface FinalPrep {
  whyThisRole: string
  mutualFitTalkingPoints: FinalTalkingPoint[]
  substantiveQuestions: FinalQuestion[]
  longTermFraming: string
}
```
Export from `stage-prep/index.ts` (mirror the `bar-raiser-types` export line).

- [ ] **Step 2: result type** — in `strategist-types.ts`, import `FinalPrep` and add to `InterviewCoachResult` (next to `barRaiserWalkthrough?`):
```ts
readonly finalPrep?: FinalPrep
```

- [ ] **Step 3: tool schema** — in `coach-agent.ts` `COACH_TOOL.inputSchema.properties`, add `finalPrep` (mirror how `barRaiserWalkthrough` object is declared, `additionalProperties:false`):
```
finalPrep: { type:'object', properties: {
  whyThisRole:{type:'string'},
  mutualFitTalkingPoints:{type:'array', items:{type:'object', properties:{point:{type:'string'},grounding:{type:'string'}}, required:['point','grounding'], additionalProperties:false}},
  substantiveQuestions:{type:'array', items:{type:'object', properties:{question:{type:'string'},rationale:{type:'string'}}, required:['question','rationale'], additionalProperties:false}},
  longTermFraming:{type:'string'}
}, required:['whyThisRole','mutualFitTalkingPoints','substantiveQuestions','longTermFraming'], additionalProperties:false }
```

- [ ] **Step 4: Zod** — add `FinalPrepSchema` (`.strict()`) mirroring `BarRaiserPrincipleSchema`, and `finalPrep: FinalPrepSchema.optional()` on `CoachOutputSchema`.

- [ ] **Step 5: FINAL_FIELDS + coachToolForStage** — `export const FINAL_FIELDS = ['finalPrep'] as const;` and add `final: FINAL_FIELDS` to the `STAGE_REQUIRED_FIELDS` map.

- [ ] **Step 6: verify + commit** — `yarn workspace @bedrock/shared build && yarn workspace @bedrock/job-strategist typecheck` clean; `yarn workspace @bedrock/job-strategist test coach-agent` green. `git commit -m "feat(final): FinalPrep type + per-phase coach schema"`

---

## Task 2: validateFinalPrep

**Files:** Create `applications/job-strategist/src/lib/final-validation.ts`; Test `applications/job-strategist/src/lib/final-validation.test.ts`

- [ ] **Step 1: failing test:**
```ts
import { validateFinalPrep } from './final-validation.js'
it('drops empty talking points + requires questions', () => {
  const out = validateFinalPrep({ whyThisRole:'x', longTermFraming:'y',
    mutualFitTalkingPoints:[{point:'a',grounding:'b'},{point:'',grounding:''}],
    substantiveQuestions:[{question:'q',rationale:'r'}] })
  expect(out.mutualFitTalkingPoints).toHaveLength(1)
  expect(out.substantiveQuestions).toHaveLength(1)
})
it('returns null-safe on undefined', () => { expect(validateFinalPrep(undefined)).toBeUndefined() })
```

- [ ] **Step 2: implement** `validateFinalPrep(prep: FinalPrep | undefined): FinalPrep | undefined` — if undefined return undefined; filter out talking points/questions with empty `point`/`question` (trim); return the cleaned object. No `any`; import `FinalPrep` from `@bedrock/shared`.

- [ ] **Step 3: verify + commit** — `yarn workspace @bedrock/job-strategist test final-validation` green. `git commit -m "feat(final): validateFinalPrep hygiene"`

---

## Task 3: final.ts prompt + registration + eval

**Files:** Create `applications/job-strategist/src/prompts/coach/stages/final.ts`; Modify `stages/index.ts`; Create `evals/graders/final-grader.ts` + `evals/fixtures/final.json`; Modify `evals/graders/stage-focus-grader.ts`, `evals/graders/schema-grader.ts`, the grader list in `coach-evals.test.ts`

- [ ] **Step 1: `FINAL_DELTA`** (mirror `BAR_RAISER_DELTA` joined-lines). Instruct: from the candidate's career arc + JD + research, emit one `finalPrep`:
  - `whyThisRole`: narrative anchored to the user's REAL career arc + role fit — why this role, why now. **No fabricated passion**; ground in demonstrated capability + genuine trajectory.
  - `mutualFitTalkingPoints[]` `{point, grounding}`: each cites the real career fact/evidence it rests on.
  - `substantiveQuestions[]` `{question, rationale}`: specific to the company/role from the JD/research — NOT generic ("tell me about the culture" is banned).
  - `longTermFraming`: honest 1-3yr framing.
  Include anti-invention rules: no invented company-internal facts; no fit-score; ground every claim. End: "Do NOT emit technical/behavioural/difficult question arrays for this stage." Add 2-3 short examples of grounded vs generic.

- [ ] **Step 2: register** in `stages/index.ts` — add `final` to `CoachBranch`, `resolveCoachBranch`, the `DELTA` map (`DELTA['final']=FINAL_DELTA`), and a `stageUsesFinalPrep` helper (mirror `stageUsesBarRaiserWalkthrough`).

- [ ] **Step 3: eval fixture** `evals/fixtures/final.json` — gold input (`stage:'final'`, candidateSets/analysis with a career arc) + output with a grounded `finalPrep` (non-generic questions, talking points with grounding). Mirror `bar-raiser.json` structure.

- [ ] **Step 4: `final-grader.ts`** (deterministic, no LLM) — fail if: `finalPrep` missing; `whyThisRole`/`longTermFraming` empty; `substantiveQuestions` empty OR any matches a generic-phrase blocklist (`/tell me about (the )?(culture|team|company)/i`, `/what('?s| is) it like/i`, `/day in the life/i`); any `mutualFitTalkingPoints` lacks `grounding`. Add a `final` branch to `stage-focus-grader.ts` (fail on missing `finalPrep`). Strip nothing new in `schema-grader.ts` unless run-coach injects a coverage field (it doesn't for final — skip). Wire `finalGrader` into `coach-evals.test.ts` grader list + an 8-case unit test `final-grader.test.ts`.

- [ ] **Step 5: verify + commit** — `yarn workspace @bedrock/job-strategist test` green (final fixture passes its graders). `git commit -m "feat(final): stage prompt + registration + per-phase eval"`

---

## Task 4: run-coach wiring

**Files:** Modify `applications/job-strategist/src/run-coach.ts`, `applications/job-strategist/src/agents/coach-agent.ts` (the `finalBlock` param thread)

- [ ] **Step 1: `buildFinalInputs(env, research)`** — minimal (no DB load beyond coach's existing context): assemble a "Career arc + role-fit context" string from `research` (strengths/gaps) + the JD/company in `env`. Return `{ block: string }`. Fail-open (warn + empty block).

- [ ] **Step 2: thread a dedicated `finalBlock` param** — mirror `barRaiserBlock`: add `finalBlock?: string` to `CoachAgentInput`, append its own prompt section in `buildCoachMessage` (own `##` header), pass through `executeCoachAgent`.

- [ ] **Step 3: wire `main()`** — for `interviewStage === 'final'` (guard via `stageUsesFinalPrep`), call `buildFinalInputs`, pass `fin.block`; after the agent call, `coaching.data.finalPrep = validateFinalPrep(coaching.data.finalPrep)`. Existing grounding+prose verifiers unchanged.

- [ ] **Step 4: verify + commit** — `yarn workspace @bedrock/shared build && yarn workspace @bedrock/job-strategist typecheck && yarn workspace @bedrock/job-strategist test && yarn workspace @bedrock/job-strategist build` all green; ESLint clean (factor a helper if `main()` trips complexity). `git commit -m "feat(final): run-coach wiring (build inputs + validate)"`

---

## Task 5: Dogfood

- [ ] **Step 1: merge the backend PR** → job-strategist redeploys with the `final` stage (no migration needed).
- [ ] **Step 2: run the `final` coach** against the Stripe app `c2156165-cb33-48ee-95d2-cfcdabc20b98` (UI trigger as owner). Inspect persisted `finalPrep`.
- [ ] **Step 3: quality gate** — why-this-role reads true to the actual career arc (not generic enthusiasm), questions are company/role-specific, long-term framing honest. Iterate `FINAL_DELTA` against the eval until: *would you walk into a founder/exec round with this?*

---

## Task 6: FinalWorkspace render (tucaken-app)

**Files:** Modify `src/lib/types/applications.types.ts`, `src/features/applications/stages/workspaces/FinalWorkspace.tsx`; Test `src/__tests__/features/applications/stage-components.test.tsx`

- [ ] **Step 1: types** — add `FinalTalkingPoint`, `FinalQuestion`, `FinalPrep` to `applications.types.ts`; extend `InterviewPrepOutput` with `finalPrep?: FinalPrep` (next to `barRaiserWalkthrough?`).

- [ ] **Step 2: render** — in `FinalWorkspace.tsx`, read `const prep = resolveStagePrep(detail,'final'); const finalPrep = prep?.finalPrep ?? null`. Add a `FinalPrepGroup` sub-component (mirror `BarRaiserWalkthrough` structure): a `SummaryGroup` "Pre-final-round prep" rendering the why-this-role narrative (`whitespace-pre-line`), mutual-fit talking points (point + muted grounding), substantive questions (question + muted rationale), long-term framing. Render it ABOVE the existing offer/leverage/decision groups when `finalPrep` exists. Keep the offer/leverage/decision groups unchanged. Factor sub-components to stay under complexity:10.

- [ ] **Step 3: test** — add a `FinalPrep` describe block to `stage-components.test.tsx`: render a `finalPrep` and assert the narrative, a talking point + its grounding, a substantive question, and long-term framing appear.

- [ ] **Step 4: verify + commit + PR (base main)** — `yarn typecheck`, `npx eslint <changed>`, `yarn test stage-components` all green. `git commit -m "feat(final): render pre-final-round prep in the workspace"`

---

## Self-review notes
- Spec coverage: schema §2→T1; validation §2→T2; prompt+eval §2/§4/§6→T3; wiring §2→T4; dogfood §6→T5; UI §2→T6. All covered.
- No migration task — correct (spec §2: final grounds in existing context, no ontology).
- Anti-generic enforcement lives in BOTH the prompt (T3 step 1) AND the deterministic grader's blocklist (T3 step 4) — defence in depth.
- Honesty discipline (§4) enforced by the prompt + the existing grounding/prose verifiers (run every stage) — no new detector needed.
- Type names consistent: `FinalPrep`/`FinalTalkingPoint`/`FinalQuestion`/`finalPrep`/`FINAL_FIELDS`/`buildFinalInputs`/`validateFinalPrep`/`stageUsesFinalPrep`/`finalBlock`/`finalGrader` throughout.
- Deferred items (market data, messages, offer backend) have NO tasks — correct (Phases 2-4).
