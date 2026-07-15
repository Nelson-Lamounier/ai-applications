# Phase 5 PR-B -- Writer Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the strategist-writer's extended-thinking LLM (~6 min, ~80% of wall-clock) and replace it with three dedicated agents (analysis, cover-letter, skills) plus a deterministic skeleton/reconciler, running the section agents in parallel.

**Architecture:** A deterministic `buildSkeletonResume` creates the resume object BEFORE agents run; parallel batch 1 = Promise.all[analysis-agent, fillResumeExperience, fillResumeProjects, skills-agent] mutating disjoint fields; `reconcileResume` validates + applies sectionOrder + refuses empty sections; parallel batch 2 = Promise.all[fillResumeSummary, cover-letter-agent] (both read the assembled body); the existing chain from guardCoverLetter onward is unchanged. The analysis-agent reproduces a `StrategistAnalysisResult`-compatible object (narrative `analysisXml` string preserved -- hard cache-hit gate) with deprecated fields stubbed.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), ts-jest, Zod, prom-client, Bedrock `runAgent`.

## Global Constraints

- Branch: NEW `feat/writer-split` off develop (`b666f3c0`, PR #485 merged). PR-B scope per the spec's PR-B section.
- eslint via ROOT `yarn eslint <files>`; tsc both workspaces when shared touched (`yarn workspace @bedrock/shared build` for dist, NEVER commit dist); full suite green per task; no NEW complexity>10.
- ASCII ONLY in added lines (`--`, `->`, straight quotes; reviewers grep). English (UK). No `Co-Authored-By`. NEVER `git stash` (use `git show <rev>:<path>` for baselines).
- Prompt manifest atomicity: deleting a content/*.md REQUIRES deleting its manifest entry in the same commit (stale-entry test `prompt-content-integrity.test.ts:66`); new .md files need new entries (test prints hashes).
- Metadata: single `updatePipelineRunMetadata` analysis write (shallow jsonb merge); fold new agent diagnostics into the existing literal.
- CONCURRENCY FACTS (cite in code comments): `accumulateContext` (`shared/src/agent-runner.ts:232`) has NO await between its `+=` operations, so concurrent `runAgent` calls cannot corrupt `cumulativeTokens`/`cumulativeCostUsd`; the section fillers mutate DISJOINT fields of one resume object (experience/projects/skills/summary) which is safe in single-threaded Node; summary + cover-letter READ the assembled body so they run in batch 2 only.
- CONTRACT FACTS: `analysis.data` spread into metadata (run-pipeline `analysisSpread` write) and the semantic cache; `analysisXml` MUST be a non-empty string (cache-hit gate ~L1049); deprecated `resumeSuggestions`/`resumeAdditions`/`resumeReframes`/`eslCorrections` stubbed `[]` (keys preserved for UI shape); `archetypeSelection.{selectedArchetype,leadIdentity,archetypeId}` consumed by guards + persist; `sectionOrder` lives on the RESUME object (claims-rules.ts:284-290 reads it).
- Free tier untouched EXCEPT the `CoverLetterSchema` import repoint (Task 1) -- `free-resume-writer.ts:22` imports it from strategist-agent today.
- Analysis-agent failure = pipeline failure (load-bearing, same as writer today). Skills fallback = deterministic grouping of verified matches. Cover-letter fallback = null letter + violation log (never blocks the resume).

---

### Task 1: relocate load-bearing survivors out of strategist-agent.ts

**Files:**
- Create: `applications/job-strategist/src/schemas/cover-letter.schema.ts` (move `CoverLetterSchema` + `CoverLetter` type verbatim from strategist-agent.ts ~L178)
- Create: `applications/job-strategist/src/schemas/tailored-resume.schema.ts` (move `TailoredResumeSchema` verbatim ~L419, incl. its imports of the base section schemas)
- Create: `applications/job-strategist/src/agents/writer/framing.ts` (move `framingDirective` verbatim ~L645)
- Modify: `applications/job-strategist/src/agents/writer/strategist-agent.ts` (re-export the moved symbols from their new homes so existing imports keep compiling THIS task; deletion happens in Task 8)
- Modify: `applications/job-strategist/src/agents/writer/free-resume-writer.ts:22` (import CoverLetterSchema from `../../schemas/cover-letter.schema.js`)
- Modify: `applications/job-strategist/src/schemas/resume-schema-drift.test.ts:22` (import TailoredResumeSchema from `./tailored-resume.schema.js`)
- Modify: `applications/job-strategist/src/run-pipeline.ts` (import framingDirective from `./agents/writer/framing.js`)

- [ ] **Step 1:** move each symbol verbatim (byte-identical bodies) to its new file; leave `export { CoverLetterSchema, type CoverLetter } from '../../schemas/cover-letter.schema.js';`-style re-exports in strategist-agent.ts.
- [ ] **Step 2:** repoint the three named consumers to the new homes (grep for any others: `grep -rn "from './strategist-agent\|from '../writer/strategist-agent" applications/job-strategist/src` and repoint everything that imports ONLY moved symbols).
- [ ] **Step 3:** full suite green (`yarn workspace @bedrock/job-strategist test`); tsc clean; ROOT eslint on changed files.
- [ ] **Step 4: Commit** `refactor(job-strategist): relocate cover-letter/tailored-resume schemas + framingDirective ahead of writer deletion`

### Task 2: `buildSkeletonResume` + `reconcileResume` (pure)

**Files:**
- Create: `applications/job-strategist/src/lib/resume-skeleton.ts`
- Create: `applications/job-strategist/src/lib/resume-reconciler.ts`
- Test: `applications/job-strategist/src/lib/__tests__/resume-skeleton.test.ts`, `applications/job-strategist/src/lib/__tests__/resume-reconciler.test.ts`

**Interfaces (produces):**

```typescript
// resume-skeleton.ts
export interface SkeletonInputs {
  readonly careerEntries: readonly CareerEntry[];       // agents/evidence/career-history.js
  readonly education: readonly CareerEntry[];           // loadEducation shape (title/company/period/highlights)
  readonly certifications: readonly CareerEntry[];
  readonly contact: { name: string; email: string; linkedin?: string; github?: string; title?: string; location?: string };
}
export function buildSkeletonResume(i: SkeletonInputs): StructuredResumeData;
// -> profile from contact (verbatim); experience = roster skeleton {company,title,period,highlights:[]};
//    education/certifications mapped VERBATIM from entries; summary ''; skills []; projects [];
//    keyAchievements []; sectionOrder undefined (analysis applies later).

// resume-reconciler.ts
export interface ReconcileInputs {
  readonly resume: StructuredResumeData;                            // post-batch-1 mutated skeleton
  readonly sectionOrder: string[] | undefined;                      // from analysis result (resume-level)
  readonly fallbacks: {
    experience: () => StructuredResumeData['experience'];           // verbatim career highlights
    projects: () => StructuredResumeData['projects'];               // deterministicProjects(...) closure
    skills: () => StructuredResumeData['skills'];                   // deterministic verified-matches grouping
  };
}
export function reconcileResume(i: ReconcileInputs): { resume: StructuredResumeData; repaired: string[] };
// -> validates via the single-source base schemas (parse TailoredResumeSchema-compatible shape);
//    REFUSES empty required sections: experience empty -> fallbacks.experience(); projects empty AND
//    fallback non-empty -> fallbacks.projects(); skills empty -> fallbacks.skills(); summary stays ''
//    (Phase 3 agent fills in batch 2). Applies sectionOrder when provided. `repaired` lists which
//    sections were fallback-filled (bounded tokens: 'experience'|'projects'|'skills').
```

- [ ] **Step 1: Failing tests** -- skeleton: roster mapped verbatim from careerEntries, education/certs verbatim, empty summary/skills/projects; reconciler: (a) intact resume passes through unchanged with `repaired: []`; (b) empty experience -> fallback filled + `repaired: ['experience']`; (c) empty projects with non-empty fallback -> filled; empty projects with EMPTY fallback -> left `[]` (legit no-projects user), NOT flagged; (d) empty skills -> fallback; (e) sectionOrder applied when provided, untouched when undefined; (f) schema-invalid input (e.g. experience entry missing period) throws.
- [ ] **Step 2: FAIL.** **Step 3: implement** (import `StructuredResumeData` from `@bedrock/shared`, `TailoredResumeSchema` from Task 1's new home for validation). **Step 4: PASS; full suite; lint; tsc.**
- [ ] **Step 5: Commit** `feat(job-strategist): deterministic resume skeleton + reconciler -- refuse-empty sections, sectionOrder apply`

### Task 3: analysis-agent

**Files:**
- Create: `applications/job-strategist/src/prompts/content/strategist/analysis-agent.md` (id `strategist-analysis`, version 1, cachePoint default)
- Modify: `applications/job-strategist/src/prompts/prompt-manifest.json` (+1 entry via integrity test)
- Create: `applications/job-strategist/src/prompts/strategist-analysis.ts` (loadPersona mirror)
- Create: `applications/job-strategist/src/agents/analysis/analysis-message.ts`
- Create: `applications/job-strategist/src/agents/analysis/analysis-extractors.ts` (MOVE `extractArchetypeSelection`, `extractGapMitigations`, `extractMetadataFromXml`, `extractTagArray`/`extractTagValue`/`extractCdataValue` helpers verbatim from strategist-agent.ts; export the first three)
- Create: `applications/job-strategist/src/agents/analysis/analysis-agent.ts`
- Test: `applications/job-strategist/src/agents/analysis/__tests__/analysis-agent.test.ts`, `__tests__/analysis-message.test.ts`, `applications/job-strategist/src/prompts/__tests__/strategist-analysis-persona.test.ts`

Persona content: the ANALYSIS-phase rules -- concatenate (adapted, resume-authoring stripped): the archetype Phase-0 selection rules (from `content/strategist/archetype.md`, moved wholesale), the gap/transferable-framing rules (from `gaps.md`), the fit-rating/mitigation/recommendation phase structure (distilled from `_base_2`/`_base_3` analysis-phase text -- READ them; keep the XML output contract for `<phase_0_archetype_selection>`, metadata tags, `<mitigation>` blocks; EXPLICITLY instruct: do NOT emit `<tailored_resume_json>` or `<cover_letter>` -- dedicated passes own them).

`analysis-message.ts`: `buildAnalysisMessage(m: AnalysisMessageInput): string` where the input carries `research, companyProblem?, roleEmphasis?, codeStack, yearsGapFraming, profileIntelligence, resumeConstraints` -- implement by MOVING the surviving section builders from `strategist-message.ts` (research-brief, company-problem, role-emphasis, requirements, technology-inventory, matches, resume-constraints, profile-intelligence, years-gap-framing) into this file (Task 8 deletes the rest). Keep each builder's text byte-identical where it is analysis-relevant; drop resume-authoring instructions (e.g. buildResumeConstraints' bullet-authoring framing line becomes analysis framing).

`analysis-agent.ts`:

```typescript
const ANALYSIS_CONFIG: AgentConfig = {
  agentName: 'strategist-analysis', modelId: EFFECTIVE_MODEL_ID,
  maxTokens: 8000, thinkingBudget: 2048,             // the one deliberative task; ~4x below the old writer
  systemPrompt: STRATEGIST_ANALYSIS_SYSTEM_PROMPT,
  pipeline: 'job-strategist', promptId: META.id, promptVersion: META.version,
  // NO tool -- narrative XML text response
};
export async function executeAnalysisAgent(ctx, input): Promise<AgentResult<StrategistAnalysisResult>> {
  return runAgent({ config: ANALYSIS_CONFIG, userMessage: buildAnalysisMessage(input),
    parseResponse: (text) => parseAnalysisResponse(text), pipelineContext: {...} });
}
export function parseAnalysisResponse(text: string): StrategistAnalysisResult {
  const sanitised = /* same XML sanitisation the writer used -- read strategist-agent parseResponse and reuse */;
  return {
    analysisXml: sanitised,                       // MUST be non-empty; throw when blank (load-bearing)
    metadata: extractMetadataFromXml(sanitised),
    gapMitigations: extractGapMitigations(sanitised),
    archetypeSelection: extractArchetypeSelection(sanitised),
    coverLetter: null, tailoredResumeData: null,  // owned by dedicated passes
    resumeSuggestions: [], resumeAdditions: [], resumeReframes: [], eslCorrections: [], // deprecated stubs -- keys preserved for UI shape
  };
}
```

- [ ] Steps: persona -> manifest hash -> prompt module -> failing tests (message sections present; parseAnalysisResponse extracts archetype/mitigations/metadata from a fixture XML, stubs deprecated as [], throws on empty analysisXml; config has thinkingBudget 2048 + NO tool) -> implement -> PASS -> full suite/lint/tsc -> commit `feat(job-strategist): dedicated analysis agent -- archetype + fit narrative, resume authoring stripped`

### Task 4: skills-agent

**Files:**
- Create: `applications/job-strategist/src/agents/writer/skills-schema.ts` (`SKILLS_EMIT_INPUT_SCHEMA` forced-tool JSON schema for `{skills: [{category, skills: string[]}]}` + Zod `SkillsAgentOutputSchema` reusing `SkillCategoryBaseSchema` from `schemas/resume-sections.ts:49`)
- Create: `applications/job-strategist/src/agents/writer/skills-validate.ts` (`validateSkillsMembership(out, ledger): string[]` -- every emitted skill name matches a verified OR transferable ledger tool via `matchTier1` bidirectional or exact-lowercase (REUSE `ats/matching/keyword-match.js`); violations `unknown_skill:<name>`, `category_cap:<n>` (>5), `item_cap:<category>:<n>` (>8); plus `deterministicSkills(ledger, jd): SkillCategory[]` fallback -- verified tools first then transferable, grouped: infrastructure/languages/tools buckets via the JD technologyInventory membership when available else single 'Core Skills' category, capped 5x8)
- Create: `applications/job-strategist/src/prompts/content/strategist/skills-agent.md` (id `strategist-skills`, v1 -- rules from skills-education.md: <=150 words, name <=6 words never a sentence, max 8/category max 5 categories, JD required -> preferred -> supporting, cut the rest; plus ledger-grounding: only skills the evidence supports) + manifest entry
- Create: `applications/job-strategist/src/prompts/strategist-skills.ts`, `applications/job-strategist/src/agents/writer/skills-agent.ts` (`executeSkillsAgent(ctx, input, opts?)`, forced tool `emit_skills`, thinkingBudget 0, maxTokens 1500)
- Create: `applications/job-strategist/src/agents/writer/skills-message.ts` (`buildSkillsMessage`: JD requirements section + verified/partial matches + technology inventory + education facts note NOT needed -- education is reconciler-owned)
- Test: mirrors of the projects-agent test files (schema, validator incl. all three violation tokens, agent config/override, message sections)

- [ ] Steps: TDD as in prior agent tasks -> full suite/lint/tsc -> commit `feat(job-strategist): dedicated skills agent -- ledger-membership validated, deterministic fallback`

### Task 5: cover-letter-agent

**Files:**
- Create: `applications/job-strategist/src/prompts/content/strategist/cover-letter-agent.md` (id `strategist-cover-letter-agent`, v1 -- MOVE cover-letter.md's full authoring contract verbatim-adapted: JSON via the forced tool instead of CDATA; keep VERBATIM-signoff, exactly-3-paragraphs, P1/P2/P3, tenure-conditional, transferable-framing, readability, echo-the-resume's-strongest-achievement) + manifest
- Create: `applications/job-strategist/src/prompts/strategist-cover-letter.ts`
- Create: `applications/job-strategist/src/agents/writer/cover-letter-agent.ts` (`executeCoverLetterAgent(ctx, input): Promise<AgentResult<CoverLetter>>` -- forced tool `emit_cover_letter` whose input_schema mirrors `CoverLetterSchema` (greeting/paragraphs/signoff{name,email,linkedin,github} all required); parseResponse = `CoverLetterSchema.parse(parseJsonResponse(...))`; thinkingBudget 0, maxTokens 1500)
- Create: `applications/job-strategist/src/agents/writer/cover-letter-message.ts` (`buildCoverLetterMessage(m)`: research brief essentials (targetRole/company/companyProblem), achievement evidence, candidate contact (signoff source), years-gap framing, profile intelligence, AND the ASSEMBLED resume body summary+experience+projects text (the echo rule) -- batch-2 dependency documented in the doc comment)
- Test: mirrors (message sections incl. body echo section; agent config; Zod-throw)

- [ ] Steps: TDD -> full suite/lint/tsc -> commit `feat(job-strategist): dedicated cover-letter agent -- forced tool, authoring contract relocated`

### Task 6: AgentName additions

- Modify `applications/shared/src/types.ts`: append `| 'strategist-analysis' | 'strategist-cover-letter' | 'strategist-skills'` after `'strategist-projects-rewrite'`. Remove any Task 3-5 casts. shared tsc + build + job-strategist tsc; ROOT eslint; commit ONLY the touched files: `feat(shared): analysis/cover-letter/skills agent names for isolated cost`

### Task 7: run-pipeline rewiring (the integration task)

**Files:** Modify `applications/job-strategist/src/run-pipeline.ts`; Create `applications/job-strategist/src/__tests__/pipeline-stage-timing.test.ts` (pure helper test)

READ the real file first. Replace the `executeStrategistAgent` stage with:

```typescript
// deterministic skeleton BEFORE any agent -- the fillers need a target object
const skeleton = buildSkeletonResume({ careerEntries, education: educationEntries, certifications: certificationEntries, contact: contactStruct });
let tailoredResumeData: StructuredResumeData | null = skeleton;

