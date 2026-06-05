# Bar Raiser stage — Phase 1 (project-anchored, honesty-calibrated walkthrough) — design

**Date:** 2026-06-05
**Status:** Design — approved (Phase 1 boundary)
**Repos:** ai-applications (coach stage, ontology, grounding, schema, migration) + tucaken-app (workspace UI)
**Scope:** A dedicated `bar-raiser` coach stage that maps the user's **real project evidence** to a company's leadership principles, surfaces **grounded** stories per principle, and — the differentiator — generates **honesty calibration** (what holds up vs. what to frame carefully under probing) and **honest gap framing**. Amazon's 16 LPs + a generic fallback. **No metric validation, no 20-company taxonomy** (deferred to Phases 2-3).

This mirrors the **System Design walkthrough** pattern (ontology → project-anchored grounding → coach stage → validation → workspace), which is built and proven. The novel work is the honesty-calibration prompt.

## 1. Why Phase 1 looks like this

Confirmed greenfield: no `bar-raiser` coach stage, no metric-integration layer, no automated story-mining agent, no leadership-principles data. So metric validation (needs integrations) and the full company taxonomy (curated content) are out of Phase 1. What *is* available and reused: the System Design pattern, the `project_*` evidence tables, `story_candidates` (migration 064), the grounding/anti-invention discipline, and the coach pipeline (run-coach, schema, grounding + prose verifiers).

Bar Raiser is the round where over-claiming gets caught; Tucaken's evidence-grounded positioning is most defensible here. So Phase 1's load-bearing feature is **honesty calibration**, not breadth.

## 2. Architecture (mirrors System Design)

**Migration `066_leadership_principles.sql`** — ontology table, same shape as `system_design_concerns` (065):
```sql
CREATE TABLE IF NOT EXISTS leadership_principles (
  id              TEXT PRIMARY KEY,           -- e.g. 'amazon.customer_obsession'
  framework       TEXT NOT NULL,              -- 'amazon' | 'generic'
  name            TEXT NOT NULL,              -- 'Customer Obsession'
  interpretation  TEXT NOT NULL,              -- what it ACTUALLY means at this company (not marketing)
  signal_keywords TEXT[] NOT NULL DEFAULT '{}',-- tokens that map project evidence → this principle
  story_shapes    TEXT[] NOT NULL DEFAULT '{}',-- the kinds of stories that demonstrate it well
  probing_patterns TEXT[] NOT NULL DEFAULT '{}',-- how interviewers typically probe it
  failure_modes   TEXT[] NOT NULL DEFAULT '{}',-- how candidates typically misframe it
  display_order   INT NOT NULL DEFAULT 0
);
```
Seed: Amazon's **16 LPs** (curated interpretations + probing patterns + failure modes) + a **generic fallback** set (~6: leadership, decision-making, conflict, growth, impact, integrity) for unknown companies. Idempotent (`INSERT … ON CONFLICT DO NOTHING`).

**`RdsLeadershipPrinciplesRepository`** (job-strategist) — `load(framework)`: returns the company's principles, falling back to `'generic'` when the company has no curated framework. Company→framework resolution: a small map (`amazon`→`amazon`, else `generic`) — extended in Phase 3.

