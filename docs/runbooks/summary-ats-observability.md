# Summary-ATS observability runbook

How to observe, debug, and cost-account the ATS-aware summary lane (Phase 3). The
lane runs inside `fillResumeSummary` in the job-strategist analysis pipeline: it
scores the first summary draft against the JD's attainable must-have targets and,
when coverage is short, does one bounded guard-safe re-write. This runbook lists
the four observability surfaces and the exact queries for a Grafana panel set.

> Dashboards are provisioned out-of-repo (Grafana Cloud), so this runbook is the
> source of truth for the panels. Paste each query into a new panel on the
> job-strategist folder. The Prometheus metrics and Loki events only appear
> **after** the summary+ATS image is deployed and at least one paid analysis run
> has executed -- an empty panel before first traffic is expected, not a fault.

## Correlation keys

Every summary-ATS Loki event carries `pipeline_run_id`, `application_id`, and
`trace_id` (the last is currently `null` in `run-pipeline` -- that entrypoint does
not thread a trace id; filter by `pipeline_run_id` to replay one run).

## Surface 1 -- Prometheus metrics (aggregate trend)

- `job_strategist_summary_ats_outcome_total{outcome, reason}` (Counter). `outcome`
  is one of `aware` (coverage already met, no re-write), `rewritten` (re-write
  fired and kept), `kept_first` (re-write fired but first kept), `fallback`
  (summary agent errored -> deterministic fallback). `reason` is a bounded enum
  (`coverage-met`, `no-targets`, `coverage-below-min`, `rewrite-covers-more`,
  `no-coverage-gain`, `rewrite-guard-failed`, `first-guard-failed`, `kept-first`,
  `rewrite-error`/`rewrite-threw`, `agent-error`). The raw fallback error string is
  NOT a label (it lives only in the Loki `summary_ats_fallback` event) -- this keeps
  label cardinality bounded.
- `job_strategist_summary_ats_coverage` (Histogram, buckets `[0,1,2,3]`) -- covered
  target count of the first draft.

Datasource UID: `prometheus`.

### Panel A -- outcome breakdown (pie or stacked bars)
```promql
sum by (outcome) (increase(job_strategist_summary_ats_outcome_total[$__range]))
```
Drill-down by reason (table):
```promql
sum by (outcome, reason) (increase(job_strategist_summary_ats_outcome_total[$__range]))
```

### Panel B -- coverage distribution (bar gauge / heatmap)
Per-bucket counts of covered targets in the first draft:
```promql
sum by (le) (increase(job_strategist_summary_ats_coverage_bucket[$__range]))
```
Share of runs that already cover >= 2 targets before any re-write:
```promql
sum(increase(job_strategist_summary_ats_coverage_bucket{le="+Inf"}[$__range]))
  - sum(increase(job_strategist_summary_ats_coverage_bucket{le="1"}[$__range]))
```

## Surface 2 -- Loki event stream (primary investigation)

Datasource UID: `loki`. The pipeline logger ships structured JSON to Loki via
Alloy. Event names: `summary_ats_targets`, `summary_ats_scored`,
`summary_ats_rewrite`, `summary_ats_guard_reject`, `summary_ats_fallback`.

### Panel C -- fallback reasons (table)
```logql
{namespace="job-strategist"} | json | event="summary_ats_fallback"
  | line_format "{{.pipeline_run_id}} {{.application_id}} {{.reason}}"
```
Re-write activity (fired / kept / kept_reason):
```logql
{namespace="job-strategist"} | json | event="summary_ats_rewrite"
  | line_format "{{.pipeline_run_id}} reason={{.reason}} kept={{.kept}} kept_reason={{.kept_reason}} cover_after={{.coverage_after}}"
```

### Replay one run
```logql
{namespace="job-strategist"} | json | event=~"summary_ats_.*"
  | pipeline_run_id="<PIPELINE_RUN_ID>"
```
This shows, in order: the selected targets, the first-draft score, whether a
re-write fired and which candidate was kept, any guard rejections, and any
fallback -- the full decision trace for that run.

## Surface 3 -- durable per-run diagnostics (SQL)

The diagnostics object is persisted at `pipeline_runs.metadata.analysis.summaryAts`
(same place `atsCheck` / `dispatchedImage` live). Query one run:
```sql
SELECT jsonb_pretty(metadata->'analysis'->'summaryAts') AS summary_ats
FROM pipeline_runs
WHERE id = '<PIPELINE_RUN_ID>';
```
Shape: `{ targets:[{skill,source,verdict}], coverageBefore:{targets,covered,missing},
rewrite:{fired,reason,coverageAfter,kept,keptReason}, fallback:{fired,reason},
guardRejections:[...] }`.

Fleet view -- coverage + outcome across recent runs:
```sql
SELECT id,
       metadata->'analysis'->'summaryAts'->'coverageBefore'->>'covered' AS covered_before,
       metadata->'analysis'->'summaryAts'->'rewrite'->>'fired'          AS rewrite_fired,
       metadata->'analysis'->'summaryAts'->'rewrite'->>'kept'           AS kept,
       metadata->'analysis'->'summaryAts'->'fallback'->>'fired'         AS fell_back
FROM pipeline_runs
WHERE pipeline_type = 'strategist'
  AND metadata->'analysis' ? 'summaryAts'
ORDER BY created_at DESC
LIMIT 50;
```

## Surface 4 -- isolated LLM cost

The two summary passes book separately in `prompt_invocations` by distinct agent
name: `strategist-summary` (first pass) and `strategist-summary-rewrite`
(re-write). The `summarizeSummaryCost(pool, applicationId)` helper
(`@bedrock/shared`, `rds/summary-cost.ts`) returns per-pass rows + a summed total.

### Panel D -- per-application summary cost (SQL / table)
```sql
SELECT agent,
       (system_prompt_tokens + user_message_tokens) AS input_tokens,
       output_tokens,
       total_cost_cents,
       latency_ms
FROM prompt_invocations
WHERE application_id = '<APPLICATION_ID>'
  AND agent LIKE 'strategist-summary%'
ORDER BY invoked_at;
```
Fleet cost of the re-write pass specifically (is the second call worth it?):
```sql
SELECT agent, COUNT(*) AS calls,
       ROUND(SUM(total_cost_cents)::numeric, 2) AS cents,
       ROUND(AVG(latency_ms)) AS avg_ms
FROM prompt_invocations
WHERE agent LIKE 'strategist-summary%'
  AND invoked_at >= date_trunc('day', NOW()) - interval '7 days'
GROUP BY agent;
```

## What "good" looks like

- Most runs are `outcome=aware` or `rewritten`; a rising `fallback` rate means the
  summary agent is erroring (check `summary_ats_fallback` reasons + the agent's own
  Bedrock errors).
- A high `kept_first` with `reason=no-coverage-gain` means the re-write is spending
  a Sonnet call without improving coverage -- candidate for prompt tuning or
  dropping the re-write for those target shapes.
- `rewrite-guard-failed` means the re-write tripped `namesGap`; the first draft is
  kept and the downstream ResumeGuardCtx + summary-repair pass still applies.
