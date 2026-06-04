# System Design — Project-Anchored Socratic Walkthrough (v1)

**Date:** 2026-06-04
**Status:** Design — pending review
**Stage:** `system-design` interview coaching
**Predecessors:** [[skill-transfer-technical]], coach eval-suite + prompt refactor (PR #130)

## 1. Goal

Turn the `system-design` coach stage from a Technical-clone into a **Project-anchored
rehearsal**: walk the candidate through their *own* project, concern by concern, as an
interviewer would — surfacing where their code answers each concern, how to articulate the
choice they made, the follow-ups to expect, and the gaps where their code is weak.

Every claim is grounded in real project evidence (file:line). Gaps are surfaced honestly,
never papered over with invented answers. This is the product's signature differentiator:
generic prep lists concepts; this walks the user through their actual engineering work.

## 2. Non-goals (deferred)

- **Practice mode** (sequential Q→articulate→reveal). v1.5.
- **Interview transcript analysis / feedback loop.** v2.
- **Embedding-based JD↔project relevance scoring.** v1 derives alignment from deterministic
  concern-coverage count instead (`summary_embedding` stays unpopulated).
- **Full 150-concern ontology.** v1 seeds ~12–15 top-frequency, discriminating concerns;
  expandable by appending rows.
- **UI + serve endpoint.** These live in `tucaken-app` (separate repo). v1 produces and
  persists the structured walkthrough; rendering is a follow-up there.

## 3. Architecture — fits the existing single-call coach

No new pipeline, no agent-to-agent. The existing K8s coach Job (`run-coach.ts`) gains a
deterministic pre-step (concern detection) and a richer stage output. Mirrors how
phone-screen (career arc / comp script) and technical (skill-transfer) already work.

```
run-coach (system-design stage)
  ├─ load project evidence            (RdsProjectEvidenceRepository — exists)
  ├─ load concern ontology            (RdsSystemDesignConcernRepository — NEW, table 065)
  ├─ detectConcernEvidence(...)       (NEW pure module — deterministic, grounded)
  │     → per concern: {strength, evidenceRefs[]}  +  coverage map  +  alignment count
  ├─ buildConcernWalkthroughBlock()   (NEW — serialise relevant concerns + detected evidence)
  ├─ executeCoachAgent(...)           (single forced-tool call; emits systemDesignWalkthrough)
  ├─ validateSystemDesignWalkthrough  (NEW — anti-invention, demote ungrounded cards to gap)
  ├─ verifyCoachGrounding             (existing — text-level, all stages)
  └─ persistCoachingContent           (existing — into coaching_content.topics_to_study)
```

## 4. Data model

### 4.1 Ontology table — migration `065_system_design_concerns.sql`

Global reference data (no `user_id`, no RLS), idempotent seed, every row cites `source`/`as_of`.
Follows `dsa_topics` (051) / `ai_topics` (057) exactly.

```sql
CREATE TABLE IF NOT EXISTS system_design_concerns (
    concern_id          TEXT PRIMARY KEY,          -- e.g. 'data_isolation_tenant_scoping'
    category            TEXT NOT NULL,             -- one of the 13 top-level categories
    concern_question    TEXT NOT NULL,             -- interviewer framing
    why_interviewers_ask TEXT NOT NULL,
    detection_signals   JSONB NOT NULL DEFAULT '[]'::jsonb,  -- token/phrase signals for code-evidence match
    implementation_patterns JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{name,strengths[],gotchas[]}]
    follow_up_questions JSONB NOT NULL DEFAULT '[]'::jsonb,  -- string[]
    gap_signals         JSONB NOT NULL DEFAULT '[]'::jsonb,  -- string[] (partial-evidence red flags)
    jd_signal_keywords  JSONB NOT NULL DEFAULT '[]'::jsonb,  -- JD relevance match
    importance          SMALLINT NOT NULL DEFAULT 5,         -- base ordering weight (1=universal..10=niche)
    source              TEXT NOT NULL,
    as_of               DATE NOT NULL
);
```

**v1 seed (~12–15 concerns)** across the 13 categories, one or two of the highest-frequency
each: auth/authz, tenant data-isolation, API design & protection, DoS/abuse, concurrency,
scaling, consistency/durability, observability, performance/caching, cost, security-beyond-auth,
reliability patterns, AI-specific. Each fully populated in the concern shape from the spec
narrative (detection_signals, implementation_patterns, follow_up_questions, gap_signals).

### 4.2 Detection output (in-memory, `shared`)

```ts
type ConcernStrength = 'strong' | 'partial' | 'none';
interface DetectedConcern {
  concernId: string;
  category: string;
  strength: ConcernStrength;
  evidenceRefs: EvidenceRef[];          // {source,id,label,fileLine} — reuse skill-transfer shape
  relevantToJd: boolean;
}
interface ConcernCoverage {              // drives the coverage map + alignment count
  detected: DetectedConcern[];
  relevantTotal: number;
  relevantAddressed: number;             // strength !== 'none'
}
```

Strength rule: ≥1 `demonstrated`-tier signal (component/decision) → `strong`; only
claimed/declared signals → `partial`; none → `none`. (Same tiering as `joinSkillCandidates`.)

### 4.3 Coach output — new field on `InterviewCoachResult`

```ts
interface SystemDesignFollowUp {
  question: string;
  status: 'addressed' | 'partial' | 'gap';   // 🟢 🟡 🔴
  framing: string;                            // how to answer (honest for gap/partial)
}
interface SystemDesignWalkthroughCard {
  concernId: string;
  concernQuestion: string;
  whyItMatters: string;                       // 1–2 sentences, role-calibrated
  evidenceRefs: EvidenceRef[];                // cited from detection — never invented
  choiceMade: string | null;                  // null when strength='none'
  articulation: string;                       // first-person rehearsal script (or honest gap framing)
  followUps: SystemDesignFollowUp[];
  gapGuidance: string | null;                 // honest handling when partial/none
}
// InterviewCoachResult gains:
readonly systemDesignWalkthrough?: readonly SystemDesignWalkthroughCard[];
readonly systemDesignCoverage?: ConcernCoverage;   // coverage map + alignment, deterministic
```

`systemDesignCoverage` is written **deterministically by run-coach** (not the model) so the
coverage map / alignment count are trustworthy. The model fills only the per-card prose.

## 5. Components to build

**`platform-rds-bootstrap`**
- `migrations/065_system_design_concerns.sql` — table + ~12–15 seeded concerns.

**`shared`**
- `stage-prep/system-design-concerns-types.ts` — `SystemDesignConcern`, `DetectedConcern`,
  `ConcernCoverage`, card/follow-up types (exported via `stage-prep/index.js`).
- `rds/implementations/RdsSystemDesignConcernRepository.ts` — `listConcerns()` (mirrors
  `RdsDsaTopicRepository`).
- `stage-prep/concern-detection.ts` — `detectConcernEvidence(concerns, evidence, jdSignals)`
  → `ConcernCoverage`. Pure, deterministic, reuses the skill-transfer tokenizer.
- `stage-prep/system-design-walkthrough.ts` — `validateSystemDesignWalkthrough(cards, detected)`:
  drop cards for unknown concernIds; demote any card whose `evidenceRefs` aren't in the
  detected set to a gap card (`choiceMade=null`, `evidenceRefs=[]`, honest `articulation`).

**`job-strategist`**
- `prompts/coach/stages/system-design.ts` — rewrite `SYSTEM_DESIGN_DELTA` to the Socratic
  walkthrough instructions (first-person articulation discipline, predicted follow-ups with
  status, honest gaps, cite only the concern block).
- `agents/coach-agent.ts` — add `systemDesignWalkthrough` to `COACH_TOOL` schema +
  `CoachOutputSchema`; `coachToolForStage('system-design')` promotes it to required; add
  `buildConcernWalkthroughBlock(coverage, concerns)` serialiser (sibling to
  `buildSkillCandidateBlock`).
- `run-coach.ts` — for system-design: load concerns + evidence, `detectConcernEvidence`,
  pass block to coach, run `validateSystemDesignWalkthrough`, attach deterministic
  `systemDesignCoverage`.
- `prompts/coach/stages/index.ts` — `stageUsesSkillTransfer` reverts to **technical-only**;
  add `stageUsesSystemDesignWalkthrough(stage)` (system-design only).

**`evals`**
- `evals/graders/system-design-grader.ts` — grounding (every `evidenceRef` ∈ detected set),
  honesty (gap cards carry no evidence/choice), coverage (every JD-relevant concern has a card).
- `evals/fixtures/system-design.json` — replace the current technical-clone fixture with a
  walkthrough gold fixture; register in `coach-evals.test.ts`.
- `evals/graders/stage-focus-grader.ts` — move `system-design` out of the skillTransfer
  branch; its focus check now asserts `systemDesignWalkthrough` presence when concerns were
  detected. Update `stage-focus-grader.test.ts` accordingly.

## 6. Data flow & grounding

1. Detection is **deterministic and grounded by construction** — evidenceRefs come only from
   real project rows (with file:line). The model cannot introduce evidence the detector didn't find.
2. The coach articulates *from the concern block*; `validateSystemDesignWalkthrough` is the
   deterministic backstop (mirrors `validateSkillTransfer`) — any drift → honest gap.
3. `verifyCoachGrounding` (already runs every stage, flag mode, fail-open) covers the free-text
   articulations as the text-level layer.
4. `systemDesignCoverage` (counts, coverage map) is computed in code, never by the model.

## 7. Error handling

Fail-open throughout, matching `buildSkillCandidateSets`: if the ontology load or detection
throws, log non-fatal and fall back to the existing generic system-design coaching (empty
walkthrough) rather than failing the run. Zero projects / zero detected concerns → empty
walkthrough + coverage `{relevantTotal:N, relevantAddressed:0}` so the UI can still render
"prepare to discuss these concerns; your project has no evidence yet."

## 8. Testing

- Pure unit tests: `concern-detection.test.ts` (strength tiers, evidence refs, JD filtering),
  `system-design-walkthrough.test.ts` (validate demotes ungrounded cards, preserves honest gaps).
- Tier-1 eval: system-design walkthrough gold fixture passes schema + grounding + honesty +
  coverage graders.
- `RdsSystemDesignConcernRepository` exercised via the eval/seed (no live DB in CI).
- Full `job-strategist` suite green; typecheck + ESLint (`complexity:10`) clean on touched files.

## 9. Build sequence (each ends in a [git-commit skill] commit)

1. `feat(rds): system_design_concerns ontology table + v1 seed` (migration 065).
2. `feat(shared): system-design concern types + repository`.
3. `feat(shared): deterministic concern detection + walkthrough validator` (+ unit tests).
4. `feat(job-strategist): system-design walkthrough coach output` (delta rewrite, schema/tool,
   run-coach wiring, stage-gate split).
5. `test(job-strategist): system-design walkthrough grader + gold fixture`.

## 10. Follow-ups (tracked, not in v1)

- tucaken-app: serve endpoint reading `coaching_content` + walkthrough/coverage-map UI.
- Expand ontology toward the full ~100–150 concerns from real interview feedback.
- Practice mode (v1.5); transcript analysis (v2); embedding JD-relevance scoring.
- Pre-existing `complexity:10` lint debt in untouched job-strategist files (separate PR).