**Coach stage `prompts/coach/stages/bar-raiser.ts`** — `BAR_RAISER_DELTA` (phase-specific prompt per CLAUDE.md §1). Given a "Leadership principles for THIS role" block (principles + the user's detected per-principle evidence), instruct the model to emit one `barRaiserPrinciple` card per principle:
- `interpretation` (copy from block), `evidenceRefs` (only the listed ids — invent nothing),
- `stories[]`: grounded STAR-shaped stories from the cited evidence (title, situation, task, action, result, evidenceRefs). `null`/empty when no evidence.
- **`honestyCalibration`**: for each story, what holds up vs. what to frame carefully (solo work not "led a team"; estimate vs. measured number; timeline accuracy). Never inflate.
- `probingQuestions[]`: likely probes (from `probing_patterns`) + honest framing.
- `seniorityNote`: does the evidence read at the target level; how to frame up/down honestly.
- `gapGuidance`: when no evidence — honest "haven't demonstrated this; adjacent evidence is X; don't fabricate" framing.

**Schema** — extend `COACH_TOOL` + `CoachOutputSchema` (coach-agent.ts) with optional `barRaiserWalkthrough: BarRaiserPrinciple[]`; add bar-raiser's required fields to `coachToolForStage`. Per CLAUDE.md §3 (per-phase schema).

**Grounding** (`bar-raiser-grounding.ts`, mirrors `detectConcernEvidence` + `validateSystemDesignWalkthrough`):
- `detectPrincipleEvidence(principles, projectEvidence, jdText)` → per-principle coverage (strong/partial/none, evidenceRefs, relevantToJd) via token/signal overlap over the user's project evidence (`project_components`, `story_candidates`, repo signals).
- `validateBarRaiserWalkthrough(cards, coverage)` → anti-invention: every story's `evidenceRefs ⊆ detected`; demote ungrounded stories to gap framing; never let a fabricated team-leadership story survive.

**run-coach wiring** — `buildBarRaiserInputs(pool, env, research)` (like `buildSystemDesignWalkthroughInputs`): load principles for the company, detect evidence, build the prompt block; after the model call, `validateBarRaiserWalkthrough` + attach `barRaiserCoverage` (code-authoritative). Runs the existing grounding + prose verifiers (flag mode).

**Workspace UI** (tucaken-app `BarRaiserWorkspace.tsx`) — read `resolveStagePrep(detail,'bar-raiser').barRaiserWalkthrough`; render per-principle cards: name + interpretation + coverage badge (🟢/🟡/🔴), grounded stories (STAR), **honesty-calibration callouts**, probing questions, seniority note, gap guidance. Reuse `Card`/`SummaryGroup` + the System Design renderer patterns. Keep the existing user story bank as a secondary section.

## 3. Output shape (`BarRaiserPrinciple`)
```ts
interface BarRaiserStory {
  title: string; situation: string; task: string; action: string; result: string
  evidenceRefs: EvidenceRef[]
  honestyCalibration: string   // what holds up vs. what to frame carefully
  seniorityNote: string
}
interface BarRaiserPrinciple {
  principleId: string; principleName: string; interpretation: string
  coverage: 'strong' | 'partial' | 'none'
  stories: BarRaiserStory[]            // [] when coverage = none
  probingQuestions: { question: string; framing: string }[]
  gapGuidance: string | null           // set when coverage = partial/none
}
```
Plus `barRaiserCoverage: { relevantTotal, relevantAddressed }` (code-authoritative).

## 4. Honesty calibration — the load-bearing feature

This is the differentiator and the hardest prompt. The model must, per grounded story, surface the *weakest-under-probing* parts honestly:
- "Your commits show the work, but no evidence of formal team leadership — frame as 'I drove/owned', not 'I led a team'."
- "The cost number is your estimate, not measured — be ready to say it's approximate."
- "The incident was open 6 days before your first commit — frame your contribution to that arc accurately."

It must **never** soften toward inflation. Per CLAUDE.md §5, this ships with a **per-phase eval**: 5-10 hand-written calibration examples from real project stories as both prompt few-shots and the eval set; no prompt change ships without re-running it. Sonnet (CLAUDE.md §4).

## 5. Anti-invention (non-negotiable)
- Never generate a story not grounded in real evidence. Surface + draft + calibrate; never invent.
- Solo work → technical-leadership / decision-ownership / self-direction stories (real, respected); **never** fabricated team-management stories.
- No "Bar Raiser score" gauge.
- Where evidence is absent, honest gap framing — not a manufactured story.

## 6. Testing / validation
- Unit: `detectPrincipleEvidence` + `validateBarRaiserWalkthrough` (grounded vs gap, anti-invention demotion).
- Per-phase eval: honesty-calibration grader (no inflation, grounded to evidence, honest gaps) + a stage-focus grader entry (`barRaiserWalkthrough` non-empty when evidence exists). Mirrors `stage-focus-grader.ts`.
- **Dogfood gate:** run the full pipeline against the owner's portfolio targeting **Amazon**. Pass = stories from real work mapped to the 16 LPs, honest calibration, predictable gaps (team-leadership for solo work) with graceful framing. Bar: *would you take this into a real Amazon Bar Raiser?*

## 7. Out of scope (later phases)
- **Metric validation** (Phase 2 — needs the Cost Explorer/Grafana integration + 3-tier metric model, which don't exist).
- **20-company taxonomy** (Phase 3 — curated content; Phase 1 = Amazon + generic).
- AI-judgment dimension, seniority-overlay depth, practice mode, story reuse with behavioural (Phase 4).
- No new metric/integration code in Phase 1.

## 8. Implementation order (Phase 1 → its own writing-plans)
1. Migration `066` + seed (Amazon 16 LPs + generic) + `RdsLeadershipPrinciplesRepository` + unit test.
2. `detectPrincipleEvidence` + `validateBarRaiserWalkthrough` + unit tests (the grounding spine).
3. Schema: `barRaiserWalkthrough` in `COACH_TOOL` + Zod + `coachToolForStage`.
4. `bar-raiser.ts` `BAR_RAISER_DELTA` + honesty-calibration few-shots + the per-phase eval.
5. `buildBarRaiserInputs` + run-coach wiring (validate + attach coverage).
6. Dogfood run vs Amazon; iterate the calibration prompt against the eval.
7. tucaken-app `BarRaiserWorkspace` rendering + types (mirrors System Design UI).

Each is a focused PR; the calibration prompt (step 4) is the longest pole.