// -- batch 1: analysis + section agents in parallel --------------------------
// Safe: accumulateContext (agent-runner.ts:232) has no await between += ops, and the
// fillers mutate DISJOINT fields (experience/projects/skills) of one object.
const [analysisRes, experienceAgentDiag, projectsAgentDiag, skillsAgentDiag] = await Promise.all([
  executeAnalysisAgent(ctx, analysisInput),                       // throws -> run fails (load-bearing)
  fillResumeExperience(ctx, tailoredResumeData, ...),             // unchanged internals
  fillResumeProjects(ctx, tailoredResumeData, ...),               // unchanged internals
  fillResumeSkills(ctx, tailoredResumeData, skillsInput, ...),    // new splice fn mirroring the others
]);
const analysis = analysisRes;                                     // AgentResult<StrategistAnalysisResult>

// sectionOrder + refuse-empty reconcile between batches
const reconciled = reconcileResume({ resume: tailoredResumeData, sectionOrder: analysisSectionOrder(analysis.data), fallbacks: {...} });
tailoredResumeData = reconciled.resume;

// -- batch 2: summary + cover letter (both READ the assembled body) ---------
const [summaryAtsDiag, coverLetterRes] = await Promise.all([
  fillResumeSummary(ctx, tailoredResumeData, ...),                // unchanged internals
  ctx.includeCoverLetter ? executeCoverLetterAgent(ctx, clInput).catch((err) => { log.warn(...); return null; }) : Promise.resolve(null),
]);
const finalCoverLetterCandidate = coverLetterRes?.data ?? null;   // feeds guardCoverLetter exactly where analysis.data.coverLetter did
```

Details the implementer must handle (read + adapt):
- `scrubInstructionLeaks`/`reconcileRosterAgainstCareer` previously ran on `analysis.data.tailoredResumeData` -- now run them on the SKELETON before batch 1 (roster reconcile) and drop the instruction-leak scrub input change accordingly (the skeleton has no LLM prose; keep the scrub where it still applies to LLM outputs downstream or note removal).
- Education/certs structured entries: `loadEducation`/`loadCertifications` already return entry arrays (they are formatted to blocks today) -- pass the raw arrays into `buildSkeletonResume`; the formatted blocks feeding the message builders that survive stay as-is.
- Contact struct: parse from `candidateContactBlock`'s loader source (read `loadCandidateContactBlock` -- if only a formatted block exists, add a structured variant in the same loader file rather than string-parsing).
- `analysisSectionOrder(analysis.data)`: sectionOrder used to arrive on the WRITER's resume JSON; the analysis-agent does not emit a resume. Decide per spec: keep `sectionOrder: undefined` (renderer default) UNLESS `archetypeSelection` implies an order -- read how sectionOrder is consumed (claims-rules.ts:284-290 + renderer) and preserve today's default behaviour when the writer omitted it. Document the decision in the code comment.
- Cache-hit path (~L1049-1075) unchanged (it replays `analysis.analysisXml` + `tailoredResumeData` from cache); cache PUT spread now carries the analysis-agent's result (`...analysis.data` with stubs) + `tailoredResumeData: finalResume` -- verify the put still includes `analysisXml: finalAnalysis` non-empty.
- Metadata analysis literal gains `skillsAgent: skillsAgentDiag` beside the others (SINGLE write).
- STAGE TIMING (headline): add `stageSeconds(stage: string)` helper + Histogram `job_strategist_pipeline_stage_seconds{stage}` with buckets `[1,5,15,30,60,120,240,480]`, observed around: research, batch1, reconcile, batch2, guards, length, ats_gate, persist. Pure helper unit-tested (fake timer or injected clock).
- `guardCoverLetter` call site: swap `analysis.data.coverLetter` -> `finalCoverLetterCandidate`; `leadIdentity` still from `analysis.data.archetypeSelection`.

- [ ] Steps: failing timing-helper test -> implement wiring -> FULL suite (adapt fixtures asserting the old writer stage -- document each) -> lint/tsc -> commit `feat(job-strategist): parallel section-agent pipeline -- skeleton, batch1/reconcile/batch2, stage timing`

### Task 8: writer deletion

**Files:**
- Delete: `applications/job-strategist/src/agents/writer/strategist-agent.ts` (Task 1 re-exports removed -- consumers already repointed; `extractTailoredResumeJson`/`extractCoverLetter`/`buildResumeSuggestions`/CoverLetter XML paths die here), `applications/job-strategist/src/agents/writer/strategist-message.ts` (surviving builders moved in Task 3), `applications/job-strategist/src/prompts/strategist-persona.ts`, `applications/job-strategist/src/prompts/__tests__/strategist-persona-assembly.test.ts`, `applications/job-strategist/src/prompts/__tests__/strategist-persona.test.ts`, `applications/job-strategist/src/prompts/__tests__/__fixtures__/strategist-persona-golden.txt`
- Delete content modules + manifest entries (SAME commit -- stale-entry test): `_base_1.md`, `_base_2.md`, `_base_3.md`, `_base_4.md`, `_base_5.md`, `archetype.md`, `experience.md` (skeleton), `projects.md` (skeleton), `skills-education.md`, `cover-letter.md`, `gaps.md`
- Modify: `applications/job-strategist/src/run-pipeline.ts` (remove the old `job_strategist_experience_net_fired_total` counter -- the generalised `section_net_fired_total` stays), any lingering imports
- Modify: `docs/runbooks/experience-agent-observability.md` + `docs/runbooks/projects-agent-observability.md` (counter removal noted)

- [ ] Steps: delete -> grep for dangling imports (`executeStrategistAgent|strategist-persona|strategist-message|STRATEGIST_PERSONA|_base_`) -> integrity test PASS (no stale manifest entries) -> FULL suite green (adapt/delete tests that pinned deleted personas -- document each; the drift test and free tier MUST still pass) -> lint/tsc -> commit `feat(job-strategist)!: delete the strategist-writer LLM -- resume assembly is deterministic, prose is agent-owned`

### Task 9: observability for the three new agents

**Files:** Create `applications/job-strategist/src/agents/analysis/analysis-agent-diagnostics.ts` + skills/cover-letter equivalents (or ONE shared `section-agent-diagnostics.ts` emitter parameterised by agent key -- prefer the shared module, it is the third copy of this pattern); tests; run-pipeline wiring.

- Bounded outcome metrics: `job_strategist_analysis_agent_outcome_total{outcome}` (success|failure -- failure aborts anyway, the counter records it), `job_strategist_skills_agent_outcome_total{outcome,reason}` (agent|fallback x membership-invalid|agent-error|caps), `job_strategist_cover_letter_agent_outcome_total{outcome,reason}` (agent|omitted x agent-error|guard-null).
- Loki events: `skills_agent_*` (targets not applicable -- emit `_scored` with category/item counts + `_membership_reject` tokens + `_fallback`), `cover_letter_agent_{generated,omitted}`, `analysis_agent_{archetype,mitigations}` summary events. Correlation keys as before.
- Metadata: `skillsAgent` fold done in Task 7; add `coverLetterAgent: {outcome, reason}` + `analysisAgent: {archetypeId, confidence, mitigations: n}` compact objects to the same single write.

- [ ] Steps: TDD on the shared emitter -> wire -> full suite/lint/tsc -> commit `feat(job-strategist): section-agent observability -- shared emitter, bounded outcomes, metadata folds`

### Task 10: evals + runbook

**Files:** Create `applications/job-strategist/src/evals/analysis/{analysis-graders,fixtures}.ts` + test; `applications/job-strategist/src/evals/skills/{skills-graders,fixtures}.ts` + test; extend cover-letter guard rules as graders in `applications/job-strategist/src/evals/cover-letter/cover-letter-graders.ts` + test; Create `docs/runbooks/pipeline-stage-timing.md`.

- analysis graders: archetypeValidGrader (archetypeId integer 1-7, selectedArchetype + leadIdentity non-empty), noGapFabricationGrader (every mitigation's `gap` names a skill present in the research brief's gaps list -- fixture-driven), fitRatingGrader (overallFitRating in the FitRating enum).
- skills graders: membershipGrader (delegates to validateSkillsMembership), capsGrader (<=5 categories, <=8 items), jdPriorityGrader (first category's first skill matches a JD REQUIRED skill when any required skill is attainable -- vacuous otherwise).
- cover-letter graders: reuse guard predicates (exactly-3-paragraphs, signoff fields non-empty, no em-dash, tenure-conditional respected when hasYearsBar false -- read cover-letter-guard.ts rule fns and delegate).
- Runbook: stage-timing histogram queries (before/after headline: writer ~360s stage removed; batch1 expected 15-45s), the three new agents' metrics/events/cost (`agent LIKE 'strategist-analysis'` etc.), pointer updates in the experience/projects runbooks re the removed counter.

- [ ] Steps: TDD -> PASS -> full suite -> ASCII check on runbooks -> commit `test(job-strategist): analysis/skills/cover-letter evals + stage-timing runbook`

---

## Self-Review

**Spec coverage (PR-B section):** analysis-agent (byte-compatible analysisXml minus CL/resume, tb 2048, load-bearing) -> T3; cover-letter-agent -> T5; skills-agent + ledger-membership validator + deterministic fallback -> T4; reconcileResume refuse-empty + skeleton -> T2; writer LLM + personas deleted + manifest pruned -> T8 (survivor relocation T1); parallelisation with the concurrency-safety citations + batch1/batch2 split (CL needs the finished body) -> T7; old experience counter removed -> T8; observability + metadata folds -> T9 (+T7 skills fold); evals x3 + duration headline runbook -> T10. All PR-B spec bullets mapped.

**Placeholder scan:** T3/T7 carry decision points explicitly resolved in-line (sectionOrder default-preservation decision documented at the code comment; contact struct sourced from the loader not string-parsing). T4/T5/T9 reference the established P4/P5A file-set pattern with exact deliverables + violation tokens. No TBDs.

**Type consistency:** `buildSkeletonResume`/`reconcileResume` (T2) consumed in T7; `executeAnalysisAgent` returns `AgentResult<StrategistAnalysisResult>` (T3) spread-compatible with the metadata/cache contract; `validateSkillsMembership`/`deterministicSkills` (T4) consumed by T7's fillResumeSkills + T10 graders; `executeCoverLetterAgent` returns `AgentResult<CoverLetter>` with `CoverLetterSchema` from T1's new home; AgentName strings (T6) match T3/T4/T5 configs.
