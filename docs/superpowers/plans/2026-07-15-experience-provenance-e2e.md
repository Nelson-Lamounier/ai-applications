# Experience E2E Provenance + Evidence-Anchored ATS Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the experience section's provenance guarantee hold to the persisted document, expose the agent's dropped-line reasons, score ATS coverage on the final text, and replace exact-phrase coverage with evidence-anchored + term-tolerant scoring (experience lane only).

**Architecture:** Four components from the approved spec (docs/superpowers/specs/2026-07-15-experience-provenance-e2e-design.md): (1) dropped array through diagnostics -> Loki + metadata; (2) `withExperienceLock` snapshot-restore around every post-agent pass, generalising the existing metric-weave pattern; (3) final-text coverage + mutation assert; (4) `scoreExperienceCoverage` (anchors OR required-terms) + anchor-annotated targets and prompt.

**Tech Stack:** TypeScript, zod, jest, pino->Loki, prom-client, existing agent lanes (no new LLM calls).

## Global Constraints

- Branch `feat/experience-e2e-provenance` (exists, spec committed). ONE commit per task, impact-bullet body, no Co-Authored-By.
- Gates per task: full `yarn workspace @bedrock/job-strategist test` green, `yarn workspace @bedrock/job-strategist exec tsc --noEmit` clean, ROOT `yarn eslint <changed files>` (pre-existing violations exempt; NEW functions complexity <= 10), ASCII-only added lines, UK English.
- NEVER `git stash` (use `git show HEAD:<path>`). Fail-open on every new path. No changes to `ats/gate/summary-coverage.ts` (do-not-relax comment is load-bearing) or to Prometheus label VALUES beyond the bounded sets named below.
- The kept `ExperienceAgentOutput` (bullets + sources) is the provenance record: final persisted experience text must be byte-identical to `assembleExperience(keptOutput)`.

---

### Task 1: Dropped-line observability (G1)

**Files:**
- Modify: `applications/job-strategist/src/agents/writer/experience-ats-flow.ts` (provenance field: lines 24, 94, 112, 131)
- Modify: `applications/job-strategist/src/agents/writer/experience-agent-diagnostics.ts` (new Loki event)
- Modify: `applications/job-strategist/src/run-pipeline.ts` fallback diag literal in `fillResumeExperience` (~line 283)
- Test: `applications/job-strategist/src/agents/writer/__tests__/experience-agent-diagnostics.test.ts` + the ats-flow tests already covering `droppedLines`

**Interfaces (Produces):**
```ts
// experience-ats-flow.ts
export interface DroppedLine { readonly line: string; readonly reason: string; }
export function boundDropped(dropped: ReadonlyArray<{ line: string; reason: string }>): DroppedLine[];
// provenance gains: readonly dropped: DroppedLine[];  (droppedLines count KEPT)
```

- [ ] **Step 1:** failing tests: `boundDropped` caps reason at 200 chars and array at 30 entries; `logExperienceAgentEvents` emits `experience_agent_dropped` with the array when non-empty and does NOT emit it when empty; the persisted diag object carries `provenance.dropped`.
- [ ] **Step 2:** implement: `boundDropped` pure helper in experience-ats-flow.ts; set `dropped: boundDropped(<candidate>.accounting.dropped)` at all four provenance literals (kept-candidate at line 131 uses `output.accounting.dropped`; the two early-returns use `params.first`; the run-pipeline fallback literal uses `[]`). In experience-agent-diagnostics.ts add after the `experience_agent_scored` emit:
```ts
if (diag.provenance.dropped.length > 0) {
  log.info({ ...base, event: 'experience_agent_dropped', dropped: diag.provenance.dropped }, 'experience_agent_dropped');
}
```
  `experienceAgentOutcome` untouched (reasons NEVER reach Prometheus labels). Persistence needs no new write: the diag object already flows into the `metadata.analysis.experienceAgent` write -- verify by grepping the assembly site (`grep -n "experienceAgent" run-pipeline.ts`, the object spread near the single `updatePipelineRunMetadata` analysis write) and confirm the new field survives in the existing metadata test if one asserts the shape.
- [ ] **Step 3:** gates + commit `feat(job-strategist): surface experience dropped-line reasons (Loki + run metadata)`

### Task 2: Experience lock -- immutable after its agent (G2 core)

**Files:**
- Create: `applications/job-strategist/src/agents/writer/experience-lock.ts`
- Test: `applications/job-strategist/src/agents/writer/__tests__/experience-lock.test.ts`
- Modify: `applications/job-strategist/src/run-pipeline.ts` -- wrap: `surfaceMetrics` (~599), `guardResume` (~1290), `reframeStaleMigrations` (~1338), metric weave (~1364, MIGRATE off the bespoke snapshot onto the helper), `revalidateResumeContent` (~1375), `applyLengthBudget` (~1350 and the post-keywords call ~1490), `surfaceKeywords` (~1470). `sectionNetFiredMetric` (~830) gains `'outcome'` in labelNames; existing increments pass `outcome: 'changed'`, lock restores pass `outcome: 'restored'`.
- Modify: `applications/job-strategist/src/ats/length/length-budget.ts` `hardTrimExperience` (~145-156): whole-bullet only.

