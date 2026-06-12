# JD Agent Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** One JD agent owns all JD understanding; the research agent becomes a KB-matcher. `StrategistResearchResult` keeps its shape (assembled from `{...jdSignal, ...matching}`) so everything downstream of the assembly is unchanged.

**Architecture:** Extend `jd-extractor` → JD agent emitting `JdSignal` (requirements + techInventory + experienceSignals + keywords). Slim `research-agent` to a matcher that receives `JdSignal` and emits only verified/partial/gap/fit/kbContext. run-pipeline assembles `research = {...jd, ...matching}`.

**Tech Stack:** TypeScript (NodeNext ESM, `.js`), Zod, Bedrock Haiku forced-tool (`runAgent`), Jest (ts-jest CJS). Build shared: `cd applications/shared && npx tsc --build`.

**Spec:** `docs/superpowers/specs/2026-06-12-jd-agent-consolidation-design.md`. Branch `feat/jd-agent-consolidation` (off develop).

**Parity guardrail:** after the refactor, the assembled `research` object must be shape-identical to today's `StrategistResearchResult` — the strategist contract is unchanged.

---

### Task 1: `JdSignal` type in shared

**Files:** Modify `applications/shared/src/strategist-types.ts`; export from `applications/shared/src/index.ts` if needed.

- [ ] **Step 1:** Add a `JdSignal` interface = the JD-derived half of `StrategistResearchResult`:
  ```ts
  export interface JdSignal {
      readonly targetRole: string;
      readonly seniority: string;
      readonly domain: string;
      readonly hardRequirements: JobRequirement[];
      readonly softRequirements: JobRequirement[];
      readonly implicitRequirements: string[];
      readonly technologyInventory: TechnologyInventory;
      readonly experienceSignals: ExperienceSignals;
      readonly requiredSkills: string[];
      readonly preferredSkills: string[];
      readonly tools: string[];
      readonly concepts: string[];
      readonly responsibilities: string[];
      readonly retrievalKeywords: string[];
  }
  ```
- [ ] **Step 2:** Add a `ResearchMatching` interface = the matching half: `verifiedMatches, partialMatches, gaps, overallFitRating, fitSummary, pillarClassification?, resumeData, kbContext, kbRetrievalStats?, resumeConstraints?, dsaTopicCalibration?` (copy the exact field types from `StrategistResearchResult`).
- [ ] **Step 3:** Re-document `StrategistResearchResult` as the union (leave the interface as-is for back-compat, add a doc comment: `// = JdSignal & ResearchMatching, assembled in run-pipeline`). Do NOT change its members (zero downstream impact).
- [ ] **Step 4:** `cd applications/shared && npx tsc --build` → clean. Commit.

### Task 2: JD agent — extend jd-extractor to emit the full `JdSignal`

**Files:** `applications/job-strategist/src/agents/jd-extractor.ts` (+ test). Prompt may stay inline.

- [ ] **Step 1 (test):** extend the jd-extractor test — a JD mock → the agent returns `hardRequirements` (with `disqualifying`), `technologyInventory` (tools/languages/methodologies), `experienceSignals.yearsExpected`, `targetRole`. Run → fail.
- [ ] **Step 2:** Extend the Zod schema + tool `input_schema` to the full `JdSignal` (add hardRequirements[{skill,context,disqualifying}], softRequirements, implicitRequirements, technologyInventory{languages,frameworks,tools,infrastructure,methodologies}, experienceSignals{yearsExpected,...}, targetRole). Keep the existing atomic fields.
- [ ] **Step 3:** Extend the system prompt: "Extract the COMPLETE JD signal — the structured requirements (hard/soft, with disqualifying flags), the technology inventory, the experience signals (years expected), AND the atomic retrieval keywords. This is the single source of JD understanding for the whole pipeline."
- [ ] **Step 4:** Export `extractJdSignal` (the function; keep `extractJobDescription` as an alias if other callers use it, or rename + update callers). Return type `JdSignal`. Fail-open → a minimal `JdSignal` (empty arrays, targetRole from ctx). `cd applications/job-strategist && npx tsc --noEmit && yarn test jd-extractor` → green. Commit.

### Task 3: `collectJdMustHaves(jdSignal)`

**Files:** `applications/job-strategist/src/ats/jd-keywords.ts` (+ test).

