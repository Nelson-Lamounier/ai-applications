# Projects Lane Coupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the projects agent's output actually ship (schema tolerance), enforce the user's description/highlights contract (pitch-stamped, locked descriptions; JD-ranked mixed-lane highlights), share the term-matching truth with the experience lane, and make the length system see project highlights.

**Architecture:** Five components from the approved spec (docs/superpowers/specs/2026-07-16-projects-lane-coupling-design.md, incl. the amended Component 4): (1) normalise-then-validate ahead of the strict zod union; (2) deterministic pitch-stamped descriptions + a description-scoped lock + retirement of the guard three-beat project rewrite; (3) `experienceTermMatch` ported to agent coverage and fallback ranking/ordering with the composed cap lifted; (4) highlights counted by `measureResume` with whole-bullet trims; (5) evals + runbook + sweep.

**Tech Stack:** TypeScript, zod, jest, existing agent lanes (no new LLM calls), existing matching subsystem (untouched).

## Global Constraints

- Branch `feat/projects-lane-coupling` (exists; spec committed). ONE commit per task, impact-bullet body, no Co-Authored-By.
- Gates per task: full `yarn workspace @bedrock/job-strategist test` green (growth only from 152 suites / 1297 tests), `tsc --noEmit` clean, ROOT `yarn eslint <changed files>` (NEW functions complexity <= 10; pre-existing violations exempt), ASCII-only added lines, UK English.
- NEVER `git stash` (use `git show HEAD:<path>`). Fail-open on every new path. DO NOT modify `ats/matching/keyword-match.ts` or `ats/gate/summary-coverage.ts` (verify byte-identical to develop in T5).
- Fail-closed boundary of projects provenance is UNTOUCHED: unknown bulletId, sources not resolving to the entry's OWN pool, `cross_project_citation`, pool-empty invention all still reject to the deterministic fallback.
- Persona changes (projects-agent.md) bump the front-matter version + regenerate the manifest sha via the prompt-content-integrity suite recipe -- never weaken a test.

---

### Task 1: normaliseProjectsAgentOutput -- schema tolerance (the unblocking fix)

**Files:**
- Modify: `applications/job-strategist/src/agents/writer/projects-schema.ts` (add normaliser + wire-schema description hygiene; zod schemas themselves UNCHANGED)
- Modify: `applications/job-strategist/src/agents/writer/projects-agent.ts` (parse site: normalise BEFORE zod)
- Modify: `applications/job-strategist/src/agents/writer/projects-agent-diagnostics.ts` (normalisedExtras -> Loki) + the diag type/persistence field (grep `projectsAgent` in run-pipeline.ts for the metadata assembly)
- Test: `applications/job-strategist/src/agents/writer/__tests__/projects-schema.test.ts` (or the existing schema test file)

**Interfaces (Produces):**
```ts
// projects-schema.ts
export interface NormalisedProjectsOutput { readonly output: unknown; readonly normalisedExtras: number; }
export function normaliseProjectsAgentOutput(raw: unknown): NormalisedProjectsOutput;
// Per highlight item: has non-empty string bulletId -> keep ONLY {bulletId} (drop echoed text/sources/unknown keys);
// no bulletId but has text + non-empty sources array -> keep ONLY {text, sources};
// neither shape -> item passed through UNTOUCHED (zod still rejects -- hard failure preserved).
// Per entry: agent-emitted `description` values are DISCARDED here (amended C4: system stamps descriptions);
// count every stripped item/field once in normalisedExtras. Non-object/malformed raw -> returned as-is, extras 0.
```

- [ ] **Step 1:** failing tests: live-shaped payload (2 entries x 6 highlights each `{bulletId: 'p0.b0', sources: ['fact']}`) -> normalises to `{bulletId}` only, `normalisedExtras === 12`, and the result PASSES `ProjectsAgentOutputSchema.parse`; both-keys item `{bulletId, text, sources}` -> curated; composed item with an unknown extra key -> `{text, sources}`; neither-shape item `{note: 'x'}` -> untouched and the parse still FAILS; description emitted by the agent -> stripped + counted; malformed raw (null, string) -> passthrough with extras 0.
- [ ] **Step 2:** implement; call it in projects-agent.ts's parseResponse immediately before the zod parse and surface `normalisedExtras` through the agent result to the diagnostics object; add Loki emission (mirror the existing projects_agent_* events; emit only when > 0) and include the number in the persisted projectsAgent metadata block.
- [ ] **Step 3:** wire-schema hygiene: `PROJECTS_EMIT_INPUT_SCHEMA` highlight item + `description` property get description strings stating the two legal shapes ("curated = bulletId ONLY -- no text, no sources; composed = text + sources ONLY") and that entry descriptions are system-authored. No structural change to the wire schema (constrained-decoding compatibility).
- [ ] **Step 4:** gates + commit `fix(job-strategist): projects agent schema tolerance -- normalise-then-validate (bulletId authoritative)`

