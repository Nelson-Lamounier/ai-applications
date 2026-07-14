# Phase 3 — Summary ↔ ATS Optimisation — Design

**Date:** 2026-07-14
**Status:** Approved design — pending implementation plan
**Depends on (must merge first):** PR #477 (dedicated summary agent) + PR #479 (ATS Phase-2 precision fixes). #478 (ATS refactor) already on develop.

## Problem

The resume Summary is now a dedicated Sonnet call (#477) that mirrors the matcher's Fit Summary, but it is only ATS-checked as part of the whole rendered resume — there is no summary-SPECIFIC ATS pass. The Summary is prime real estate (top of the resume, first thing an ATS parser and recruiter read), so it should deliberately surface the JD's highest-value must-have keywords — without fabricating or breaking the fit-thesis-mirror narrative.

## Goals

1. Make the Summary **ATS-aware by construction** against the JD's attainable must-haves.
2. **Measure** the Summary's own coverage of those must-haves; **conditionally re-write** once if too low.
3. Never let ATS override truthfulness or the narrative (fit-thesis, 100-word cap, no-gap, altitude).
4. Full observability: a per-event **Loki trace**, a durable per-run diagnostic object, aggregate metrics, and the Summary's **LLM cost in isolation**.

## Non-goals

- Keyword-stuffing the Summary to chase a coverage percentage.
- A summary-ATS pass for the free tier (paid pipeline only, where the summary agent runs).
- Changing the body's existing attainable→surface loop.

## Sequencing / dependency

Design now; **execute after #477 and #479 merge to develop**, then Phase 3 branches off a clean develop. #479's matching-precision fixes (F1/F4) are required because the summary coverage scorer reuses `ats/matching` predicates — a false-positive scorer would mis-decide re-writes. The user runs the #477 UI A/B in parallel.

## Architecture & data flow

Everything lives in `fillResumeSummary` (the splice added in the summary-agent work), which runs BEFORE the whole-resume ATS check and the body guard chain. Targets come from the ledger (no chicken-and-egg with scoring the summary).

```
jd must-haves (canonicalJdSkills / collectJdMustHaves) + skill-evidence ledger
  → selectSummaryAtsTargets()                                   [NEW]
      top-3 ATTAINABLE must-haves (verified+transferable ∩ JD must-haves;
      hard/disqualifying first, then matcher depth; gaps excluded)
  → summary agent, ATS-AWARE first pass (SummaryMessageInput.atsTargets + summary.md directive)
      { summary, beats }  surfacing targets naturally within the fit-thesis beats
  → scoreSummaryCoverage(summary, targets)                      [NEW, reuses ats/matching]
      { targets: 3, covered: n, missing: [...] }
  → covered >= 2 ? ── yes ──► splice → existing summary guards → persist
    │ no
    ▼ ONE bounded re-write (summary agent, draft + missing targets)
      → re-score → keep better of {first, rewrite} among GUARD-PASSING candidates
        (truthfulness + narrative win; ties/no-gain/guard-fail → keep first)
      → splice → guards → persist
  (summary agent call errors → existing deterministicSummary fallback; ATS lane skipped)
```

## Components

### selectSummaryAtsTargets (NEW — `ats/gate/` or `ats/matching/`)
Deterministic. Input: the skill-evidence ledger + JD must-haves (both already computed pre-summary). Output: up to 3 attainable must-haves ordered hard/disqualifying-first then by verdict depth. Reuses `splitAttainable`'s attainable definition (verified + transferable, gaps excluded). Pure + unit-tested.

### ATS-aware summary agent (extend #477's summary agent)
- `SummaryMessageInput` gains `readonly atsTargets: string[]`.
- `buildSummaryMessage` emits an `## ATS Targets` section.
- `summary.md` (version bump + manifest) gains one directive, SUBORDINATE to the fit thesis:
  > "ATS TARGETS (subordinate to the fit thesis): these JD must-haves are attainable and high-value — surface them by name where a beat NATURALLY supports it, using the candidate's own evidence. NEVER fabricate to include one; never break the fit-thesis narrative, the 100-word cap, or the no-gap rule to fit one. If a target has no honest home, omit it."

### scoreSummaryCoverage (NEW — `ats/gate/`)
`scoreSummaryCoverage(summary: string, targets: string[]) → { targets: number; covered: number; missing: string[] }`. Reuses the fixed `ats/matching` predicates (`matchTier1`/`tokenOverlapMatch`). Pure + unit-tested with the F1/F4 regression discipline (no generic-word false positives).

### Conditional re-write (in `fillResumeSummary`)
Fires only when `covered < 2`. One extra `executeSummaryAgent` call, passing the first summary as a draft + `missing` as "weave these if honestly supported." Both candidates pass through the existing summary guards (`namesGap`, word-cap, altitude, fit-thesis pins); keep the higher covered-count among guard-passing candidates; on tie / no-gain / re-write-guard-fail, keep the first. Capped at one re-write.

### Truthfulness precedence (invariant)
ATS coverage never overrides: no fabrication (only verified/transferable targets, never gaps), no gap-claim, no cap/altitude/fit-thesis break. A summary that honestly cannot carry 2 targets ships at lower coverage.

## Observability (four correlated surfaces)

Correlation keys on every surface: `pipeline_run_id`, `application_id`, `trace_id`.

### 1. Loki trace (primary investigation surface)
The pipeline's structured logger ships to Loki via Alloy. Emit a stable-schema event stream:
- `summary_ats_targets` — `targets[]`, priorities, verdicts.
- `summary_ats_scored` — `covered`, `of`, `missing[]`.
- `summary_ats_rewrite` — `fired`, `reason`, `coverage_after`, `kept`, `kept_reason`.
- `summary_ats_guard_reject` — `which_guard`, `candidate`.
- `summary_ats_fallback` — `reason`, `error`.
- The two invocation rows log `bedrock_invocation` with `agent`, `input_tokens`, `output_tokens`, `cost_cents`, `latency_ms`, `model`, sharing `trace_id`.
LogQL examples (ship in the spec/runbook):
- Fallback/re-write investigation: `{app="job-strategist"} | json | event=~"summary_ats_(fallback|rewrite)"` (+ `| pipeline_run_id="…"` to replay one run).
- Live isolated cost: `sum by (agent) (...) | agent=~"strategist-summary.*"`.

### 2. Durable per-run diagnostics — `pipeline_runs.metadata.analysis.summaryAts`
```
{ targets: [{ skill, priority, source, verdict }],
  coverageBefore: { covered, of, missing },
  rewrite: { fired, reason, coverageAfter, kept, keptReason },
  fallback: { fired, reason },
  guardRejections: [ ... ] }
```
Queryable per application via SQL; matches how `atsCheck`/`dispatchedImage` are already stored.

### 3. Prometheus metrics (aggregate trend)
`job_strategist_summary_ats_outcome_total{outcome=aware|rewritten|kept_first|fallback, reason}` and `job_strategist_summary_ats_coverage{bucket}`.

### 4. Isolated LLM cost — `prompt_invocations` + `summarizeSummaryCost`
The two passes book separately by distinct agent name: pass 1 `strategist-summary`, re-write `strategist-summary-rewrite` (add to the `AgentName` union, mirroring `strategist-summary`). Each row already carries input/output tokens, cost cents, latency, model, `application_id`. New helper:
```
summarizeSummaryCost(pool, applicationId) →
  { passes: [{ agent, model, inputTokens, outputTokens, costCents, latencyMs }, ...],
    total: { calls, inputTokens, outputTokens, costCents } }
```
backed by `SELECT ... FROM prompt_invocations WHERE application_id=$1 AND agent LIKE 'strategist-summary%'`.

### Grafana dashboard (execution deliverable)
A summary-ATS panel set: outcome breakdown, coverage distribution, fallback-reason table, per-pass cost — built from the Prometheus metrics + Loki + `prompt_invocations`.

## Testing / eval

- Unit: `selectSummaryAtsTargets` (ordering, gaps excluded, top-3), `scoreSummaryCoverage` (F1/F4 no-false-positive discipline), `summarizeSummaryCost` (mock pool, per-pass + total).
- Summary eval (extend `evals/summary`): a target that is attainable-but-missing is present after the pass; truthfulness/no-gap/word-cap/fit-thesis guards still hold after ATS-awareness (ATS did not break the narrative); a gap target is NEVER surfaced.
- Diagnostics: the `summaryAts` metadata object + Loki events are populated for aware / rewritten / kept-first / fallback paths (unit-assert the emitted event fields).
- Deterministic-logic + prompt change: `summary.md` change ships with its eval (CLAUDE.md §5); live validation via the UI JD A/B.

## Consequences

- Up to two Sonnet summary calls per run (first + conditional re-write), each cost-isolated in the ledger.
- `AgentName` gains `strategist-summary-rewrite`.
- The summary becomes deliberately ATS-aware while the fit-thesis-mirror + guards remain authoritative.