- [ ] **Step 1 (test):** `collectJdMustHaves(jd)` → atomic deduped list from `technologyInventory.{tools,languages,methodologies,frameworks,infrastructure}`, lowercased Set, cap 18. Ignores hardRequirement phrases. Run → fail.
- [ ] **Step 2:** Implement `collectJdMustHaves(jd: JdSignal): string[]`. Keep `collectJdMustHavesV2` only if still referenced; otherwise remove. `collectGroundedTerms` unchanged.
- [ ] **Step 3:** `npx tsc --noEmit && yarn test jd-keywords` → green. Commit.

### Task 4: research agent → matcher

**Files:** `applications/job-strategist/src/agents/research-agent.ts`, `applications/job-strategist/src/prompts/research-persona.ts` (+ tests).

- [ ] **Step 1 (test):** research matcher test — given a `JdSignal` + (mocked) KB evidence, returns `verifiedMatches/partialMatches/gaps/overallFitRating/fitSummary/resumeData/kbContext`; the tool/output schema does NOT include hardRequirements/technologyInventory/etc. Run → fail.
- [ ] **Step 2:** Remove the JD-signal fields from the research tool `input_schema` + the Zod output schema (hardRequirements, softRequirements, implicitRequirements, technologyInventory, experienceSignals, domain, seniority, targetRole). Output type → `ResearchMatching`.
- [ ] **Step 3:** Add `jdSignal: JdSignal` as a param to `executeResearchAgent`; inject the JD signal into the user message (a "## JD Signal (already extracted — match against this)" block). KB retrieval still uses `jdRetrievalQueries(jdSignal)`.
- [ ] **Step 4:** Rewrite `research-persona.ts`: "You are GIVEN the JD's structured requirements + technology inventory. Your job is to MATCH the candidate's KB + career evidence against them — verified / partial / gap — and rate overall fit. Do NOT re-derive or restate the JD requirements; they are provided."
- [ ] **Step 5:** `cd applications/shared && npx tsc --build && cd ../job-strategist && npx tsc --noEmit && yarn test research` → green. Commit.

### Task 5: run-pipeline assembly + downstream rewiring

**Files:** `applications/job-strategist/src/run-pipeline.ts` (+ touch the integration test).

- [ ] **Step 1:** Replace `extractJobDescription` with `extractJdSignal` in the concurrent loads; name it `jd`.
- [ ] **Step 2:** `executeResearchAgent(ctx, pool, …, jd, careerEntries, roleEvidenceBlock)` — pass `jd`; the call returns `matching` (ResearchMatching).
- [ ] **Step 3:** Assemble `const research = { data: { ...jd, ...matching.data }, ... } as ...` — match the existing `research` variable shape so all downstream references (`research.data.targetRole`, `.hardRequirements`, `.experienceSignals`, `.verifiedMatches`, etc.) keep working unchanged.
- [ ] **Step 4:** ATS must-haves: `collectJdMustHaves(jd)` (pass `jd` into `renderCheckAndStoreAts`, replacing the `jdExtraction` must-have source). The recruiter-snapshot + yearsGap + metadata stash already read `research.data.*` — confirm they resolve post-assembly.
- [ ] **Step 5:** metadata stash: store `jdSignal: jd` (rename the old `jdExtraction` stash key, or keep both). The `research` stash stays.
- [ ] **Step 6:** `cd applications/shared && npx tsc --build && cd ../job-strategist && npx tsc --noEmit && yarn test` → green (note the 5 pre-existing PDF-render suites). Commit.

### Task 6: parity + integration

**Files:** `applications/job-strategist/src/__tests__/run-pipeline.integration.test.ts` (+ a small parity test).

- [ ] **Step 1:** Assert the assembled `research.data` has all the `StrategistResearchResult` fields the strategist reads (targetRole, hardRequirements, technologyInventory, experienceSignals, verifiedMatches, gaps, fitRating). Run → green.
- [ ] **Step 2:** Confirm there is exactly ONE JD extraction call in the pipeline (no duplicate technologyInventory derivation) — assert the research agent's tool schema no longer contains `technologyInventory`.
- [ ] **Step 3:** Full `yarn test` (both packages). Commit. Then `superpowers:finishing-a-development-branch`.
