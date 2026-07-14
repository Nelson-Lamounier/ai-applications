# Phase 3 — Summary ↔ ATS Optimisation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the resume Summary ATS-aware against the JD's attainable must-haves — surface the top few high-value keywords naturally, measure the Summary's own coverage, re-write once if too low, with full Loki/DB/metric observability and isolated LLM cost — without ever overriding truthfulness or the fit-thesis narrative.

**Architecture:** A summary-ATS lane inside `fillResumeSummary` (the existing splice, before the whole-resume ATS check): ledger-sourced top-3 targets → ATS-aware first pass → deterministic coverage score → one bounded guard-safe re-write if `<2` covered → keep the better guard-passing candidate. Observability across Loki (per-event trace), `pipeline_runs.metadata.analysis.summaryAts` (durable diagnostics), Prometheus (trend), and `prompt_invocations` (isolated cost via distinct agent names).

**Tech Stack:** TypeScript (ESM, `.js` specifiers), ts-jest, Zod, prom-client, Postgres, AWS Bedrock (`runAgent`), Grafana/Loki (structured logs via Alloy).

## Global Constraints

- **EXECUTION DEFERRED:** do not start until PR #477 (summary agent) **and** #479 (ATS fixes) are merged to develop. Branch `feat/summary-ats` off the post-merge develop. Every file path below assumes that base.
- Run ESLint on changed files; `yarn workspace @bedrock/job-strategist exec tsc --noEmit`; keep the full suite green.
- No prompt change ships without its eval (CLAUDE.md §5): the `summary.md` change is validated by the summary eval + the live UI JD A/B.
- Summary agent uses Sonnet (§4). `prompt-manifest.json` integrity test pins `version`↔`sha256` per `content/**/*.md` — bump both on any edit.
- Truthfulness precedence (INVARIANT): targets are only `verified`/`transferable` ledger entries, NEVER `gap`; ATS never breaks the fit-thesis, the 100-word cap, the no-gap rule, or the altitude rule; a Summary that cannot honestly carry 2 targets ships at lower coverage.
- English (UK), ASCII only. No `Co-Authored-By` trailer. Do NOT run `git stash` (a parked stash corrupts the tree; use `git show`/`git diff`).
- Structured logs ship to Loki via Alloy; every summary-ATS log line carries `pipeline_run_id`, `application_id`, `trace_id`.

## Interfaces this plan builds on (from #477 + #479, post-merge)

- `executeSummaryAgent(ctx, input: SummaryMessageInput): Promise<AgentResult<{ summary: string; beats: SummaryBeats }>>` (`agents/writer/summary-agent.ts`).
- `SummaryMessageInput = { research: StrategistResearchResult; body: StructuredResumeData; profileIntelligence: string; yearsGapFraming: string; achievementEvidence: string }` (`agents/writer/summary-message.ts`).
- `fillResumeSummary(ctx, tailoredResumeData, researchData, profileIntelligence, yearsGap, achievementEvidence, metric: Counter<'outcome'>, onFallback)` (`run-pipeline.ts`).
- `deterministicSummary(fitSummary, targetRole)` (`agents/writer/summary-fallback.ts`).
- `SkillEvidenceEntry = { tool: string; status: 'verified'|'transferable'|'gap'; evidenceFiles: string[]; evidence: string; transferableBridge: string }` + `buildSkillEvidenceLedger` (`ats/grounding/skill-evidence-ledger.ts`).
- `splitAttainable(coverage, ledger): AttainableSplit` (`ats/gate/attainable.ts`) — attainable = `verified`+`transferable`, gaps excluded.
- `matchTier1(term, text)`, `tokenOverlapMatch(a, b)` (`ats/matching/keyword-match.ts`) — the #479-fixed precision predicates.
- `canonicalJdSkills(jd)` (`ats/context/canonical-jd-skills.ts`); JD `hardRequirements: JobRequirement[]` where `JobRequirement.disqualifying?: boolean`.

---

