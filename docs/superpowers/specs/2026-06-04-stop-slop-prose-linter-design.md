# stop-slop prose-quality linter — design (v1)

**Date:** 2026-06-04
**Status:** Approved (brainstorming) — pending implementation plan
**Scope:** Add a post-generation prose-quality linter to the coach pipeline that
catches AI-tell language. Flag-only, non-mutating. Mirrors the groundedness
verifier's architectural slot.

---

## 1. Motivation

Coach output is prose that goes to high-stakes hiring contexts (talking points,
answer frameworks, skill-transfer narratives). In the 2026 market, recruiters
actively screen for AI-generated language. AI-tell phrasing in Tucaken's output
actively harms users.

[stop-slop](https://github.com/hardikpandya/stop-slop) is a bounded, well-documented
**critic** skill (not a generator): it catches and scores the linguistic patterns
that mark text as AI-generated. It sits in the same architectural slot as our
existing `BedrockGroundingVerifier`:

- Grounding asks: *is this true and traceable to evidence?*
- stop-slop asks: *does this read as human?*

Orthogonal axes, identical fail-open contract. The two run side by side.

This is a **utility critic** integration, not a domain-content dependency. We fork
the rule lists into the repo and version them with our code — no runtime dependency
on the upstream repo, no Claude Code coupling (coach runs as a K8s Job invoking
Bedrock directly, not inside Claude Code).

---

## 2. Locked decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| v1 scope | **Coach output only** | Smallest blast radius; one eval set. |
| Fail action | **Flag-only** (log + telemetry, fail-open) | Gather tuning signal before enforcing; never degrade a working coach run. |
| Model | **Sonnet** (`claude-sonnet-4-6`) | CLAUDE.md rule 4 — nuanced multi-section structured output defaults to Sonnet. Scoring 5 dimensions + categorizing violations is exactly that class. |
| Output | **5-dim score + `issues[]`**, no rewrite | Everything needed to telemetry-track + tune upstream prompts. Rewrite unused in flag mode. |
| Slicing | **A — single-pass, tagged sections** | One Sonnet call per coach run; per-surface attribution via `location` tag; simplest eval. |

---

## 3. Component placement

New shared module, mirroring `applications/shared/src/grounding/`:

```
applications/shared/src/prose-quality/
  bedrock-prose-linter.ts     # BedrockProseLinter class
  prose-quality-types.ts      # input / output / issue types
  prompt/
    system-prompt.ts          # assembles role + rules + rubric (+ cachePoint)
    tool-schema.ts            # emit_prose_quality forced-tool JSON schema
  rules/
    phrases.ts                # forked stop-slop references/phrases.md
    structures.ts             # forked stop-slop references/structures.md
    rubric.ts                 # 5-dim scoring rubric + threshold constant
  PROVENANCE.md               # upstream repo, pinned commit, license
  index.ts                    # barrel
```

Exported from `applications/shared/src/index.ts` next to the grounding exports.
Coach is the **only** consumer in v1 — shared placement is simply where verifiers
live, not a sign of broader wiring.

### Provenance (PROVENANCE.md)

- Upstream: `https://github.com/hardikpandya/stop-slop`
- Pinned commit: `8da1f030185bdfe8471220585162991eaeb970e9` (2026-03-17)
- License: MIT (verify `LICENSE` at fork time; reproduce attribution)
- Forked files: `references/phrases.md` → `rules/phrases.ts`,
  `references/structures.md` → `rules/structures.ts`, scoring rubric → `rules/rubric.ts`
- Update protocol: bump the pinned SHA, re-run the eval suite, reconcile diffs.
  The fork is Tucaken's evolving prose style guide — local additions allowed.

---

## 4. Interface

Mirrors `BedrockGroundingVerifier` (config → `lint()` → structured result + cost ctx).

```ts
type ProseRegister = 'resume-prose' | 'storytelling' | 'advice' | 'narrative';

interface BedrockProseLinterConfig {
  mode: 'flag';                 // only 'flag' in v1; 'block' reserved, not implemented
  modelId?: string;             // default 'claude-sonnet-4-6' (region-prefixed at impl)
  client?: BedrockRuntimeClient;
}

interface ProseSection {
  location: string;             // e.g. "jdTalkingPoints[2]"
  register: ProseRegister;
  text: string;
}

interface ProseQualityInput {
  sections: readonly ProseSection[];
  stage?: InterviewStage;       // context hint only
}

interface ProseIssue {
  category: 'phrase' | 'structure';
  match: string;                // offending text
  location: string;             // which section fired
  severity: 'high' | 'medium' | 'low';
  rule: string;                 // which rule matched
}

interface ProseScore {
  directness: number;           // each 1..10
  rhythm: number;
  trust: number;
  authenticity: number;
  density: number;
  total: number;                // sum, 5..50
}

interface ProseQualityResult {
  status: 'PASS' | 'FAIL';
  score: ProseScore;
  belowThreshold: boolean;
  issues: readonly ProseIssue[];
}

interface IProseLinter {
  lint(input: ProseQualityInput, costCtx?: GroundingCostContext): Promise<ProseQualityResult>;
}

class BedrockProseLinter implements IProseLinter { /* ... */ }
```

Reuse the existing `GroundingCostContext` (`{ pool, userId }`) type from
`applications/shared/src/grounding/` rather than inventing a parallel cost-context type.

---

## 5. Prompt assembly + Sonnet call (CLAUDE.md rules 1–3)

Single phase (one unit of work), so no branch logic — a clean base prompt.

**System prompt** = stop-slop critic role + `phrases.ts` + `structures.ts` +
`rubric.ts`, assembled with a Bedrock `cachePoint` after the static rule block.
The rules never vary per call → cached across coach runs (same trick as
`COACH_BASE_TEXT`).

**User message** = the tagged document:

```
<section location="jdTalkingPoints[0]" register="resume-prose">…</section>
<section location="behaviouralQuestions[1].answerFramework" register="storytelling">…</section>
...
```

The `register` attribute lets Sonnet calibrate (business-formal advice prose
should not be flagged as "business jargon" the way resume prose would).

**Call:** forced-tool output via `emit_prose_quality` (`toolChoice` forced, no
extended thinking — the same Bedrock constraint the coach agent already handles).
Tool input schema = the `ProseQualityResult` shape (CLAUDE.md rule 3: one tight
schema for this phase). Invoke through the existing `runAgent` / `ConverseCommand`
wrapper. Record cost via `recordBedrockCost()` when `userId` present; emit an EMF
metric.

**Fail-safe parse (fail-OPEN):** any unparseable / errored model output →
`status:'PASS'`, `belowThreshold:false`, empty `issues`, plus a logged warning.

> This inverts the grounding verifier's fail-*safe* default (unparseable →
> `NOT_GROUNDED`). A broken grounding check should distrust output; a broken
> *style* check must never degrade a working coach run. Different failure-mode
> severity → different safe default.

