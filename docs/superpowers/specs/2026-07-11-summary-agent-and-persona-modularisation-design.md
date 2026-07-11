# Summary Agent + Strategist Persona Modularisation — Design

**Date:** 2026-07-11
**Branch:** `refactor/agent-decomposition`
**Status:** Approved design — pending implementation plan

## Problem

The resume **Summary** underperforms the **Fit Summary**. Root cause: the Fit
Summary is produced by a focused single-purpose call (the Research Agent assesses
fit → one paragraph), whereas the resume Summary is **one field inside a 735-line
fat persona** that emits the entire resume (profile, summary, all experience
bullets, projects, skills, education, certifications) **plus** the cover letter,
**plus** Phase-0 archetype selection, **plus** Phase-3 gap mitigation — all in a
single model call. The summary competes for attention with ~10 other jobs. This
is exactly the "fat prompt navigating branches it shouldn't be on" that the
project's LLM design pattern (`CLAUDE.md` §1) warns against; the Fit Summary is
the in-repo proof that the §1 remedy (one call per unit of work) works.

## Goals

1. **B — Dedicated summary call.** Give the resume Summary its own focused Sonnet
   call, mirroring how the Research Agent produces the Fit Summary. It consumes
   the already-generated resume body + `research.fitSummary` + evidence, returns
   structured beat data, and the deterministic system assembles + guards it.
2. **C — Persona modularisation.** Reorganise the remaining body persona into a
   shared base + per-section modules assembled into the single body prompt
   (`CLAUDE.md` §2 Skills pattern). Behaviour-neutral; sets up future work.
3. Preserve all existing behaviour and guards: altitude/number-sharing rule,
   guard-safe (no gap language) summary, verbatim experience titles, prompt cache.

## Non-goals (YAGNI)

- Splitting experience/projects/skills into separate model calls (full Option A).
  Those are structured, less narrative; they add coherence risk + cost for little
  gain. Do them later, section by section, only if evals show underperformance.
- Extracting the cover letter into its own call. Same pattern applies and is a
  natural follow-up, but out of scope here; keep it in the body call.
- Any runtime feature flag to toggle "body produces the summary" back on — see
  Rollout (C removes the summary rules from the body, so that toggle is a lie).

## Architecture & data flow

### Today (one fat call)
```
Research Agent -> research.fitSummary + verdicts + evidence
   -> Strategist (ONE Sonnet call, 735-line persona)
        -> tailored_resume_json { summary, experience, projects, skills, ... }
           + cover letter + archetype + gaps
   -> guard chain (relocate, guardResume, ensureSummaryIntegrity, ...) -> persist -> render
```

### Proposed (body call, then focused summary call)
```
Research Agent -> research.fitSummary + verdicts + evidence
   -> Strategist BODY call (persona = _base + per-section modules, assembled)
        -> tailored_resume_json { summary: "", experience, projects, skills, ... }   <- summary EMPTY
   -> Summary Agent (NEW dedicated Sonnet call)
        in  <- finished body (bullets/projects) + research.fitSummary + Profile Intel
               + years-gap framing + companyProblem + verified/partial/gap verdicts
        out -> { s1, s2, s3, s4 }   -> system joins -> summary string
   -> splice summary into tailored_resume_json
   -> EXISTING guard chain (ensureSummaryIntegrity, summary-cluster, namesGap, altitude) -> persist -> render
```

