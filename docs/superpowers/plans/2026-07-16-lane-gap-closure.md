# Lane Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two live gaps from run 976403b3 (stringified `entries` rejection; enumeration/cue coverage misses) and the tracked-Low cluster from the #493 reviews.

**Architecture:** Spec docs/superpowers/specs/2026-07-16-lane-gap-closure-design.md. Two tasks: T1 = the two live matcher/normaliser fixes + their eval cases; T2 = the tracked-Lows cluster (lock identity, tagline fallback, owed micro-tests).

**Tech Stack:** TypeScript, zod, jest. No new LLM calls; `ats/matching/keyword-match.ts` and `ats/gate/summary-coverage.ts` untouched.

## Global Constraints

- Branch `fix/lane-gap-closure` (exists). ONE commit per task, impact-bullet body, no Co-Authored-By.
- Gates per task: full `yarn workspace @bedrock/job-strategist test` green (growth only from 154 suites / 1360 tests), `tsc --noEmit`, ROOT `yarn eslint <changed files>` (NEW functions complexity <= 10), ASCII-only added lines, UK English.
- NEVER `git stash` (`git show HEAD:<path>`). Fail-open new paths; fail-closed provenance/coverage boundaries preserved (no-cue-no-member-no-term targets stay missing; non-parsable entries still reject).

---

### Task 1: live fixes -- stringified entries + enumeration/cue coverage

**Files:**
- Modify: `applications/job-strategist/src/agents/writer/projects-schema.ts` (`normaliseProjectsAgentOutput`: string `entries` -> JSON.parse -> array substitute + extras+1; parse-fail/non-array -> passthrough)
- Modify: `applications/job-strategist/src/ats/gate/experience-coverage.ts` (`experienceTermMatch` three-shot OR per spec G2: unstemmed matchTier1 pass FIRST, stemmed pass, enumeration rule `base (m1, m2[, etc.])` with any-one-member whole-word credit, lane-local `code` cue + language exemplars -- re-declare the exemplar list locally with a comment naming its source since keyword-match.ts does not export it)
- Test: `.../__tests__/projects-schema.test.ts`, `.../__tests__/experience-coverage.test.ts`, evals (`evals/projects/fixtures.ts` stringified-entries case; `evals/experience/fixtures.ts` enumeration case)

**Interfaces:** `experienceTermMatch` signature unchanged (all callers -- scorer, anchors, projects lane -- inherit the fix). `normaliseProjectsAgentOutput` signature unchanged.

- [ ] **Step 1:** failing tests: entries as stringified array of valid entries -> parsed + normalised + extras counts parse (+1) and any per-item strips; entries as non-JSON string -> passthrough + zod still rejects; entries as stringified NON-array -> passthrough-reject. experienceTermMatch: "scripting (Python, Java, JavaScript, Go, etc.)" vs the live JavaScript tooling bullet -> true (member OR base-cue); "code reading" vs the same bullet -> true (lane cue); "rapid technical learning" vs the self-training line -> STILL false (regression -- no cue/member/term); "Linux systems engineering" vs the Amazon Linux bullet -> still true; unstemmed pass restores cue behaviour ("scripting experience" vs a Python bullet -> true); a memberless cueless target with absent terms -> false.
- [ ] **Step 2:** implement both; run the projects + experience coverage suites, then full gates.
- [ ] **Step 3: Commit** `fix(job-strategist): tolerate stringified agent entries + enumeration/language-cue coverage`

### Task 2: tracked-Lows cluster

**Files:**
- Modify: `applications/job-strategist/src/agents/writer/experience-lock.ts` (`withProjectsDescriptionLock`: name-only matching, index fallback REMOVED, doc comment states name-is-identity + renamed/inserted entries keep the pass's text)
- Modify: `applications/job-strategist/src/agents/evidence/project-agent-inputs.ts` (SELECT gains `COALESCE(p.tagline,'') AS tagline`; types/pool meta carry it), `applications/job-strategist/src/agents/writer/projects-description.ts` + `projects-ats-flow.ts` + run-pipeline stamp site (stamp fallback pitch -> tagline -> '')
- Test: `experience-lock.test.ts` (rename+reorder and insertion cases now assert NO cross-assign), `projects-description.test.ts` (tagline fallback), plus the two owed micro-tests: run-pipeline extras-summation glue (unit around `fillResumeProjects`'s diag assembly if extractable, else a focused test of the exported pieces documenting the glue), `experience-ats-flow.test.ts` rewrite-threw branch asserts `provenance.dropped` propagates.

- [ ] **Step 1:** failing tests per file above.
- [ ] **Step 2:** implement; full gates.
- [ ] **Step 3: Commit** `fix(job-strategist): description-lock name identity + tagline fallback + owed coverage tests`

---

## Self-Review

**Spec coverage:** G1+G2 -> T1 (incl. both live eval cases); G3 (a)(b)(c) -> T2. Fail-closed constraints restated in Global Constraints. **Placeholder scan:** clean -- semantics, patterns, and regression cases named. **Type consistency:** signatures unchanged across both tasks; tagline threading named at each hop.