**Interfaces (Produces):**
```ts
// experience-lock.ts -- generalises run-pipeline.ts:1359-1370 (restoreExperienceAfter stays in guards/roster.ts and is reused here)
export async function withExperienceLock(
  resume: StructuredResumeData,
  passName: string,
  fn: (r: StructuredResumeData) => Promise<StructuredResumeData>,
  onRestored: (pass: string) => void,
): Promise<StructuredResumeData> {
  const before = structuredClone(resume.experience);
  const out = await fn(resume);
  if (JSON.stringify(out.experience) === JSON.stringify(before)) return out;
  onRestored(passName);
  return { ...out, experience: before };
}
```

- [ ] **Step 1:** failing tests: mutating pass -> experience restored + `onRestored('the-pass')` called + other sections keep the pass's changes; non-mutating pass -> object passthrough, no callback; fn throwing -> rejection propagates (callers keep their own `.catch` fail-open).
- [ ] **Step 2:** implement helper; wrap the seven run-pipeline call sites, each `onRestored` doing `sectionNetFiredMetric.inc({ section: 'experience', pass, outcome: 'restored' })` + `violationLog.record(<existing stage for that pass>, 'experience_lock_restored')`. Keep `expSnapshot` net-fired comparisons for projects (`outcome: 'changed'`). Delete the bespoke `expBeforeWeave` snapshot (1363-1370) in favour of the helper.
- [ ] **Step 3:** `hardTrimExperience`: remove the `trimSentences` map -- highlights become `(e.highlights ?? []).slice(0, LENGTH_BUDGET.maxBulletsPerRole)` only; update its unit test (a 91-word bullet now SURVIVES hard trim -- the cap is the agent contract, Task 3 adds the prompt rule). Note in the test why.
- [ ] **Step 4:** grep `docs/runbooks/*.md` for `section_net_fired` and update any query samples for the new label. Gates + commit `feat(job-strategist): experience section locked immutable after its agent (lock helper + outcome label)`

### Task 3: Evidence-anchored targets + term-tolerant scorer + anchored prompt (G4)

**Files:**
- Create: `applications/job-strategist/src/ats/gate/experience-coverage.ts` (+ `__tests__/experience-coverage.test.ts`)
- Modify: `applications/job-strategist/src/ats/gate/experience-ats-targets.ts` (+ its test)
- Modify: `applications/job-strategist/src/agents/writer/experience-message.ts` (anchor blocks in the runtime message)
- Modify: `applications/job-strategist/src/prompts/content/strategist/experience-agent.md` -- add the per-bullet <= 32-word contract rule and the zero-anchor honesty rule; bump the version in its front-matter (STRATEGIST_EXPERIENCE_META loads it; `agents/__tests__/prompt-meta.test.ts` and any golden asserts must be regenerated deliberately, never by weakening the test).
- Modify: `applications/job-strategist/src/run-pipeline.ts` + `experience-ats-flow.ts` call sites for the new signatures.

