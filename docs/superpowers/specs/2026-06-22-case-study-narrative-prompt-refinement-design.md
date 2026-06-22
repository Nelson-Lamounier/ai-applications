# Case-Study Prompt Refinement — Combined Overview, Work-Led Narrative

- **Date:** 2026-06-22
- **Status:** Design approved, awaiting spec review
- **Owner:** Nelson Lamounier
- **Relates to:** PR #320 (display-side grounding — separate work)

## Problem

The project case study reads as a set of per-repo fragments organised around
the tech stack, in a hedged voice that undersells real, evidenced work. The
recent "unproven claims" perception was largely a display artefact — the
grounding verifier flagging rows red — and PR #320 fixes the display side
(cited rows show GROUNDED, the SBOM stack shows GROUNDED via file:line proof).

What remains is a **narrative-structure** problem in the case-study system
prompt: *how the agent writes*. Four directives:

1. **Combined overview** — synthesise one coherent project story across all
   repositories and components, not per-repo fragments. The pitch leads with
   what the combined product is and does.
2. **Work + collaboration lead** — the engineering narrative
   (decisions/challenges/highlights) is driven by what the commits and pull
   requests show was built, and by whom. The work and the collaboration are
   the spine.
3. **Tech assists** — `verifiedStack` is the tech the work *used* (a grounding
   aid for the stack section), not the thing the narrative is organised around.
   Keep the existing "stack MUST be drawn from verifiedStack" constraint, but
   demote tech from a narrative lead to a grounding aid.
4. **Confident voice** — narrate real, evidenced work plainly; drop hedged
   "claimed" phrasing.

Per the repo rule **"No prompt change ships without its eval"**, this ships as
its own spec with a per-phase eval — separate from the grounding PR.

## Goals

- Output reads as one combined product story, not repo-by-repo fragments.
- Engineering sections are led by the work the commits/PRs show was built and
  by whom (commit + PR author).
- Tech is demoted from narrative spine to grounding aid; the
  "drawn-from-verifiedStack" constraint is preserved.
- Voice is confident and plain, free of hedging.
- A per-phase eval verifies all four directives before merge.

## Non-goals (explicitly out of scope)

- **Reviewer / co-author / who-reviewed-whom ingestion.** Today the only
  collaboration signal ingested is `author_login` on commits and PRs. Deeper
  collaboration (PR reviews, requested reviewers, co-authorship) requires a
  GitHub ingestion add — deferred to a separate spec. This spec leads with
  **authorship-level** collaboration.
- **`merged_by` (merger identity).** Not stored in `repo_pull_requests`. PR
  collaboration here = author identity (`author_login`) + merge timing
  (`merged_at`), not who merged.
- **Display side.** Owned by PR #320.

## Current state (verified against code)

- **System prompt:** `applications/shared/src/projects/case-study-agent.ts`,
  `SYSTEM_PROMPT_TEXT` (lines 63–131). Already leads with product (lines
  68–73) and treats commits/PRs as **citation fodder** under Rule 1 (lines
  76–85), not as the narrative spine. The `verifiedStack` paragraph (lines
  124–131) states the stack "MUST be drawn from these" — a constraint, with no
  demotion of tech from narrative lead.
- **Envelope:** `buildUserMessage` (lines 383–449) serialises `commits` and
  `pulls` into `<project>`. Commit objects carry `authorName` but **not**
  `authorLogin`; pull objects carry **no author field** at all.
- **Loader:** `applications/shared/src/projects/case-study-loader.ts`. Commit
  SELECT (lines 405–418) reads `author_name` but not `author_login`. Pull
  SELECT (lines 422–437) reads `number/title/body/state/merged_at/html_url` —
  no author column.
- **Schema columns exist & are populated.** Migration `045_repo_commits_pulls.sql`
  defines `repo_commits.author_login` (nullable) and
  `repo_pull_requests.author_login` (nullable). Ingestion populates both —
  `RdsRepoActivityStore.upsertPullRequests` writes `author_login` (lines
  144–156), and the commit upsert writes `author_login`. **No migration and no
  ingestion change are required** — the loader simply does not SELECT these
  columns yet.
- **Existing evals (deterministic graders, the repo pattern):**
  - `case-study-product-grader.ts` — `gradeTaglineIsProductFirst`,
    `gradePitchOpensWithProduct`, `gradeNoInfraOpener`. Carries a reusable
    tech-token heuristic.
  - `case-study-refine-grader.ts` — `gradeNewRepoCoverage`, `gradeNoDuplicates`,
    `gradeCaps`, `gradePriorContinuity`.
  - `case-study-verified-stack.eval.test.ts` — SBOM grounding integrity.
  - `scripts/test-projects-case-study.ts` — E2E orchestration test.

## Design

One PR, separate from #320, in three components.

### Component 1 — Prompt edits (`SYSTEM_PROMPT_TEXT`)

All four directives are realised as edits to the system prompt string. No
schema change; the output shape is unchanged.

**D1 — Combined overview.** Add, adjacent to the existing product-lead
paragraph:

> Synthesise ONE coherent project story across all repositories and
> components. Do NOT narrate repo-by-repo. The pitch opens with what the
> combined product is and does as a whole; a member repo's role is mentioned
> only in service of that one story.

**D2 — Work + collaboration lead.** Reframe the commits/PRs role. They are not
just evidence to cite (Rule 1) — they are the spine of the engineering
narrative. Add:

