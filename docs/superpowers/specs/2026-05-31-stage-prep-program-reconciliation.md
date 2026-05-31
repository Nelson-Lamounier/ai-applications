# Interview Stage-Prep — Program Reconciliation

> **Date:** 2026-05-31
> **Status:** Reconciliation doc — supersedes the original "stage prep" proposal.
> **Purpose:** Correct the proposal against the ACTUAL codebase (verified by two
> read-only code surveys, 2026-05-31), so build order is decided on facts, not
> assumptions. **No code in this doc** — it captures what exists, what's missing,
> the key fork, and a sequenced plan.

## TL;DR

The original proposal framed stage-prep as a 9–12 week greenfield program. **Most
of it already exists.** Stages, workspaces, a per-stage Coach Agent, persisted
per-stage prep (`coaching_content`), admin-api endpoints, evidence indicators, and
stage navigation are all built. The real gap is **one wiring disconnect + three
genuinely-missing pieces**, not a new architecture.

**The central unresolved issue:** two parallel per-stage prep data sources were
built and never reconciled —
- **(a) Coach Agent → `coaching_content`** — LLM coaching brief (questions,
  prep checklist, questions-to-ask). Persisted + served by admin-api. **Rendered
  nowhere.**
- **(b) Research Agent → verified/partial/gap matches** — evidence-grounded topic
  data. **This is what `TechnicalWorkspace` actually renders.**

Deciding (a) vs (b) as source of truth is the first decision; everything else
follows.

---

## What ALREADY EXISTS (verified)

| Component | Status | Evidence |
|-----------|--------|----------|
| **Coach Agent** (per-stage, structured output: technicalQuestions, behaviouralQuestions, difficultQuestions, technicalPrepChecklist, questionsToAsk, coachingNotes; Haiku 4.5) | **Works** | `applications/job-strategist/src/agents/coach-agent.ts` |
| **Coach Job** (loads strategist analysis from `pipeline_runs.metadata`, runs Coach per `interviewStage`, persists) — this IS the "StagePrepOrchestrator" the proposal wanted | **Works** | `applications/job-strategist/src/run-coach.ts`; persist in `lib/pipeline-runs.ts` `persistCoachingContent()` |
| **`coaching_content` table** (per `(job_application_id, stage_type)`, UPSERT; topics_to_study / expected_questions / personal_highlights / source_chunk_ids) | **Works as store** | `platform-rds-bootstrap/src/bootstrap.ts:136` |
| **admin-api endpoints** — `GET /:slug` (detail incl. `coaching[stage]`), `GET /:slug/coaching/:stage`, `POST /:slug/coach` (dispatch Coach Job) | **Works** | `tucaken-app/admin-api/src/routes/applications.ts` |
| **kanban_status lifecycle** (`analysing → analysis-ready`, plus interview-prep/applied/interviewing/offer/...) | **Works** | `run-pipeline.ts`; admin-api status enum |
| **Stage UI** — Applied (full), Phone Screen + Technical (partial), others scaffolded; StageProgressBar; `?stage=` routing | **Partial** | `tucaken-app/src/features/applications/stages/**` |
| **TechnicalWorkspace** renders topics from `detail.research` (verified/partial/gap), with EvidenceIndicators + project-ref stubs | **Works** | `features/applications/stages/workspaces/TechnicalWorkspace` |
| **Grounding verifier** (`block | pass` modes) — the proposal's "verification pass" | **Exists, in use** | `applications/shared/src/grounding/bedrock-grounding-verifier.ts` |
| **Retrieval** — `PgVectorRetriever`, `BedrockReranker` | **Exists** | `applications/shared/src/retrieval/implementations/` |
| **Strategist analysis (JD analysis)** the proposal says "feeds stage prep" | **Works** | `run-pipeline.ts` → `pipeline_runs.metadata` + `resumes.tailored` |
| **Project ontology pattern** (global archetype/overlay tables, 046) to mirror for a stage-expectations ontology | **Exists** | `migrations/046_project_ontology.sql` |
| **Written UI spec** for all 7 stages | **Exists** | `tucaken-app/build-stage-worflowspaces.md` |

## Proposal claims that were WRONG / out of date

- "Need a new orchestrator" → `run-coach.ts` already is one (per-stage, composes Strategist analysis + Coach Agent).
- "Reuse writer agent / extraction agents" → **no writer agent**; only `ProfileExtractor` + the synthesizers. research/strategist/coach are the real agents.
- "Build the verification pass — most expensive, do later" → **already built and in use** (`BedrockGroundingVerifier`). Lowest-cost, not highest.
- "Build stage_prep_data table" → `coaching_content` already covers most of it.
- "Build the UI + endpoints" → UI shells + several endpoints already exist; the spec is written.

## What is GENUINELY MISSING

1. **The wiring disconnect (highest leverage, smallest):** `coaching_content` is
   generated + served but **no workspace renders it**. Workspaces render
   Research-derived data instead. Either wire coaching_content in, or formally
   choose Research as the source and stop generating the unused coaching brief.