**Interfaces (Produces):**
```ts
// experience-ats-targets.ts
export interface ExperienceAtsTarget extends SummaryAtsTarget {
  readonly requirement: string;
  readonly anchors: string[];          // career line ids c{i}.h{j}
}
export function selectExperienceAtsTargets(
  ledger: readonly SkillEvidenceEntry[], jd: JdLike,
  careerLines: readonly IndexedCareerLine[], limit = 6,
): ExperienceAtsTarget[];

// experience-coverage.ts
export const GENERIC_TARGET_TOKENS: ReadonlySet<string>; // systems, system, engineering, experience, analysis, skills, skill, knowledge, management, ability, and, of, the
export function requiredTerms(skill: string): string[];  // tokens minus generics; falls back to ALL tokens when every token is generic
export interface ScorableBullet { readonly text: string; readonly sources: readonly string[]; }
export function scoreExperienceCoverage(
  bullets: readonly ScorableBullet[], targets: readonly ExperienceAtsTarget[],
): SummaryCoverage; // same {targets, covered, missing} shape
```
Covered = some ONE bullet has (`sources` intersects `target.anchors`) OR (every `requiredTerms(target.skill)` term appears whole-word in `padded(normalizeTerm-...)` of that bullet's text, order-free). Anchors at selection = ids of career lines whose text term-matches the target by the same `requiredTerms` rule.

- [ ] **Step 1:** failing tests, including verbatim from the live run: target "Linux systems engineering" + bullet "Guided customers through Amazon Linux (AL2 and AL2023) system setup..." -> covered via terms {linux}; "performance and scalability analysis" covered ONLY via anchor citation when the text lacks "scalability"; all-generic target ("systems engineering") keeps full token set; zero-anchor + zero-term target stays missing (fail-closed); anchor computation returns c-ids from matching lines.
- [ ] **Step 2:** implement scorer + selection change (thread `careerLines` from `fillResumeExperience`, which already has them; run-pipeline builds targets BEFORE batch 1 -- move/derive the anchor pass where both ledger and careerLines exist, keeping selection deterministic and pure).
- [ ] **Step 3:** `resolveExperienceAts` swaps `scoreSummaryCoverage(joinExperienceText(...))` -> `scoreExperienceCoverage(bulletsOf(candidate), targets)` where `bulletsOf` flattens roles to `{text, sources}`. Summary lane untouched.
- [ ] **Step 4:** message + persona: per-target block `TARGET: <skill> -- grounded by [<id>] "<line text>" ...` (anchors joined, zero-anchor variant per spec); persona gains the 32-word bullet contract + honesty rule; bump prompt version; regenerate manifest/golden expectations by the house recipe (see the Phase 4/5 pattern in git history for experience-agent.md bumps).
- [ ] **Step 5:** gates + commit `feat(job-strategist): evidence-anchored experience ATS targets + term-tolerant coverage`

### Task 4: Final-text coverage + mutation assert + routed jd-echo re-write (G3 + G2 tail)

**Files:**
- Modify: `applications/job-strategist/src/agents/writer/experience-ats-flow.ts` (diag gains `coverageFinal`), `experience-agent-diagnostics.ts` (event `experience_agent_coverage_final`), `run-pipeline.ts` (final scoring just before the persist assembly; jd-echo routing after `guardResume`).
- Test: extend `experience-ats-flow` + a run-pipeline-level unit if one exists for the guard sequence (else the diagnostics tests).

**Interfaces:** `ExperienceAgentDiagnostics` gains `coverageFinal: SummaryCoverage | null` (null until final scoring stamps it -- the diag object is mutated once, immediately before the metadata write). Violation code `experience_mutated_downstream` (stage `resume_integrity`) when `JSON.stringify(finalResume.experience) !== JSON.stringify(assembleExperience(keptOutput))`.

- [ ] **Step 1:** failing tests: final scoring stamps `coverageFinal` using the SAME scorer + kept output sources; equality assert records `experience_mutated_downstream` when text differs and nothing when identical; jd-echo routing -- echo-flagged violations trigger at most ONE `strategist-experience-rewrite` call carrying the flagged bullet texts, output provenance-validated, invalid output discarded (original stands, violation stays advisory).
- [ ] **Step 2:** implement: keep the kept `ExperienceAgentOutput` in scope through the guard chain (return it from `fillResumeExperience` alongside diag -- change its return to `{ diag, kept }`, threading through `Batch1Result`); after the last resume-mutating pass and before the metadata/persist assembly, run the assert + final scoring; emit the Loki event. Routing: filter `guardResume` violations for `experience_bullet_jd_echo`; when present call the rewrite lane once (echo bullets + instruction to rephrase from the SAME cited lines), validate with `validateExperienceProvenance`, splice only if valid; the lock from Task 2 stays outermost so nothing else can touch the section.
- [ ] **Step 3:** gates + commit `feat(job-strategist): final-text experience coverage + downstream-mutation assert + provenance-safe jd-echo re-write`

### Task 5: Evals + runbook + sweep

**Files:**
- Modify: `applications/job-strategist/src/evals/experience/fixtures.ts` + `experience-graders.ts`/`.test.ts` -- add the spec's three eval cases (anchored Linux case verbatim, term-tolerant case, no-evidence target stays missing) reusing `scoreExperienceCoverage` as the grader primitive (graders reuse runtime logic -- house rule from the summary lane).
- Create or extend: `docs/runbooks/experience-agent-observability.md` (mirror docs/runbooks/projects-agent-observability.md): the four Loki events incl. `experience_agent_dropped` + `experience_agent_coverage_final`, the `outcome` label semantics, `coverageFinal` as the A/B number, and the "which lines were dropped and why" query.
- Sweep: `grep -rn "scoreSummaryCoverage" applications/job-strategist/src/agents/writer` -> only summary-lane usages remain; `grep -rn "droppedLines" ...` -> count still emitted; full suite; tsc; eslint.

- [ ] **Step 1:** eval cases (each fixture: careerLines + targets + bullets + expected coverage verdicts) + graders green.
- [ ] **Step 2:** runbook (ASCII, UK English).
- [ ] **Step 3:** sweep + gates + commit `test(job-strategist): experience provenance evals + observability runbook`

---

## Self-Review

**Spec coverage:** C1 -> T1; C2 -> T2 (lock, metric label, hardTrim, weave migration) + T4 (jd-echo routing, assert); C3 -> T4; C4 -> T3; testing section -> per-task tests + T5 evals/runbook. Fail-open + no-summary-change constraints restated in Global Constraints.

**Placeholder scan:** none -- every step names files, signatures, events, codes; the two deliberately-deferred lookups (metadata assembly grep in T1, prompt-golden regeneration recipe in T3) point at exact greps/history rather than TBDs.

**Type consistency:** `DroppedLine`/`boundDropped` (T1) match the diag field; `ExperienceAtsTarget.anchors` + `scoreExperienceCoverage` signatures used identically in T3 and T4; `fillResumeExperience` return change `{ diag, kept }` named in T4 where it happens.