### Task 1: `selectSummaryAtsTargets` — pick the top-3 attainable must-haves

**Files:**
- Create: `applications/job-strategist/src/ats/gate/summary-ats-targets.ts`
- Test: `applications/job-strategist/src/ats/gate/summary-ats-targets.test.ts`

**Interfaces:**
- Produces: `interface SummaryAtsTarget { skill: string; source: 'disqualifying'|'hard'|'soft'; verdict: 'verified'|'transferable' }` and `selectSummaryAtsTargets(ledger: SkillEvidenceEntry[], jd: { hardRequirements: {skill:string; disqualifying?:boolean}[] }, limit?: number): SummaryAtsTarget[]`.

- [ ] **Step 1: Write the failing test**
```typescript
/** @format */
import { describe, it, expect } from '@jest/globals';
import { selectSummaryAtsTargets } from './summary-ats-targets.js';

const ledger = [
  { tool: 'Kubernetes', status: 'verified', evidenceFiles: [], evidence: '', transferableBridge: '' },
  { tool: 'Terraform',  status: 'transferable', evidenceFiles: [], evidence: '', transferableBridge: '' },
  { tool: 'Go',         status: 'gap', evidenceFiles: [], evidence: '', transferableBridge: '' },
  { tool: 'AWS',        status: 'verified', evidenceFiles: [], evidence: '', transferableBridge: '' },
] as any;
const jd = { hardRequirements: [
  { skill: 'Kubernetes', disqualifying: true },
  { skill: 'AWS', disqualifying: false },
  { skill: 'Terraform' },
  { skill: 'Go', disqualifying: true },
] };

describe('selectSummaryAtsTargets', () => {
  it('excludes gaps, orders disqualifying-first, caps at 3', () => {
    const t = selectSummaryAtsTargets(ledger, jd, 3);
    expect(t.map((x) => x.skill)).toEqual(['Kubernetes', 'AWS', 'Terraform']); // Go excluded (gap), K8s first (disqualifying+verified)
    expect(t.every((x) => x.verdict !== undefined)).toBe(true);
    expect(t.find((x) => x.skill === 'Go')).toBeUndefined();
  });
  it('returns [] when no attainable JD must-have exists', () => {
    expect(selectSummaryAtsTargets([{ tool: 'Rust', status: 'gap' } as any], jd, 3)).toEqual([]);
  });
});
```
- [ ] **Step 2: Run — FAIL** (`yarn workspace @bedrock/job-strategist test -- summary-ats-targets`), module not found.
- [ ] **Step 3: Implement**
```typescript
/** @format */
import type { SkillEvidenceEntry } from '../grounding/skill-evidence-ledger.js';
import { matchTier1 } from '../matching/keyword-match.js';

export interface SummaryAtsTarget {
  readonly skill: string;
  readonly source: 'disqualifying' | 'hard' | 'soft';
  readonly verdict: 'verified' | 'transferable';
}

interface JdLike { readonly hardRequirements: ReadonlyArray<{ skill: string; disqualifying?: boolean }>; }

/** Top-N attainable (verified/transferable, never gap) JD must-haves for the summary,
 *  ordered disqualifying -> hard -> soft, then verified before transferable. */
export function selectSummaryAtsTargets(ledger: readonly SkillEvidenceEntry[], jd: JdLike, limit = 3): SummaryAtsTarget[] {
  const hard = new Map(jd.hardRequirements.map((r) => [r.skill.toLowerCase(), r]));
  const attainable = ledger.filter((e) => e.status === 'verified' || e.status === 'transferable');
  const targets: SummaryAtsTarget[] = [];
  for (const e of attainable) {
    // a ledger tool is a JD must-have if it matches a hardRequirement skill
    const req = [...hard.values()].find((r) => matchTier1(r.skill, e.tool.toLowerCase()) || matchTier1(e.tool, r.skill.toLowerCase()) || r.skill.toLowerCase() === e.tool.toLowerCase());
    if (!req) continue;
    const source = req.disqualifying ? 'disqualifying' : 'hard';
    targets.push({ skill: e.tool, source, verdict: e.status as 'verified' | 'transferable' });
  }
  const rank = { disqualifying: 0, hard: 1, soft: 2 } as const;
  targets.sort((a, b) => rank[a.source] - rank[b.source] || (a.verdict === 'verified' ? 0 : 1) - (b.verdict === 'verified' ? 0 : 1));
  return targets.slice(0, limit);
}
```
- [ ] **Step 4: Run — PASS.** Adjust the ordering/tie-break until the test's expected order holds.
- [ ] **Step 5: Lint + commit** `feat(ats): selectSummaryAtsTargets — top-3 attainable JD must-haves for the summary`

