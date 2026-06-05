# Bar Raiser Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `bar-raiser` coach stage that maps the user's real project evidence to a company's leadership principles and emits grounded, **honesty-calibrated** per-principle prep (Amazon's 16 LPs + generic fallback), rendered in the Bar Raiser workspace.

**Architecture:** Mirror the proven **System Design walkthrough** pipeline end-to-end: an ontology table → project-anchored evidence detection → a phase-specific coach prompt + per-phase schema → anti-invention validation → workspace UI. The only novel piece is the honesty-calibration prompt, which is eval-gated.

**Tech Stack:** ai-applications job-strategist (TS, Bedrock Converse forced tool_use, Sonnet), platform-rds-bootstrap migrations, tucaken-app frontend (React/TS). Branch off `develop` (ai-applications) / `main` (tucaken-app) per each repo's convention; PRs per task.

**Spec:** `docs/superpowers/specs/2026-06-05-bar-raiser-phase1-design.md`

**Reference (copy the pattern):** System Design — `migrations/065_system_design_concerns.sql`, `coach-agent.ts` (`COACH_TOOL`, `SYSTEM_DESIGN_FIELDS`, `coachToolForStage`, `CoachOutputSchema`), `run-coach.ts` (`buildSystemDesignWalkthroughInputs`, `detectConcernEvidence`, `validateSystemDesignWalkthrough`), `prompts/coach/stages/system-design.ts`, tucaken-app `SystemDesignWalkthrough.tsx`.

---

## File Structure
- Create `applications/platform-rds-bootstrap/migrations/066_leadership_principles.sql` — ontology + seed (Amazon 16 LPs + generic).
- Create `applications/job-strategist/src/lib/leadership-principles-repository.ts` — `RdsLeadershipPrinciplesRepository`.
- Create `applications/job-strategist/src/lib/bar-raiser-grounding.ts` — `detectPrincipleEvidence`, `buildBarRaiserBlock`, `validateBarRaiserWalkthrough`.
- Create `applications/job-strategist/src/prompts/coach/stages/bar-raiser.ts` — `BAR_RAISER_DELTA` + calibration few-shots.
- Modify `applications/job-strategist/src/agents/coach-agent.ts` — schema + `BAR_RAISER_FIELDS` + `coachToolForStage`.
- Modify `applications/job-strategist/src/run-coach.ts` — `buildBarRaiserInputs` + wiring.
- Create `applications/job-strategist/src/evals/...` — honesty-calibration eval + stage-focus entry.
- Modify tucaken-app `src/lib/types/applications.types.ts` + `src/features/applications/stages/workspaces/BarRaiserWorkspace.tsx`.

---

## Task 1: Leadership-principles ontology (migration 066 + repository)

**Files:** Create `migrations/066_leadership_principles.sql`; Create `src/lib/leadership-principles-repository.ts`; Test `src/lib/leadership-principles-repository.test.ts`

