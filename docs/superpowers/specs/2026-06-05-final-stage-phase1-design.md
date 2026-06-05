# Final stage — Phase 1 (pre-final-interview prep) — design

**Date:** 2026-06-05
**Status:** Design — approved (Phase 1 boundary)
**Repos:** ai-applications (coach stage, schema, prompt, eval, wiring) + tucaken-app (workspace render)
**Scope:** A dedicated `final` coach stage producing **grounded pre-final-interview prep** (Phase A of the Final journey): a "why this role" narrative anchored to the user's real career arc, mutual-fit talking points, substantive company/role-specific questions, and an honest long-term framing. **No market data, no drafted messages, no offer-model backend** (deferred to Phases 2-4).

Mirrors the proven coach-stage pipeline (bar-raiser / system-design): phase-specific prompt → per-phase schema → grounding/anti-invention → run-coach wiring → workspace render. **Lighter than bar-raiser** — no ontology table/migration; it grounds in context the coach already receives (career arc, JD, research output).

## 1. Why Phase 1 looks like this

The Final journey has 5 phases (pre-final interview, offer, negotiation, multi-offer, closing). Only **Phase A (pre-final interview prep)** is buildable now without new infra: market data (Adzuna) doesn't exist, drafted messages need a separate message-compose+stop-slop pass, the offer model is client-only (`useOfferDraft`, localStorage). The existing FinalWorkspace already scaffolds offer capture + leverage + decision actions; Phase 1 adds the missing coach-generated *prep* surface for the pre-offer state.

Confirmed greenfield: no `final` coach stage (5 stages exist: phone-screen, technical, system-design, behavioural, bar-raiser). `final` IS already a dispatchable prep stage (`INTERVIEW_PREP_STAGES`), so it currently falls back to the base prompt → generic output.

## 2. Architecture (mirrors bar-raiser, minus the ontology)

**No migration.** Unlike bar-raiser/system-design, final prep is not a taxonomy match — it grounds in the user's career arc + JD + research evidence the coach context already carries (`careerArcSummary` exists today in the phone-screen schema; `research` strengths/gaps; analysis).

**Coach stage `prompts/coach/stages/final.ts`** — `FINAL_DELTA` (phase-specific prompt, CLAUDE.md §1). Given the candidate's career arc, the JD, and the research output (strengths/gaps), emit a single `finalPrep` object:
- `whyThisRole`: a narrative anchored to the user's **real** career arc and the role's fit — *why this role, why now*. Drawn from `careerArcSummary` + JD overlap. **No fabricated passion**; if the genuine fit is "this role advances X capability you've demonstrated," say that — not manufactured enthusiasm.
- `mutualFitTalkingPoints[]`: `{ point, grounding }` — each talking point cites the real evidence/career fact it rests on.
- `substantiveQuestions[]`: `{ question, rationale }` — specific to the company/role/team (demonstrate research/intentionality), NOT generic "tell me about culture."
- `longTermFraming`: honest 1-3yr framing of what the user wants from the role — grounded, not aspirational fluff.

**Schema** — extend `COACH_TOOL` + `CoachOutputSchema` (coach-agent.ts) with optional `finalPrep: FinalPrep`; add `FINAL_FIELDS = ['finalPrep']` + `coachToolForStage` `final` branch (the `STAGE_REQUIRED_FIELDS` map bar-raiser added). Per CLAUDE.md §3. Add `finalPrep?` to `InterviewCoachResult` (shared `strategist-types.ts`) + a `FinalPrep` type in `@bedrock/shared` `stage-prep/final-types.ts` (mirrors how bar-raiser types live in shared).

**Grounding** — lighter than bar-raiser. No `detect…Evidence` (no taxonomy). The existing **grounding + prose verifiers run for every stage** (flag mode) and cover hallucination + slop. Add a focused `validateFinalPrep(prep)` only for shape/anti-generic hygiene (e.g. drop empty talking points; ensure `substantiveQuestions` non-empty). The career-arc grounding is enforced by the prompt + the existing grounding verifier, not a new detector.