2. **Story bank + StoryMiningAgent** (Behavioural + Bar Raiser): no `user_story_bank`,
   no mining agent. The one real new agent. Carries the honesty risks below.
3. **Stage-expectations ontology** (global reference data): stage × company-type
   expectations, common question patterns, leadership-principle taxonomies,
   STAR scaffolds, comp benchmarks, gap-handling templates. Mirror migration 046.
4. **Advance-stage flow + per-stage user state** (checked questions, schedule,
   notes persistence): `POST /:slug/advance` shape exists; per-stage editable
   state (ChecklistItem checks, notes timeline) is partial. `interview_stages`
   table exists but is **completely unused** (candidate home for per-stage state).

## The fork that blocks everything: coaching_content vs research-derived

Two prep sources exist. They must be reconciled before building more, or the
duplication compounds.

- **Option A — Research-derived is canonical** (matches current TechnicalWorkspace +
  the UI spec's evidence-indicator model). Then `coaching_content`/Coach Agent
  becomes either (i) supplemental context layered into a workspace section, or
  (ii) deprecated. Pro: evidence-grounded, matches shipped UI. Con: Coach Agent's
  question-framework output is genuinely useful and would be demoted.
- **Option B — coaching_content is canonical** per-stage prep, workspaces render it,
  Research feeds the Coach as input. Pro: reuses the working Coach pipeline +
  endpoints; one source. Con: it's LLM prose, less structurally grounded than the
  research matches; the spec's EvidenceIndicators want structured evidence, so
  coaching_content schema would need structuring.
- **Option C — explicit split:** Research-derived = the *evidence* surface (topics,
  indicators, project refs); coaching_content = the *coaching* surface (question
  frameworks, questions-to-ask, coaching notes). Each workspace renders both, from
  its natural source. Pro: no demotion, each agent does what it's best at. Con:
  two sources to keep coherent per stage.

**Recommended: Option C** — it's the only one that wastes nothing already built,
and the UI spec's sections actually split this way (Technical: "Topics" [evidence]
+ "Practice" [coaching]; Behavioural: story bank [new] + "Typical questions"
[coaching]). The wiring task then = render coaching_content in the "coaching"
sections, keep Research in the "evidence" sections.

## Pre-seeded reference data (the proposal's Q2) — verdict stands, scoped

Build as **structural constraint** (mirrors the project-ontology decision):
stage × company-type expectations, common question *patterns* (not questions),
leadership-principle taxonomies, STAR scaffolds, comp benchmarks, gap-handling
templates. **Skip as example content:** "top 100 questions", sample STAR stories,
"what FAANG wants in 2026", pre-generated per-company prep. Same rule as projects:
constraint good, example content bad. Implement as a global ontology table pair
mirroring `project_archetypes`/`project_stage_overlays` (migration 046), frozen +
versioned.

## StoryMiningAgent — honesty risks (the proposal's strongest real warning)

Genuinely new + genuinely risky. Mitigations are non-negotiable:
- Mine only commits the user authored (`git log --author` / author-filtered).
- Hedged language ("based on this commit, you may have…"), never "you led…".
- Every draft marked **"draft — verify accuracy"** until user approves.
- "Practice telling this" must require explicit accuracy confirmation first.
- Over-attribution (inventing drama from a terse commit) + mis-attribution
  (crediting a teammate's work) both catastrophic to the evidence-based
  positioning → the grounding verifier must check author + file existence.

## Recommended sequence (corrected, much shorter than the proposal's 9–12 wks)

1. **Decide the fork (Option C).** Then **wire coaching_content into the Phone
   Screen + Technical "coaching" sections** (it's generated + served, just unrendered).
   Smallest, highest-leverage, ships visible value. ~days.
2. **Advance-stage flow + per-stage user state** — persist checked items / notes /
   schedule; trigger the Coach Job on advance (instead of manual POST). Repurpose
   the unused `interview_stages` table for per-stage state. ~1 wk.
3. **Stage-expectations ontology** (migration + seed, mirror 046) — feeds Coach
   prompts as constraints. ~few days curation + 1 small PR.
4. **Story bank + StoryMiningAgent** (Behavioural) — new table + agent + workspace,
   with the honesty mitigations. Reusable across applications. ~2 wks.
5. **Remaining stages** (System Design [reuse Projects domain — decisions/tradeoffs
   already detected], Bar Raiser [re-tag story bank vs leadership principles],
   Final [comp benchmarks + negotiation]) — each ~1 wk once 1–4 prove the pattern.

Each step is its own spec → plan → PR (this doc is the program map, not a single
spec). Step 1 is the natural "next implementation" and the only one that needs no
new schema or agent.

## Out of scope / explicitly skip

- A second orchestrator (run-coach already is one).
- Rebuilding the grounding verifier (extend if needed; it works).
- Example-content reference data (question banks, sample stories).
- Pre-generated per-company prep caches (not personalized; ages out).