### Task 2: `scoreSummaryCoverage` — measure the summary's target coverage

**Files:**
- Create: `applications/job-strategist/src/ats/gate/summary-coverage.ts`
- Test: `applications/job-strategist/src/ats/gate/summary-coverage.test.ts`

**Interfaces:**
- Consumes: `SummaryAtsTarget` (Task 1); `matchTier1`/`tokenOverlapMatch` (`ats/matching`).
- Produces: `interface SummaryCoverage { targets: number; covered: number; missing: string[] }` and `scoreSummaryCoverage(summary: string, targets: readonly SummaryAtsTarget[]): SummaryCoverage`.

- [ ] **Step 1: Failing test** (F1/F4 no-false-positive discipline)
```typescript
/** @format */
import { describe, it, expect } from '@jest/globals';
import { scoreSummaryCoverage } from './summary-coverage.js';
const t = (skill: string) => ({ skill, source: 'hard' as const, verdict: 'verified' as const });

describe('scoreSummaryCoverage', () => {
  it('counts a target present as a whole word/phrase', () => {
    const r = scoreSummaryCoverage('Backend engineer who ships on Kubernetes and AWS.', [t('Kubernetes'), t('AWS'), t('Terraform')]);
    expect(r).toEqual({ targets: 3, covered: 2, missing: ['Terraform'] });
  });
  it('does NOT false-positive on a substring/generic token', () => {
    // "Go" must not match "ongoing"; multi-word must not match across unrelated words
    const r = scoreSummaryCoverage('Made ongoing decisions about project timelines and stakeholder management.', [t('Go'), t('project management')]);
    expect(r.covered).toBe(0);
  });
});
```
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** (reuse the fixed predicates; a target is covered if its skill matches the summary via the same precision rules)
```typescript
/** @format */
import type { SummaryAtsTarget } from './summary-ats-targets.js';
import { matchTier1 } from '../matching/keyword-match.js';

export interface SummaryCoverage { readonly targets: number; readonly covered: number; readonly missing: string[]; }

export function scoreSummaryCoverage(summary: string, targets: readonly SummaryAtsTarget[]): SummaryCoverage {
  const text = summary.toLowerCase();
  const missing: string[] = [];
  let covered = 0;
  for (const t of targets) {
    if (matchTier1(t.skill, text)) covered += 1; else missing.push(t.skill);
  }
  return { targets: targets.length, covered, missing };
}
```
- [ ] **Step 4: Run — PASS** (if the generic-token case fails, that means #479's F1/F4 fixes are missing from the base — STOP, confirm the base includes #479).
- [ ] **Step 5: Lint + commit** `feat(ats): scoreSummaryCoverage — deterministic summary target coverage`

### Task 3: ATS-aware summary agent (input + message + prompt)

**Files:**
- Modify: `applications/job-strategist/src/agents/writer/summary-message.ts` (add `atsTargets` to `SummaryMessageInput` + emit an `## ATS Targets` section)
- Modify: `applications/job-strategist/src/prompts/content/strategist/summary.md` (add the ATS-TARGETS directive; bump version)
- Modify: `applications/job-strategist/src/prompts/prompt-manifest.json` (sha256 + version for `strategist/summary`)
- Test: `applications/job-strategist/src/agents/writer/__tests__/summary-message.test.ts`, `applications/job-strategist/src/prompts/__tests__/strategist-summary-persona.test.ts`

**Interfaces:**
- Produces: `SummaryMessageInput` gains `readonly atsTargets: string[]`; `buildSummaryMessage` emits the targets when non-empty.

- [ ] **Step 1: Failing test (message)**
```typescript
it('lists ATS targets when provided, omits the section when empty', () => {
  const base = { research: RESEARCH, body: BODY, profileIntelligence: '', yearsGapFraming: '', achievementEvidence: '' } as any;
  expect(buildSummaryMessage({ ...base, atsTargets: ['Kubernetes', 'AWS'] })).toContain('## ATS Targets');
  expect(buildSummaryMessage({ ...base, atsTargets: ['Kubernetes'] })).toContain('Kubernetes');
  expect(buildSummaryMessage({ ...base, atsTargets: [] })).not.toContain('## ATS Targets');
});
```
- [ ] **Step 2: Run — FAIL** (atsTargets not on the type).
- [ ] **Step 3: Implement** — add `readonly atsTargets: string[];` to `SummaryMessageInput`; in `buildSummaryMessage`, after the verdict sections, push when non-empty:
```typescript
if (m.atsTargets.length > 0) {
  out.push('',
    '## ATS Targets (subordinate to the fit thesis — surface naturally, never fabricate)',
    'These JD must-haves are attainable and high-value. Surface them by name where a beat NATURALLY supports it, using the candidate evidence above. If a target has no honest home, OMIT it — never break the fit thesis, the 100-word cap, or the no-gap rule to fit one.',
    ...m.atsTargets.map((t) => `- ${t}`),
  );
}
```
- [ ] **Step 4: Add the persona directive** to `content/strategist/summary.md` (a short ATS-TARGETS paragraph, explicitly subordinate to the fit thesis — mirror the message wording). Bump `version` (e.g. 4 → 5). Run `yarn workspace @bedrock/job-strategist test -- prompt-content-integrity` and paste the printed sha256 into `prompt-manifest.json`.
- [ ] **Step 5: Pin the directive** in `strategist-summary-persona.test.ts`:
```typescript
it('carries the ATS-TARGETS directive, subordinate to the fit thesis', () => {
  expect(joined).toContain('ATS Targets');
  expect(joined.toLowerCase()).toContain('subordinate to the fit thesis');
});
```
- [ ] **Step 6: Run message + persona + integrity tests — PASS; lint; commit** `feat(job-strategist): summary agent accepts ATS targets (subordinate to the fit thesis)`

### Task 4: `strategist-summary-rewrite` agent name

**Files:**
- Modify: `applications/shared/src/types.ts` (`AgentName` union)
- Test: none new (compile-time); covered by Task 5's cost test.

- [ ] **Step 1:** add `| 'strategist-summary-rewrite'` to the `AgentName` union (beside `'strategist-summary'`).
- [ ] **Step 2:** `yarn workspace @bedrock/shared exec tsc --noEmit` + `yarn workspace @bedrock/job-strategist exec tsc --noEmit` clean; `yarn workspace @bedrock/shared build` if needed for downstream.
- [ ] **Step 3: Commit** `feat(shared): add strategist-summary-rewrite agent name for isolated cost`

### Task 5: Conditional re-write + orchestration in `fillResumeSummary`

**Files:**
- Modify: `applications/job-strategist/src/run-pipeline.ts` (`fillResumeSummary` + its call site ~L1076)
- Modify: `applications/job-strategist/src/agents/writer/summary-agent.ts` (allow a config override so the re-write books under `strategist-summary-rewrite`)
- Test: `applications/job-strategist/src/agents/writer/__tests__/summary-ats-flow.test.ts` (new — drives the flow with a mocked `executeSummaryAgent`)

**Interfaces:**
- Consumes: `selectSummaryAtsTargets` (T1), `scoreSummaryCoverage` (T2), the existing summary guards (`namesGap` etc.), `executeSummaryAgent`, `deterministicSummary`.
- Produces: `fillResumeSummary` gains `atsTargets` handling + returns/records a `SummaryAtsDiagnostics` object (defined in Task 6) for the caller to persist.

- [ ] **Step 1: Failing test** — mock `executeSummaryAgent` to return a summary MISSING 2 of 3 targets on the first call and covering them on the second; assert the re-write fires and the higher-covered guard-passing candidate is kept; and a case where the re-write gains nothing → first kept.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the lane inside `fillResumeSummary` (pass `atsTargets` in from the call site; add a `rewrite` capability that re-invokes `executeSummaryAgent` with a config that sets `agentName: 'strategist-summary-rewrite'` and a message including the draft + missing targets). Score with `scoreSummaryCoverage`; if `covered < 2`, do ONE re-write; run BOTH candidates through the existing summary guards; keep the higher `covered` among guard-passing candidates; tie / no-gain / re-write-guard-fail → keep first. On `executeSummaryAgent` throw → `deterministicSummary` fallback (unchanged). Populate the `SummaryAtsDiagnostics` object at each decision point.
- [ ] **Step 4: Wire the call site** (~L1076): compute `atsTargets = selectSummaryAtsTargets(skillEvidenceLedger, { hardRequirements: jdExtraction.hardRequirements })` and pass into `fillResumeSummary`; capture the returned diagnostics for Task 6.
- [ ] **Step 5: Run the flow test + full suite — PASS; lint; commit** `feat(job-strategist): ATS-aware summary lane — score + one bounded guard-safe re-write`

### Task 6: Observability — Loki events, metadata diagnostics, metrics, isolated cost

**Files:**
- Create: `applications/job-strategist/src/agents/writer/summary-ats-diagnostics.ts` (the `SummaryAtsDiagnostics` type + a `logSummaryAtsEvents(log, keys, diag)` emitter)
- Create: `applications/shared/src/rds/summary-cost.ts` (`summarizeSummaryCost`)
- Modify: `run-pipeline.ts` (persist `metadata.analysis.summaryAts`; define the two Prometheus metrics; call the Loki emitter)
- Test: `summary-ats-diagnostics.test.ts`, `summary-cost.test.ts`

**Interfaces:**
- Produces: `interface SummaryAtsDiagnostics { targets: SummaryAtsTarget[]; coverageBefore: SummaryCoverage; rewrite: { fired: boolean; reason: string|null; coverageAfter: SummaryCoverage|null; kept: 'first'|'rewrite'|null; keptReason: string|null }; fallback: { fired: boolean; reason: string|null }; guardRejections: string[] }`; `summarizeSummaryCost(pool, applicationId): Promise<{ passes: {agent,model,inputTokens,outputTokens,costCents,latencyMs}[]; total: {calls,inputTokens,outputTokens,costCents} }>`.

- [ ] **Step 1: Failing tests** — (a) `logSummaryAtsEvents` emits the five event shapes with the correlation keys (spy the logger); (b) `summarizeSummaryCost` returns per-pass rows + a summed total from a mock pool whose `prompt_invocations` rows are `agent IN ('strategist-summary','strategist-summary-rewrite')`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement**
  - `summary-ats-diagnostics.ts`: the type + `logSummaryAtsEvents(log, { pipelineRunId, applicationId, traceId }, diag)` emitting `summary_ats_targets` / `_scored` / `_rewrite` / `_guard_reject` / `_fallback` as structured `log.info({...fields, event}, event)` lines (fields per the spec).
  - `summary-cost.ts`: `SELECT agent, model_id, system_prompt_tokens+user_message_tokens AS input_tokens, output_tokens, total_cost_cents, latency_ms FROM prompt_invocations WHERE application_id = $1 AND agent LIKE 'strategist-summary%' ORDER BY invoked_at` → map to passes + sum total. Parameterised, user-agnostic read.
  - `run-pipeline.ts`: define `summaryAtsOutcome = new Counter({ name: 'job_strategist_summary_ats_outcome_total', labelNames: ['outcome','reason'] })` and a coverage histogram/counter; after `fillResumeSummary`, call `logSummaryAtsEvents`, `.inc` the outcome, and fold `diag` into `metadata.analysis.summaryAts`.
- [ ] **Step 4: Run tests + full suite — PASS; lint; commit** `feat(job-strategist): summary-ATS observability — Loki events, metadata diagnostics, metrics, isolated cost`

### Task 7: Evals + guard-integrity tests

**Files:**
- Modify: `applications/job-strategist/src/evals/summary/summary-graders.ts` + `fixtures.ts` + `summary-graders.test.ts`

**Interfaces:** reuses runtime predicates (`namesGap`, `numbersIn`, `matchTier1`).

- [ ] **Step 1: Failing tests / fixtures** — add graders/fixtures asserting: (a) an attainable-but-missing target is PRESENT after the ATS-aware pass (golden summary + targets → `scoreSummaryCoverage` covered ≥ 2); (b) the no-gap / word-cap / fit-thesis guards still PASS on an ATS-aware summary (ATS did not break the narrative); (c) a `gap` skill is NEVER in the target set (drive `selectSummaryAtsTargets` with a gap and assert exclusion).
- [ ] **Step 2: Run — FAIL; Step 3: implement graders/fixtures; Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `test(job-strategist): summary-ATS eval — targets surfaced, guards intact, gaps never targeted`

### Task 8: Grafana dashboard

**Files:**
- Create: a dashboard JSON (repo location per existing Grafana dashboards; e.g. `applications/*/dashboards/` or the cdk-monitoring repo — locate where dashboards live and follow that pattern) OR document the panels + queries in a runbook if dashboards are provisioned out-of-repo.

- [ ] **Step 1:** Panels: (a) outcome breakdown (`sum by (outcome) (job_strategist_summary_ats_outcome_total)`); (b) coverage distribution (the coverage metric); (c) fallback-reason table (Loki: `{app="job-strategist"} | json | event="summary_ats_fallback"` by `reason`); (d) per-pass cost (Loki `bedrock_invocation` `agent=~"strategist-summary.*"` sum by agent, or a `prompt_invocations` panel).
- [ ] **Step 2:** Validate the queries against live Grafana/Loki (Grafana MCP) if reachable; otherwise commit the JSON + queries for import.
- [ ] **Step 3: Commit** `feat(monitoring): summary-ATS Grafana dashboard (outcome, coverage, fallback, cost)`

---

## Self-Review

**Spec coverage:** targets → T1; scoring → T2; ATS-aware agent → T3; distinct cost agent name → T4; conditional re-write + truthfulness precedence + fallback → T5; Loki + metadata + metrics + isolated cost → T6; eval (target present, guards hold, gap never targeted) → T7; dashboard → T8. All spec sections mapped.

**Placeholder scan:** each code task has a concrete failing test + real implementation code / exact signatures. Task 8's file location is the one genuinely environment-dependent step (dashboards may be provisioned out-of-repo) — flagged as "locate + follow the existing pattern," not a placeholder for logic.

**Type consistency:** `SummaryAtsTarget` (T1) consumed by `scoreSummaryCoverage` (T2), `selectSummaryAtsTargets` call site (T5), and diagnostics (T6); `SummaryCoverage` (T2) used in `SummaryAtsDiagnostics` (T6); `atsTargets: string[]` (T3) is the `.map(t => t.skill)` of `SummaryAtsTarget[]` — the call site (T5) passes `selectSummaryAtsTargets(...).map(t => t.skill)` into `buildSummaryMessage`; `strategist-summary-rewrite` (T4) used by T5's re-write config + T6's cost query.

## Execution Handoff
Deferred until #477 + #479 merge. When ready, execute via subagent-driven-development (fresh subagent per task + review gate), branching `feat/summary-ats` off the post-merge develop.
