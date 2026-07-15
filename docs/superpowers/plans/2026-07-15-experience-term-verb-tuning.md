# Experience Term-Rule v2 + Verb-Alignment Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify the experience scorer's term matching onto `matchTier1` (emphasis-strip + light stemming) so grounded targets stop missing on token spelling, and add a deterministic verb-alignment guard routed through the existing single provenance-validated re-write.

**Architecture:** Two components from the approved spec (docs/superpowers/specs/2026-07-15-experience-term-verb-tuning-design.md): (1) `experienceTermMatch` = emphasis-strip -> lightStem both sides -> `matchTier1`, shared by the scorer's term path and `anchorsFor`, replacing the bespoke all-tokens machinery; (2) `checkVerbAlignment` with a tiered lexicon and an any-cited-line mid-line ceiling, folded into `routeExperienceJdEcho` -> `routeExperienceRepairs` (still ONE routed call per run).

**Tech Stack:** TypeScript, jest, existing matching subsystem (keyword-match.ts untouched), existing agent lanes (no new LLM calls).

## Global Constraints

- Branch `feat/experience-term-verb-tuning` (exists, spec committed). ONE commit per task, impact-bullet body, no Co-Authored-By.
- Gates per task: full `yarn workspace @bedrock/job-strategist test` green (growth only from 151 suites / 1271 tests), `yarn workspace @bedrock/job-strategist exec tsc --noEmit` clean, ROOT `yarn eslint <changed files>` (NEW functions complexity <= 10; pre-existing violations exempt), ASCII-only added lines, UK English.
- NEVER `git stash` (use `git show HEAD:<path>`). Fail-open on every new path. DO NOT modify `ats/matching/keyword-match.ts` or `ats/gate/summary-coverage.ts`. Persona `.md` only if genuinely needed (then: front-matter version bump + manifest sha regeneration via the prompt-content-integrity suite).
- Deterministic throughout: no LLM in scorer or guard; violations that cannot be repaired stay advisory (never a new fallback path).

---

### Task 1: experienceTermMatch -- emphasis-strip + lightStem + matchTier1

**Files:**
- Modify: `applications/job-strategist/src/ats/gate/experience-coverage.ts` (DELETE `GENERIC_TARGET_TOKENS`, `requiredTerms`, `matchesAllTerms`, local `tokenize`; ADD the new predicate)
- Modify: `applications/job-strategist/src/ats/gate/experience-ats-targets.ts` (`anchorsFor` swaps to the shared predicate)
- Test: `applications/job-strategist/src/ats/gate/__tests__/experience-coverage.test.ts` (migrate old-machinery tests; add live cases), `.../__tests__/experience-ats-targets.test.ts` (anchor expectations re-derived under the new predicate)

**Interfaces (Produces -- Task 2/3 rely on these exact names):**
```ts
// experience-coverage.ts
export const EXPERIENCE_EMPHASIS_TOKENS: ReadonlySet<string>;
// [mission, critical, rapid, rapidly, complex, deep, extensive]
export function lightStem(token: string): string;
// strip trailing 'ly', then trailing 'ing', each ONLY when the remaining stem is >= 4 chars; idempotent
export function experienceTermMatch(targetSkill: string, text: string): boolean;
// 1. tokens(targetSkill) minus EXPERIENCE_EMPHASIS_TOKENS; if EVERYTHING stripped, fall back to the unstripped token set
// 2. lightStem each remaining target token; lightStem every token of `text`
// 3. matchTier1(strippedTargetJoined, stemmedText)
// scoreExperienceCoverage keeps its signature; term path now uses experienceTermMatch per bullet
```

- [ ] **Step 1:** failing tests -- lightStem: `rapidly->rapid`, `learning->learn`, `scripting->script`, `ring->ring` (min-length guard), `fly->fly`, idempotence (`lightStem(lightStem(x)) === lightStem(x)`). experienceTermMatch live cases (texts verbatim from the spec): "mission-critical production database systems" vs the DB bullet -> true; "code reading and scripting" vs the JavaScript tooling bullet -> true (language-cue path); "rapid technical learning" vs the self-training line -> false (honest synonym gap); "Linux systems engineering" vs the Amazon Linux bullet -> true (regression); all-emphasis target (e.g. "mission critical") falls back to unstripped tokens (never empty); proximity still enforced (two required tokens in unrelated sentences of one text -> false).
- [ ] **Step 2:** implement; swap `scoreExperienceCoverage`'s term path and `anchorsFor` onto the predicate; delete the four old symbols; migrate/replace their tests (the old all-generic fallback test becomes the all-emphasis fallback test). Grep repo-wide for the deleted names -- zero references must remain.
- [ ] **Step 3:** gates + commit `feat(job-strategist): experience term matching unified onto matchTier1 (emphasis-strip + light stemming)`

### Task 2: verb-alignment guard + routeExperienceRepairs

**Files:**
- Create: `applications/job-strategist/src/agents/writer/verb-alignment.ts` (+ `__tests__/verb-alignment.test.ts`)
- Modify: `applications/job-strategist/src/agents/writer/experience-ats-flow.ts` (`routeJdEchoRewrite` generalises), `experience-message.ts` (`verbAlignment` block beside `echoCleanup`), `experience-agent-diagnostics.ts` (Loki event), `run-pipeline.ts` (`routeExperienceJdEcho` -> `routeExperienceRepairs`, verb check wiring, violation records)