- [ ] **Step 1: Write the migration** (mirror 065's idempotent global-reference shape):

```sql
-- 066_leadership_principles.sql
-- Curated leadership-principles ontology (Amazon LPs + generic fallback). Global
-- reference data (no user_id, no RLS), idempotent re-seed. Mirrors 065.
BEGIN;
CREATE TABLE IF NOT EXISTS leadership_principles (
    principle_id     TEXT PRIMARY KEY,           -- 'amazon.customer_obsession'
    framework        TEXT NOT NULL,              -- 'amazon' | 'generic'
    name             TEXT NOT NULL,
    interpretation   TEXT NOT NULL,              -- what it ACTUALLY means (not marketing)
    signal_keywords  JSONB NOT NULL DEFAULT '[]'::jsonb,
    story_shapes     JSONB NOT NULL DEFAULT '[]'::jsonb,
    probing_patterns JSONB NOT NULL DEFAULT '[]'::jsonb,
    failure_modes    JSONB NOT NULL DEFAULT '[]'::jsonb,
    display_order    SMALLINT NOT NULL DEFAULT 0,
    source           TEXT NOT NULL,
    as_of            DATE NOT NULL
);
INSERT INTO leadership_principles (principle_id, framework, name, interpretation, signal_keywords, story_shapes, probing_patterns, failure_modes, display_order, source, as_of) VALUES
('amazon.customer_obsession','amazon','Customer Obsession',
 'Start from the user and work backwards; evidence of decisions driven by real user need, not internal preference.',
 '["user research","user need","feedback","ux","support","customer"]'::jsonb,
 '["a decision you reversed after user feedback","building for a user need others dismissed"]'::jsonb,
 '["Whose need was this? How did you know?","What did you give up to serve it?"]'::jsonb,
 '["claiming user focus with no evidence of talking to users"]'::jsonb,
 1,'curated-2026','2026-06-05')
-- … all 16 Amazon LPs, then ~6 generic fallback rows (framework='generic') …
;
COMMIT;
```
Seed **all 16 Amazon LPs** + a **generic** set (`leadership`, `decision_making`, `conflict`, `growth`, `impact`, `integrity`). Interpretations/probing/failure-modes are the curated content — keep them honest and specific (not marketing copy).

- [ ] **Step 2: Repository test (failing)** — `leadership-principles-repository.test.ts`:

```ts
import { RdsLeadershipPrinciplesRepository, frameworkForCompany } from './leadership-principles-repository.js'
it('maps amazon → amazon, others → generic', () => {
  expect(frameworkForCompany('Amazon')).toBe('amazon')
  expect(frameworkForCompany('Stripe')).toBe('generic')
})
```

- [ ] **Step 3: Implement the repository** (mirror the system-design concerns repository):

```ts
export function frameworkForCompany(company: string): 'amazon' | 'generic' {
  return /\bamazon\b/i.test(company) ? 'amazon' : 'generic'
}
export interface LeadershipPrinciple {
  principleId: string; name: string; interpretation: string
  signalKeywords: string[]; storyShapes: string[]; probingPatterns: string[]; failureModes: string[]
}
export class RdsLeadershipPrinciplesRepository {
  constructor(private readonly pool: Pool) {}
  async load(framework: 'amazon' | 'generic'): Promise<LeadershipPrinciple[]> {
    const { rows } = await this.pool.query(
      `SELECT principle_id, name, interpretation, signal_keywords, story_shapes, probing_patterns, failure_modes
         FROM leadership_principles WHERE framework = $1 ORDER BY display_order`, [framework])
    return rows.map(/* snake→camel, JSONB arrays */)
  }
}
```

- [ ] **Step 4: Run test → pass.** `yarn workspace @bedrock/job-strategist test leadership-principles-repository`

- [ ] **Step 5: Commit.** `feat(bar-raiser): leadership-principles ontology (migration 066) + repository`

---

## Task 2: Evidence grounding + validation

**Files:** Create `src/lib/bar-raiser-grounding.ts`; Test `src/lib/bar-raiser-grounding.test.ts`

- [ ] **Step 1: Failing tests** — cover (a) `detectPrincipleEvidence` scores a principle `strong` when project evidence overlaps its `signalKeywords`, `none` when no overlap; (b) `validateBarRaiserWalkthrough` demotes a story whose `evidenceRefs` aren't in the detected set to a gap.

```ts
it('detects strong coverage on keyword overlap', () => {
  const cov = detectPrincipleEvidence([{ principleId:'p', signalKeywords:['migration'], /*…*/ }],
    [{ id:'c1', label:'EKS migration', tokens:['migration','eks'] }], 'jd with migration')
  expect(cov[0].coverage).toBe('strong')
})
it('rejects invented story evidence', () => {
  const out = validateBarRaiserWalkthrough(
    [{ principleId:'p', stories:[{ evidenceRefs:[{id:'ghost'}], /*…*/ }], coverage:'strong', /*…*/ }],
    [{ principleId:'p', evidenceIds:['c1'], coverage:'strong' }])
  expect(out[0].stories).toHaveLength(0)       // ghost ref → story dropped
  expect(out[0].coverage).toBe('none')         // demoted
  expect(out[0].gapGuidance).toBeTruthy()
})
```

- [ ] **Step 2: Implement** — mirror `detectConcernEvidence` (token/signal overlap over the user's project evidence: `project_components`, `story_candidates` from migration 064, repo signals) and `validateSystemDesignWalkthrough` (drop ungrounded stories, demote to gap, set `gapGuidance`). Export `buildBarRaiserBlock(coverage, principles)` → the prompt block string (one section per principle: interpretation, the user's detected evidence ids+labels, probing patterns, story shapes).

- [ ] **Step 3: Run tests → pass.**

- [ ] **Step 4: Commit.** `feat(bar-raiser): principle-evidence detection + anti-invention validation`

---

## Task 3: Per-phase schema

**Files:** Modify `src/agents/coach-agent.ts`

- [ ] **Step 1: Add `barRaiserWalkthrough` to `COACH_TOOL.inputSchema.properties`** — array of principle objects (principleId, principleName, interpretation, coverage enum, stories[] {title, situation, task, action, result, evidenceRefs, honestyCalibration, seniorityNote}, probingQuestions[] {question, framing}, gapGuidance). Reuse `EVIDENCE_REFS_SCHEMA`.

- [ ] **Step 2: Add the Zod mirror to `CoachOutputSchema`** — `barRaiserWalkthrough: z.array(BarRaiserPrincipleSchema).optional()` (optional like `systemDesignWalkthrough`).

- [ ] **Step 3: Add `BAR_RAISER_FIELDS` + wire `coachToolForStage`:**
```ts
export const BAR_RAISER_FIELDS = ['barRaiserWalkthrough'] as const;
// in coachToolForStage: stage === 'bar-raiser' ? BAR_RAISER_FIELDS : …
```

- [ ] **Step 4: Typecheck + lint.** Expected clean.

- [ ] **Step 5: Commit.** `feat(bar-raiser): per-phase coach output schema`

---

## Task 4: Bar-raiser prompt + honesty-calibration eval (the long pole)

**Files:** Create `src/prompts/coach/stages/bar-raiser.ts`; Modify `src/prompts/coach/stages/index.ts` (register stage); Create eval under `src/evals/`

- [ ] **Step 1: Write `BAR_RAISER_DELTA`** (mirror `SYSTEM_DESIGN_DELTA` structure): instruct one `barRaiserPrinciple` card per principle in the block; stories grounded ONLY in cited evidence; **honesty calibration** per story (solo work ≠ "led a team"; estimate ≠ measured number; timeline accuracy); honest gap framing when `coverage=none`; seniority note. Include the **anti-invention** rules verbatim from spec §5. Add 3-5 hand-written calibration few-shots from real project stories.

- [ ] **Step 2: Register `bar-raiser` in `stages/index.ts`** (`assembleCoachSystemPrompt` switch) so the base + bar-raiser delta assemble. Confirm the dispatch already allows it (`INTERVIEW_PREP_STAGES` includes `bar-raiser`).

- [ ] **Step 3: Write the per-phase eval** (per CLAUDE.md §5) — `src/evals/fixtures/bar-raiser.json` (a gold output: grounded stories + honest gaps + calibration) and a grader checking: no inflation language ("led a team" without team evidence), every story evidenceRef present, gaps framed honestly, `barRaiserWalkthrough` non-empty when evidence exists. Add a `barRaiser` branch to `stage-focus-grader.ts`.

- [ ] **Step 4: Run the eval against the fixture → pass.**

- [ ] **Step 5: Commit.** `feat(bar-raiser): stage prompt + honesty-calibration few-shots + per-phase eval`

---

## Task 5: run-coach wiring

**Files:** Modify `src/run-coach.ts`

- [ ] **Step 1: `buildBarRaiserInputs(pool, env, research)`** (mirror `buildSystemDesignWalkthroughInputs`): `framework = frameworkForCompany(env.targetCompany)`; load principles; load the user's project evidence; `detectPrincipleEvidence`; return `{ block: buildBarRaiserBlock(coverage, principles), coverage, principles }`. Fail-open (non-fatal) like the system-design version.

- [ ] **Step 2: Wire into `main()`** for `interviewStage === 'bar-raiser'`: pass `br.block` to `executeCoachAgent`; after the call, `validateBarRaiserWalkthrough(coaching.data.barRaiserWalkthrough, br.coverage)` + attach `barRaiserCoverage` (code-authoritative). The existing grounding + prose verifiers already run for every stage.

- [ ] **Step 3: Typecheck + build.** Expected clean.

- [ ] **Step 4: Commit.** `feat(bar-raiser): run-coach wiring (build inputs + validate + coverage)`

---

## Task 6: Dogfood + calibrate

- [ ] **Step 1: Apply migration 066 to dev** (via the existing direct-apply deploy — `deploy-platform-rds-bootstrap` builds the image; the `apply-migrations` job runs it). Confirm `SELECT count(*) FROM leadership_principles WHERE framework='amazon'` = 16.
- [ ] **Step 2: Run the bar-raiser coach** against the owner's portfolio targeting Amazon (via the smoke MCP or a real UI trigger once deployed). Inspect the persisted `barRaiserWalkthrough`.
- [ ] **Step 3: Quality gate** — stories from real work mapped to LPs, honest calibration, predictable solo-work gaps with graceful framing. Iterate `BAR_RAISER_DELTA` + few-shots against the eval until the dogfood bar is met: *would you take this into a real Amazon Bar Raiser?*

---

## Task 7: Workspace UI (tucaken-app)

**Files:** Modify `src/lib/types/applications.types.ts`; rewrite `src/features/applications/stages/workspaces/BarRaiserWorkspace.tsx`; Test `stage-components.test.tsx`

- [ ] **Step 1: Add types** — `BarRaiserPrinciple`, `BarRaiserStory` (mirror the `SystemDesignCard` types added for #70); extend `InterviewPrepOutput` with `barRaiserWalkthrough?` + `barRaiserCoverage?`.
- [ ] **Step 2: Build the renderer** — read `resolveStagePrep(detail,'bar-raiser').barRaiserWalkthrough`; per-principle `Card`: name + interpretation + coverage badge (🟢/🟡/🔴); grounded STAR stories; **honesty-calibration callout** per story; probing questions; seniority note; gap guidance. Reuse the `SystemDesignWalkthrough.tsx` structure. Keep the existing user story bank as a secondary section. Extract sub-components to stay under the complexity:10 cap (see TechnicalWorkspace's `…Supplements` pattern).
- [ ] **Step 3: Test** — grounded + gap principle cards render; coverage header. Typecheck + lint + test clean.
- [ ] **Step 4: Commit + PR (base `main`).**

---

## Self-review notes
- Spec coverage: ontology+repo §2→T1; grounding/validation §2/§5→T2; schema §2→T3; prompt+calibration+eval §2/§4/§6→T4; wiring §2→T5; dogfood §6→T6; UI §2→T7. All covered.
- Anti-invention (§5) is enforced in T2 (`validateBarRaiserWalkthrough`) AND T4 (prompt rules) — defence in depth, intentional.
- Honesty calibration is the long pole (T4) and is eval-gated per CLAUDE.md §5.
- Deferred items (metric validation, 20-company taxonomy, AI-judgment) have NO tasks here — correct; they're Phases 2-4.
- Every backend task mirrors a named System Design file; the implementer should open that file and copy the pattern rather than invent.
