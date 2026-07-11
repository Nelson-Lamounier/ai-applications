---
title: Loud persistence in best-effort pipelines
type: pattern
tags: [architecture, resilience, error-handling, observability, llm-cost]
sources:
  - applications/ingestion/src/util/refreshUserProfileRollup.ts
  - applications/ingestion/src/metrics.ts
created: 2026-07-10
updated: 2026-07-10
---

## Intent

In a fail-open pipeline where every step swallows its own errors, the
persistence step is different in kind: it is the single point where paid
work (LLM output, computed aggregates) becomes durable. If it fails
quietly, everything upstream was bought and discarded with no operational
signal. This pattern keeps the pipeline best-effort while making the
persistence step retried, measured, and loud.

## When to apply

Apply when all three hold:

- The orchestrator is contractually non-throwing (see
  [must-not-throw orchestrator](must-not-throw-orchestrator.md) and
  [ADR 0005](../decisions/0005-must-not-throw-vs-retry.md)) — a failure
  must never break the caller.
- Upstream steps are individually expensive (model invocations) or
  non-reproducible without re-spending.
- Exactly one write turns the accumulated results into durable state.

Do not apply to the upstream steps themselves — retrying a flaky LLM call
inside a best-effort chain is a different trade-off (cost vs completeness),
already covered by the per-step `undefined`-on-failure convention.

## Structure

Three additions at the persistence boundary, none of which change the
orchestrator's never-throw contract:

1. **Retry once.** A single immediate retry absorbs transient pool and
   connection failures — the dominant real-world cause — without hiding a
   systemic one behind long backoff.
2. **Metric stage for the write.** The same outcome counter that tracks
   the pipeline's steps gains a stage for persistence, so "paid work
   discarded" is a dashboard query, not database archaeology.
3. **`console.error` on final failure, alongside the span.** Span-only
   evidence is invisible unless the trace is sampled and inspected; pod
   logs are the operational surface actually watched.

## Implementation in this codebase

The profile-rollup orchestrator
([refreshUserProfileRollup.ts](../../applications/ingestion/src/util/refreshUserProfileRollup.ts)):

- `upsertRollupLoudly` (line ~141) wraps the single `repo.upsert(...)` call:
  one retry, then on final failure increments
  `ingestion_synthesis_outcome_total{stage="upsert", outcome="failed"}`,
  marks the span, and writes a `console.error` naming the user and the
  consequence ("completed synthesis discarded — paid LLM output not
  persisted").
- `logStageConfig` (line ~129) logs which synthesis stages are enabled at
  the start of every run, so a partial run (some layers absent from the
  invocation ledger) is diagnosable from Loki without tracing.
- The `'upsert'` stage is pre-seeded to zero alongside the synthesis stages
  ([metrics.ts](../../applications/ingestion/src/metrics.ts#L119-L123)), so
  the Grafana panel shows the series before the first failure.

## Motivating incident

On 2026-07-08 a rollup run completed its Sonnet mirror synthesis (recorded
in `prompt_invocations` at 06:20:43) but `user_profile_rollup.refreshed_at`
never advanced — the upsert failed, the outer best-effort catch recorded it
on the span only, and the paid output was silently discarded. The COALESCE
preservation semantics worked as designed (no data regression), but the
loss itself was invisible: it was found a day later by cross-referencing
the invocation ledger against row timestamps. This pattern is the direct
remediation, shipped in PR #458 (merge `aab8ccd`).

## Variants

- The pipeline-level equivalent already existed for a different failure
  class: `job-strategist` persists its analysis to `pipeline_runs.metadata`
  *and* stashes the ATS verdict in two places so an RLS-scoped write
  failure cannot lose it
  ([applications/job-strategist/src/run-pipeline.ts](../../applications/job-strategist/src/run-pipeline.ts)).
  Loud-persistence generalises the idea: wherever a fail-open flow narrows
  to one durable write, that write gets retry + metric + log.
- The complementary audit question for anything this pattern cannot cover:
  "does each paid artefact have a verified reader and a verified writer?"
  Fail-open architectures convert failures into silence, so cost governance
  must ride on usage attribution rather than on errors.

<!--
Evidence trail (auto-generated):
- Source: applications/ingestion/src/util/refreshUserProfileRollup.ts (read on 2026-07-10, at aab8ccd)
- Source: applications/ingestion/src/metrics.ts (read on 2026-07-10)
- Live: prompt_invocations mirror invocation 2026-07-08 06:20:43 vs user_profile_rollup.refreshed_at 2026-07-07 04:31 (dev RDS, read 2026-07-09)
- Commit: PR #458 (f029586 fix, aab8ccd merge)
-->