**Splice point:** the summary agent runs after roster reconcile
(`run-pipeline.ts` ~L1012) and **before** `relocateProjectExperience` /
`guardResume` (~L1081), so the filled summary passes through every existing
summary guard with **zero new guard wiring**. The summary agent **sees the
finished bullets**, so the altitude/number-sharing rule ("no number shared
between the summary and any bullet") is checkable against real data.

**Data-vs-presentation boundary (design principle):** the model returns
structured **data** only. The summary agent returns beats `{s1,s2,s3,s4}`; the
deterministic system assembles the string, validates, and the renderer
(react-pdf / tucaken HTML) owns presentation. The LLM never produces layout.

## Component: Summary Agent (B)

- **Module:** `agents/writer/summary-agent.ts` — a `BaseAgent` subclass like
  `research-agent` / `strategist-agent` (inherits cost-booking to
  `prompt_invocations`, retries, output sanitisation).
- **Model:** Sonnet (`CLAUDE.md` §4) — nuanced narrative generation, never Haiku.
- **Output schema (§3), beat-structured forced tool** — `SummaryEmitSchema`:
  ```
  { s1: string,   // identity + years framing, aligned to JD role class
    s2: string,   // problem bridge (candidate voice; no company name)
    s3: string,   // distinctive angle from Profile Intelligence / achievement
    s4: string }  // close (rigor-as-shape senior; forward-fit junior)
  ```
  System assembles `summary = [s1,s2,s3,s4].join(' ')`. Beats (not a pre-joined
  string) let the deterministic layer validate/trim each beat and let the eval
  grade each beat independently.
- **Input message:** a dedicated `buildSummaryMessage` passing only what S1–S4
  need — `research.fitSummary` (+ overallFitRating), the finished body
  (experience titles + highlights, project names + highlights), Profile
  Intelligence, years-gap framing, companyProblem, and the verified/partial/gap
  verdicts. Candidate contact is omitted (the summary needs no name).
- **Prompt:** `content/strategist/summary.md` (frontmatter `id/version/cachePoint`,
  own manifest entry). The S1–S4 composition rules + the derive-from-Fit-Summary
  directive + the bans move here **verbatim** from the fat persona.
- **Word cap:** the prompt caps the 4 beats at 100 words total; the existing
  summary guard trims from the middle on overflow (same enforcement as today,
  relocated).

## Component: Persona modularisation (C)

Mirrors the existing `resume-constraints.ts` multi-file assembler.

- **Modules** under `content/strategist/`:
  - `_base.md` — [ROLE], phase framework, global bans/altitude/attribution,
    output XML envelope
  - `archetype.md` — Phase 0 archetype selection
  - `experience.md` — experience rules (verbatim titles, purity)
  - `projects.md` — projects rules (highlights selection, one-entry-per-project)
  - `skills-education.md` — skills / education / certifications
  - `cover-letter.md` — cover letter rules
  - `gaps.md` — Phase 3 gap mitigation
  - `summary.md` — S1–S4 (used by the SUMMARY AGENT, **not** assembled into the body)
- **Assembler:** `strategist-persona.ts` loads `_base` + `[archetype, experience,
  projects, skills-education, cover-letter, gaps]` in order, concatenates bodies
  (preserving `<!-- cache-point -->` markers), `toSystemBlocks`. One body call;
  the assembled text equals today's persona minus the summary section.
- **Versioning:** each module gets its own `prompt-manifest.json` entry
  (version + sha256), integrity-checked as today. The body persona's ledger
  `prompt_version` becomes a **composite derived by the assembler** (hash of the
  module versions), so any module edit changes the version flowing to
  `prompt_invocations` automatically. The summary agent carries its own
  `prompt_version` from `summary.md`, so both calls are independently traceable.
- **Safety net:** a test asserts the assembled body is **byte-identical** to a
  golden snapshot of today's persona (minus the summary section) — C cannot
  silently drop or reorder a rule.

## Eval (§5)

**Design principle:** eval graders **reuse the runtime guard predicates**
(`namesGap`, `numbersIn` from `agents/quality/guards/`), so "eval says good" and
"guard accepts" can never drift.

Offline structural graders (pure, no Bedrock — mirror `evals/research/`):

| Grader | Checks | Reuses |
|---|---|---|
| `groundingToFit` | lead capability consistent with `research.fitSummary`; no `gap`-verdict skill claimed | verdict list |
| `noGap` | `namesGap(summary) === false` (guard-safe) | runtime `namesGap` |
| `altitude` | no summary number appears in any experience/project highlight | runtime `numbersIn` |
| `wordCount` | <= 100 words | — |
| `bans` | no target-company name; no "this role exists to…"; no "portfolio-scale" | runtime ban list |
| `beats` | s1–s4 non-empty; s2 names no employer; s3 distinct from any experience lead bullet | — |

- **Fixtures:** labelled `{ fitSummary, body, profileIntel, verdicts }` inputs ->
  property assertions + a `GOLDEN_SUMMARY_OUTPUT` that passes every grader.
  Includes an **adversarial** case: a `fitSummary` naming a gap ("short of the
  8-yr bar") -> the summary must not echo it (proves translate-not-copy).
- **Live:** (1) the summary flows through the normal pipeline, so the UI JD A/B
  exercises it end-to-end; (2) a gated `run-summary-eval.ts`
  (`RUN_LIVE_EVALS=1`, mirrors `run-research-eval.ts`) runs the real agent
  against a dev user + JD and grades output.

## Rollout, fallback & risks

**Rollout — B and C land together (coupled):** C moves the S1–S4 rules out of the
body persona into `summary.md`, so after C the body call cannot produce the
summary — the summary agent is the sole summariser. Offline evals + the
byte-identical assembled-body snapshot gate the merge; the UI JD A/B validates
live post-merge. Iteration happens on `summary.md` alone.

**Fallback (runtime, always on):** if the summary-agent call fails (Bedrock error
/ schema-invalid after retries), a deterministic fallback builds a guard-safe
minimal summary from `research.fitSummary` (gap language stripped via runtime
`namesGap` sanitiser). A resume never persists with an empty summary. Emit a
`summary_agent_fallback` metric.

| Risk | Mitigation |
|---|---|
| Extra call cost/latency | short output; one Sonnet call; booked to `prompt_invocations` |
| C silently drops/reorders a rule | byte-identical assembled-body snapshot test |
| Bedrock prompt-cache breaks on assembly | assembler preserves `<!-- cache-point -->` boundaries; test asserts markers survive |
| Summary worse for some JD class | offline eval + UI A/B before adoption; iterate on one file |
| Eval says good but guard rejects | graders reuse runtime predicates |
| Empty summary in prod | deterministic guard-safe fallback + metric |

## Consequences

- The v16 `derive-from-Fit-Summary` directive (commit `8b0617b`) migrates from the
  fat persona into `content/strategist/summary.md` — same wording, new home.
- Two model calls per resume (body + summary) instead of one; both traced
  independently in `prompt_invocations`.
- Establishes the focused-call + per-section-module pattern for the writer,
  enabling later per-section splits (cover letter next) when evals justify them.