> Lead the engineering sections (decisions, challenges, highlights) with what
> the commits and pull requests show was built, and who built it — the work
> and the collaboration are the spine. Each engineering row narrates real work
> the commits/PRs demonstrate; the author (commit + PR `authorLogin`) is the
> "by whom". Cite that same evidence in `sourceSignals`.

This complements, and does not weaken, the existing Rule 1 citation
requirement.

**D3 — Tech assists.** Keep the existing constraint ("Your `stack` MUST be
drawn from these"); append a demotion:

> `verifiedStack` is the tech the work USED — a grounding aid for the `stack`
> section, NOT the thing the narrative is organised around. Never structure the
> pitch, decisions, or highlights around the tech list; organise them around
> the work and its outcomes, then let the verified tech ground the stack.

**D4 — Confident voice.** Add:

> Narrate real, evidenced work plainly and confidently. The author did this
> work — state it directly. Avoid hedged phrasing ("claimed", "attempted to",
> "appears to") and never use "we built". If a row is grounded enough to
> include, it is grounded enough to state plainly.

### Component 2 — Loader authorship (no migration)

Surface authorship so D2's "by whom" has real data for both commits and PRs.

- **Commits:** add `author_login` to the SELECT in the commit loader; map it to
  `authorLogin` on the commit object.
- **Pulls:** add `author_login` to the SELECT in the pull loader; map it to
  `authorLogin` on the pull object.
- **Types:** add optional `authorLogin?: string | null` to the commit and pull
  shapes in `CaseStudyContext` (and any shared row type used by the loader).
- **Envelope:** no change to `buildUserMessage` structure — `commits` and
  `pulls` are already serialised, so the new field rides along automatically.
- **No migration, no ingestion change** — columns exist and are populated.

`author_login` is nullable (older rows, or GitHub accounts since deleted) — the
prompt and graders must treat absent authorship as "unknown", never fabricate.

### Component 3 — Eval (`case-study-narrative-grader.ts`)

New grader module mirroring `case-study-product-grader.ts` / `case-study-refine-grader.ts`
(pure functions returning `{ pass, ... }`, aggregated by a `runNarrativeGraders`).

**Deterministic graders (CI, Bedrock-free):**

1. `gradeWorkLeadsNarrative` — every `highlight` / `challenge` / `decision`
   carries ≥1 `commit` OR `pull` in `sourceSignals` (work-led, not
   hand-waved). Files-only grounding does not satisfy this grader, because the
   directive is that the *work shown by commits/PRs* leads.
2. `gradeTechNotSpine` — the pitch and highlight titles are not dominated by
   stack tokens. Reuse the tech-token heuristic from `case-study-product-grader.ts`
   (the >50%-tech-tokens check); apply it to highlight titles and the pitch
   body so tech cannot be the organising spine.
3. `gradeConfidentVoice` — no hedge tokens in `pitch` / highlight descriptions
   / decision text. Hedge set: `claimed`, `appears to`, `attempted to`,
   `we built`, `we designed` (case-insensitive, word-boundary). A small
   explicit set, documented inline, to avoid false positives on legitimate
   prose.

**LLM-judge grader (1, env-flagged):**

4. `judgeCombinedOverview` — a single Sonnet judge scoring, 0–1, "does the
   pitch read as one combined product story rather than a list of per-repo
   fragments?" with a documented pass threshold (start at ≥0.7, tune against
   fixtures). Gated behind an env flag (e.g. `CASE_STUDY_EVAL_JUDGE=1`) so the
   deterministic CI suite stays Bedrock-free; live runs (the E2E script)
   include it.

**Wiring:**

- Unit eval test `case-study-narrative-grader.eval.test.ts` with fixtures —
  one "good" case study (combined, work-led, tech-demoted, confident) that
  passes all deterministic graders, and one "bad" fixture per grader that
  fails exactly that grader. Mirrors `case-study-verified-stack.eval.test.ts`.
- `scripts/test-projects-case-study.ts` — run `runNarrativeGraders` on the live
  output and include `judgeCombinedOverview` when the env flag is set; print a
  pass/fail report alongside the existing product/refine grader output.

## Acceptance criteria

- The four prompt edits are present in `SYSTEM_PROMPT_TEXT` and the existing
  product/refine grader suites still pass.
- The loader surfaces `authorLogin` for commits and pulls; a loader unit test
  asserts the new field is selected and mapped (null-safe).
- `case-study-narrative-grader.ts` exists with the three deterministic graders
  + the env-flagged judge, and `case-study-narrative-grader.eval.test.ts`
  passes (good fixture passes all; each bad fixture fails exactly its grader).
- A live E2E run via `scripts/test-projects-case-study.ts` produces a case
  study that passes the deterministic narrative graders and, with the judge
  flag on, clears the combined-overview threshold.
- ESLint clean; no migration introduced.

## Risks & mitigations

- **Hedge-token false positives.** Keep the hedge set small and explicit;
  validate against the good fixture. Tune by example, not by broad regex.
- **Judge threshold drift.** Start at ≥0.7, document it, tune against fixtures;
  the judge is advisory in CI (flagged off) and informative live.
- **Null authorship.** `author_login` nullable — prompt says treat as unknown,
  graders must not require it. `gradeWorkLeadsNarrative` keys on commit/pull
  presence, not on author presence.
- **Prompt regression on product-first framing.** D1–D4 must not weaken the
  existing product-lead behaviour — the product/refine grader suites are the
  regression guard and must stay green.