---

## 6. Extraction + integration

**New extractor** `applications/job-strategist/src/lib/coach-prose.ts`:

```ts
function extractProseSections(coaching: InterviewCoachResult): ProseSection[];
```

Pulls each prose surface from `InterviewCoachResult`, assigns `location` +
`register`. Sibling to the existing `coach-grounding.ts` extractors. Prose surfaces
to cover (final list confirmed against the type during implementation):
`stageDescription`, `careerArcSummary`, `coachingNotes`, `jdTalkingPoints[].point`,
`technicalQuestions[].answerFramework`, `behaviouralQuestions[].answerFramework`,
`skillTransfer[].narrative`.

**Hook** in `applications/job-strategist/src/run-coach.ts`, beside the grounding
call (after `executeCoachAgent`, before `persistCoachingContent`):

```ts
const proseLinter = new BedrockProseLinter({ mode: 'flag' });
try {
  const quality = await proseLinter.lint(
    { sections: extractProseSections(coaching.data), stage: env.interviewStage },
    { pool, userId: env.userId },
  );
  logProseQuality(quality);        // structured log + EMF; never mutates coaching.data
} catch (err) {
  logProseLinterError(err);        // swallow — linter never throws into the coach run
}
```

Persisted coach output is **untouched**. Linter failure is caught and logged,
never propagated.

---

## 7. Evals (CLAUDE.md rule 5 — non-negotiable)

**New grader** `applications/job-strategist/src/evals/graders/prose-quality-grader.ts`
+ a dedicated fixture set under `evals/fixtures/prose-quality/`:

- **clean fixtures** — human-sounding prose → expect `PASS`, no high-severity issues.
- **slop fixtures** — seeded with known stop-slop phrases ("It's worth noting…",
  binary "not X, but Y", throat-clearing openers) → expect those exact issues caught,
  `status:'FAIL'`.
- **schema check** — valid `ProseQualityResult`; each dimension in 1..10; total in 5..50.
- **register calibration** — a business-formal section does not trip "business
  jargon" on normal phrasing.

Deterministic structure graders run in Jest (gold fixtures). A live run against
Sonnet validates real scoring before merge. **No prompt change ships without this
suite passing** (rule 5).

---

## 8. Out of scope (v1 — YAGNI)

- Block / regenerate-on-fail mode (`mode:'block'` reserved in the type, not implemented).
- article-pipeline + resume wiring.
- Per-surface scoring (approach B) and register bucketing (approach C).
- Rewrite suggestions.
- User-facing surfacing of scores.

All deferred to follow-up PRs; v1's job is cheap tuning signal under flag mode.

---

## 9. ESLint

Run ESLint before considering any code change complete (project rule).