### Task 2: description contract -- pitch stamp + lock + repair retirement

**Files:**
- Create: `applications/job-strategist/src/agents/writer/projects-description.ts` (+ test)
- Modify: `applications/job-strategist/src/run-pipeline.ts` (stamp in BOTH the agent-success path of fillResumeProjects and the deterministic fallback; description lock wraps), `applications/job-strategist/src/agents/quality/guards/rewrite.ts` (~line 58 three-beat recipe retired for descriptions), `applications/job-strategist/src/agents/writer/experience-lock.ts` (sibling helper lives beside withExperienceLock)
- Test: extend `experience-lock` tests file (or sibling) for the new lock; guard tests for the advisory behaviour

**Interfaces (Produces):**
```ts
// projects-description.ts
export function stampProjectDescription(pitch: string, capWords = 80): string;
// First PARAGRAPH of the pitch (split on blank line), then sentence-trimmed to capWords
// (reuse the trimSentences approach: keep whole sentences while <= cap; never mid-sentence).
// Empty/missing pitch -> '' (entry keeps whatever description it had -- fail-open).

// experience-lock.ts
export async function withProjectsDescriptionLock(
  resume: StructuredResumeData, passName: string,
  fn: (r: StructuredResumeData) => Promise<StructuredResumeData>,
  onRestored: (pass: string) => void,
): Promise<StructuredResumeData>;
// Snapshot projects[].description (array of strings, matched by entry index/name);
// restore ONLY descriptions that changed; highlights/other fields keep the pass's changes.
```