**Interfaces:**
```ts
// verb-alignment.ts
export const VERB_TIERS: ReadonlyMap<string, 1 | 2 | 3 | 4>;
// tier 1: assist, support, help, contribute, participate
// tier 2: troubleshoot, diagnose, resolve, investigate, debug, triage, guide, analyse, analyze, audit, monitor
// tier 3: own, lead, manage, drive, deliver, coordinate, run
// tier 4: architect, design, establish, found, invent
export interface VerbAlignmentFinding { role: number; bullet: number; verb: string; tier: number; ceiling: number; }
export function checkVerbAlignment(kept: ExperienceAgentOutput, lines: readonly IndexedCareerLine[]): VerbAlignmentFinding[];
// lead verb = first non-adverb token of the bullet (skip tokens ending 'ly'), lightStem'd, looked up in VERB_TIERS;
// unknown lead verb -> skip. ceiling = max tier of ANY lexicon verb appearing ANYWHERE (lightStem'd, whole-word)
// in ANY cited line resolvable in `lines`; bullet skipped when no cited line resolves. tier > ceiling -> finding.
```

- [ ] **Step 1:** failing tests -- upgrade flagged ("Owned ..." citing only an "Assisted ..." line -> finding {tier:3, ceiling:1}); the live case compliant ("Owned ..." citing the "Assisted" line AND the "own cases end-to-end" line -> no finding, mid-line "own" counts); unknown lead verb neutral ("Prototyped ..." -> no finding); leading adverb skipped ("Rapidly self-trained ..." lead verb resolution); unresolvable sources skipped; analyse/analyze both tier 2.
- [ ] **Step 2:** implement module; generalise the routed call: `routeJdEchoRewrite` -> `routeExperienceRepairs(params)` accepting `{ echoDetails: string[]; verbFindings: VerbAlignmentFinding[] }`, ONE rewrite call when either is non-empty, provenance-validated exactly as today (invalid/throw -> original stands); `experience-message.ts` gains `verbAlignment?: { findings: Array<{ bulletText: string; verb: string; supported: string }> }` rendered under its own heading ("align each lead verb to what the cited lines support; never weaken a verb the evidence does support"); run-pipeline: run `checkVerbAlignment(kept, careerLines)` after guardResume alongside echo collection, `violationLog.record('resume_guard', 'experience_verb_upgrade')` per finding, pass both into the single routed call, and after a successful splice re-run `checkVerbAlignment` on the new output for diagnostics only (no second rewrite). Loki: `experience_verb_alignment` event in experience-agent-diagnostics.ts emitted when findings are non-empty (indices + lexicon verbs only -- bounded); `experienceAgentOutcome` untouched.
- [ ] **Step 3:** gates + commit `feat(job-strategist): deterministic verb-alignment guard routed through the single experience re-write`

### Task 3: evals + runbook + sweep

**Files:**
- Modify: `applications/job-strategist/src/evals/experience/fixtures.ts` + `experience-graders.ts`/`.test.ts` -- term fixtures: MISSION_CRITICAL_DB (covered), CODE_SCRIPTING (covered via language cue), RAPID_LEARNING (stays missing -- honest), LINUX regression (stays covered); verb fixtures: VERB_UPGRADE (assisted-only citation, expect finding + grader rejects unaligned output), VERB_LEGITIMISED (live two-citation case, expect clean).
- Modify: `docs/runbooks/experience-agent-observability.md` -- add the `experience_verb_alignment` event and the `experience_verb_upgrade` violation code to the surfaces; note term-rule v2 (coverage now term-tolerant; "missing" = true synonym/evidence gap).
- Sweep: repo-wide grep -- `GENERIC_TARGET_TOKENS|requiredTerms|matchesAllTerms` zero hits; `routeJdEchoRewrite` zero hits (renamed); suite growth only from 151/1271; keyword-match.ts and summary-coverage.ts byte-identical to develop (`git diff develop -- <paths>` empty).

- [ ] **Step 1:** eval fixtures + grader assertions green (graders keep using `scoreExperienceCoverage`/`bulletsOf` -- runtime parity holds automatically).
- [ ] **Step 2:** runbook additions (ASCII, UK English).
- [ ] **Step 3:** sweep + gates + commit `test(job-strategist): term-rule v2 + verb-alignment evals and runbook`

---

## Self-Review

**Spec coverage:** Component 1 -> T1 (predicate, deletions, anchor swap, live expectations); Component 2 -> T2 (lexicon verbatim, any-cited-line mid-line ceiling, single routed call, re-check after splice, Loki + violation code); Testing section -> per-task tests + T3 evals/runbook/sweep; error-handling constraints restated in Global Constraints.

**Placeholder scan:** none -- signatures, lexicon, fixture names, expected verdicts, and grep gates are all concrete.

**Type consistency:** `experienceTermMatch`/`lightStem`/`EXPERIENCE_EMPHASIS_TOKENS` (T1) referenced identically in T2's lead-verb stemming and T3's fixtures; `VerbAlignmentFinding` shape matches the message block and Loki event fields; `routeExperienceRepairs` params named identically in T2 wiring and T3 sweep.