**run-coach wiring** — `buildFinalInputs(env, research)` is minimal: assemble a "Career arc + role fit context" block from the analysis/research already loaded (no DB load beyond what coach already does). For `interviewStage === 'final'`, pass the block; after the call, `validateFinalPrep`. Fail-open like the other stages.

**Workspace UI** (tucaken-app `FinalWorkspace.tsx`) — in the **pre-offer state**, read `resolveStagePrep(detail,'final').finalPrep` and render a prep section ABOVE the existing offer/leverage/decision scaffold: the why-this-role narrative, mutual-fit talking points (point + grounding), substantive questions, long-term framing. Reuse `Card`/`SummaryGroup`. Keep the offer/leverage/decision groups unchanged. (State detection beyond "has offer figures" is deferred; Phase 1 simply shows prep when `finalPrep` exists.)

## 3. Output shape (`FinalPrep`)
```ts
interface FinalTalkingPoint { point: string; grounding: string }
interface FinalQuestion { question: string; rationale: string }
interface FinalPrep {
  whyThisRole: string
  mutualFitTalkingPoints: FinalTalkingPoint[]
  substantiveQuestions: FinalQuestion[]
  longTermFraming: string
}
```

## 4. Honesty discipline (the differentiator)
Same discipline as bar-raiser, applied to fit/enthusiasm:
- **No fabricated passion/fit.** Ground "why this role" in demonstrated capability + genuine trajectory fit, not manufactured enthusiasm.
- **No invented company knowledge.** Substantive questions reflect the JD/research provided — don't fabricate product details the model doesn't have.
- **Honest long-term framing.** What the user actually wants, not what sounds impressive.
- Per CLAUDE.md §5, ships with a **per-phase eval**: a deterministic grader checking `finalPrep` present, `substantiveQuestions` non-empty + non-generic (flag generic phrases like "tell me about the culture"), talking points carry `grounding`. Sonnet (§4).

## 5. Anti-invention (non-negotiable)
- `whyThisRole` + talking points must rest on real career-arc/research facts (enforced by the existing grounding verifier + the prompt).
- No "fit score" gauge.
- No fabricated competing-offer or company-internal claims (those belong to later negotiation phases and are explicitly out of scope here).

## 6. Testing / validation
- Unit: `validateFinalPrep` (drops empty points; requires non-empty questions).
- Per-phase eval: `final-grader.ts` (deterministic, no LLM) — `finalPrep` present, questions non-empty + non-generic, talking points have grounding, narrative non-empty. Add a `final` branch to `stage-focus-grader.ts`. Fixture `final.json`.
- **Dogfood gate:** run the `final` coach against the owner's portfolio for the existing Stripe app. Pass = a why-this-role narrative that reads as *true to the actual career arc* (not generic enthusiasm), company/role-specific questions, honest long-term framing. Bar: *would you walk into a founder/exec round with this?*

## 7. Out of scope (later phases)
- **Market data / Adzuna** (Phase 2 — doesn't exist).
- **LLM-drafted negotiation/accept/decline messages** (Phase 3 — message-compose + stop-slop; replaces the current hardcoded templates).
- **Backend offer model, multi-offer comparison, references, EU-specifics** (Phase 4; user defers multi-offer to v2).
- No changes to `useOfferDraft`, `negotiationLeverage`, or the decision actions in Phase 1.

## 8. Implementation order (Phase 1 → writing-plans)
1. Schema: `finalPrep` in `COACH_TOOL` + Zod + `FINAL_FIELDS` + `coachToolForStage`; `FinalPrep` shared type + `InterviewCoachResult.finalPrep?`.
2. `validateFinalPrep` + unit test.
3. `final.ts` `FINAL_DELTA` + register in `stages/index.ts`; per-phase eval (`final-grader.ts` + `final.json` + stage-focus branch).
4. `buildFinalInputs` + run-coach wiring (pass block, validate).
5. Dogfood vs the Stripe app; iterate the narrative prompt against the eval.
6. tucaken-app `FinalWorkspace` render (pre-offer prep section) + types + test.

Each is a focused PR; the why-this-role narrative prompt (step 3) is the longest pole (slop-free, grounded).