- [ ] **Step 1:** failing tests: stamp = first paragraph sentence-trimmed (multi-paragraph pitch fixture -> paragraph 1 only; long paragraph -> sentence-capped at 80 words; empty pitch -> ''); lock restores a mutated description while keeping the same pass's highlight/summary changes; non-mutating pass passthrough.
- [ ] **Step 2:** wire the stamp: after the agent output validates (and in the fallback), set every entry's `description = stampProjectDescription(project.pitch)` from `loadProjectAgentInputs`' already-loaded pitch (fallback's current pitch-trim-to-40w is REPLACED by the stamp). The agent's own description output is already discarded in T1.
- [ ] **Step 3:** retire the three-beat: rewrite.ts's project_restates_bullets / project_pitch_missing repair instruction no longer rewrites DESCRIPTIONS (drop the recipe lines; the violation codes stay detected + recorded as advisory). Wrap the resume-mutating passes that could still touch descriptions (guard repair, revalidate x2, condense/expand via applyLengthBudget x2, surfaceMetrics, metric weave, surfaceKeywords -- the same call sites the experience lock wraps) with `withProjectsDescriptionLock` (compose: the experience lock already wraps these closures; nest the description lock inside/outside consistently and document the order), `onRestored` -> `sectionNetFiredMetric.inc({section: 'projects_description', pass, outcome: 'restored'})` + `violationLog.record(<site stage>, 'projects_description_lock_restored')`.
- [ ] **Step 4:** gates + commit `feat(job-strategist): project descriptions -- deterministic pitch stamp, locked against post-agent rewrites`

### Task 3: matcher port + lane-mix contract

**Files:**
- Modify: `applications/job-strategist/src/agents/writer/projects-ats-flow.ts` (coverage scoring -> experienceTermMatch-based), `projects-provenance.ts` (composed cap 2 -> per-entry bullet cap), `projects-message.ts` (lane-mix + ordering instructions), `prompts/content/strategist/projects-agent.md` (persona rules + version bump + manifest), `run-pipeline.ts` fallback ranking/ordering site
- Test: the lane's existing test files, expectations re-derived; new ordering tests

**Interfaces:**
- Consumes: `experienceTermMatch(targetSkill, text)` from `ats/gate/experience-coverage.ts` (PR #492) -- import, never re-implement.
- Produces: fallback ordering rule used by T5 evals: entries sorted DESC by `coveredTargets(entry) = count of targets where some curated bullet text experienceTermMatch-es the target`; ties keep current order.

- [ ] **Step 1:** failing tests: coverage scoring credits a target when a bullet term-matches under `experienceTermMatch` semantics (reuse an experience-lane fixture pair to prove parity); fallback ranks a K8s-flavoured target set with platform bullets above frontend bullets; composed cap: an entry with per-entry-cap composed bullets validates (and cap+1 rejects); ordering ties stable.
- [ ] **Step 2:** implement scoring + ranking + cap change; message/persona: JD-ranked mix across BOTH lanes ("choose each slot by JD relevance regardless of lane; compose from repo-current facts when they beat curated bullets"), entries most-JD-relevant first; persona version bump + manifest regeneration.
- [ ] **Step 3:** gates + commit `feat(job-strategist): projects lane term-rule v2 + JD-ranked lane mix (composed cap lifted)`

### Task 4: projects length honesty

**Files:**
- Modify: `applications/job-strategist/src/ats/length/length-budget.ts` (measure ~62-77, LENGTH_BUDGET, hardTrimProjects ~135-143, condense prompt projects line ~233)
- Test: `applications/job-strategist/src/ats/length/__tests__/length-budget.test.ts`

**Interfaces:** `LENGTH_BUDGET.projectsHighlightWords = 180`; `ResumeMeasure` gains `projectsHighlights: number`; `overBudget` can contain `'projects_highlights'`; total arithmetic includes it.

- [ ] **Step 1:** failing tests: measure counts highlight words separately from description words; over-budget detection at 181+; `hardTrimProjects` drops WHOLE bullets from the END of the over-budget entries (round-robin from the last entry's last bullet) until within `projectsHighlightWords`, never truncating inside a bullet; descriptions still sentence-trimmed exactly as before; a within-budget resume untouched.
- [ ] **Step 2:** implement; the condense system prompt's projects line gains `- projects highlights total <= 180 words; drop the least JD-relevant bullets first, never reword a quoted bullet.`
- [ ] **Step 3:** gates + commit `feat(job-strategist): projects highlights join the length budget (measure + whole-bullet trim)`

### Task 5: evals + runbook + sweep

**Files:**
- Modify: `applications/job-strategist/src/evals/projects/` fixtures + graders: (a) run-1eda06eb-shaped curated+sources payload -> accepted, extras stripped, assembled text byte-identical to the pool; (b) both-keys -> curated; (c) unknown-id / cross-project / empty-pool -> still fail-closed; (d) K8s-flavoured targets rank platform above frontend in the fallback; (e) description = pitch stamp, survives a simulated guard/condense mutation via the lock; (f) lane-mix (JD-relevant curated beats off-JD composed and vice versa); (g) composed-uncapped entry all-composed and provenance-valid.
- Modify: `docs/runbooks/projects-agent-observability.md` -- normalisedExtras (what it counts, expected trend to zero), projects_description_lock_restored + the retired three-beat, ordering semantics, the highlights budget.
- Sweep: `git diff develop -- applications/job-strategist/src/ats/matching/keyword-match.ts applications/job-strategist/src/ats/gate/summary-coverage.ts` EMPTY; repo-wide grep confirms the fallback 40w pitch-trim path is gone (replaced by the stamp); suite growth only from 152/1297.

- [ ] **Step 1:** eval fixtures + graders green (graders reuse runtime primitives: normaliser, `experienceTermMatch`, provenance validator -- no parallel logic).
- [ ] **Step 2:** runbook (ASCII, UK English).
- [ ] **Step 3:** sweep + gates + commit `test(job-strategist): projects lane coupling evals + observability runbook`

---

## Self-Review

**Spec coverage:** C1 -> T1 (normaliser, hygiene, diagnostics; agent-description discard); C4 description stamp/lock/retirement -> T2; C2 + C4 lane-mix/ordering/cap -> T3; C3 -> T4; Testing section -> per-task tests + T5; invariants (no project creation, archived filtered, fail-closed boundary) restated in Global Constraints and untouched by any task.

**Placeholder scan:** none -- signatures, caps (80 words description, 180 highlights), violation/metric names, fixture letters (a)-(g), and sweep commands are concrete.

**Type consistency:** `normaliseProjectsAgentOutput`/`normalisedExtras` (T1) consumed by T2's stamp site and T5's evals; `stampProjectDescription`/`withProjectsDescriptionLock` (T2) referenced in T5(e); `experienceTermMatch` import named identically in T3 and T5(d); `projectsHighlightWords`/`projectsHighlights` (T4) consistent.
