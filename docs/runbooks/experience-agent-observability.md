# Experience-agent observability runbook

How to observe, debug, and cost-account the dedicated Experience agent (Phase 4).
The lane runs inside `fillResumeExperience` in the job-strategist analysis
pipeline, after the roster reconcile and BEFORE the summary agent: the writer
emits a roster skeleton (`highlights: []`); the Experience agent rewrites the
user's indexed career lines against the JD under a schema-enforced provenance
contract; coverage is scored strictly and at most one re-write fires; the kept
output is spliced and the downstream safety net (guard, length, surface-keywords)
still runs, with each firing counted.

> Dashboards are provisioned out-of-repo (Grafana Cloud); this runbook is the
> source of truth for the panel queries. Metrics/events appear only after the
> Phase 4 image is deployed and a paid analysis run has executed.

## Correlation keys

Every Loki event carries `pipeline_run_id`, `application_id`, and `trace_id`
(`trace_id` is `null` in `run-pipeline` -- filter by `pipeline_run_id`).

## Surface 1 -- Prometheus metrics

- `job_strategist_experience_agent_outcome_total{outcome, reason}` (Counter).
  `outcome`: `aware` (no re-write needed), `rewritten`, `kept_first`, `fallback`
  (verbatim career highlights used). `reason` is a bounded enum:
  `coverage-met`, `no-targets` (aware); `rewrite-covers-more` (rewritten);
  `no-coverage-gain`, `rewrite-provenance-invalid`, `rewrite-names-gap`,
  `rewrite-threw` (kept_first); `provenance-invalid`, `agent-error` (fallback).
  The raw error string is NEVER a label (Loki-only).
- `job_strategist_experience_agent_coverage` (Histogram, buckets `[0..6]`) --
  covered ATS targets in the FIRST pass; sampled only when targets exist and the
  run did not fall back.
- `job_strategist_experience_net_fired_total{pass}` (Counter,
  `pass = guard | length | surface_keywords`) -- increments when a downstream
  safety-net pass CHANGED the experience section after the agent. This is the
  retirement evidence: passes trending to zero firings are candidates for
  removal; a pass that keeps firing means the agent under-delivers on that
  dimension (read its Loki events to see what changed).

Panels (datasource UID `prometheus`):

```promql
sum by (outcome) (increase(job_strategist_experience_agent_outcome_total[$__range]))
sum by (outcome, reason) (increase(job_strategist_experience_agent_outcome_total[$__range]))
sum by (le) (increase(job_strategist_experience_agent_coverage_bucket[$__range]))
sum by (pass) (increase(job_strategist_experience_net_fired_total[$__range]))
```

## Surface 2 -- Loki event stream

Datasource UID `loki`. Events: `experience_agent_targets`, `experience_agent_scored`,
`experience_agent_rewrite`, `experience_agent_provenance_reject`,
`experience_agent_fallback`.

Replay one run end to end:

```logql
{namespace="job-strategist"} | json | event=~"experience_agent_.*"
  | pipeline_run_id="<PIPELINE_RUN_ID>"
```

Fallback investigation (the raw error lives here, not in the metric):

```logql
{namespace="job-strategist"} | json | event="experience_agent_fallback"
  | line_format "{{.pipeline_run_id}} {{.reason}}"
```

Provenance rejections (which validator tokens fired -- `cross_role_citation:*`,
`unaccounted_line:*`, `roster_drift:*`, `uncited_bullet:*`, `bullet_count:*`,
`roster_count:*`):

```logql
{namespace="job-strategist"} | json | event="experience_agent_provenance_reject"
```

## Surface 3 -- durable per-run diagnostics (SQL)

Persisted at `pipeline_runs.metadata.analysis.experienceAgent` (same write as
`summaryAts`):

```sql
SELECT jsonb_pretty(metadata->'analysis'->'experienceAgent') AS experience_agent
FROM pipeline_runs WHERE id = '<PIPELINE_RUN_ID>';
```

Shape: `{ targets:[{skill,source,verdict,requirement}],
coverageBefore:{targets,covered,missing}, rewrite:{fired,reason,coverageAfter,
kept,keptReason}, fallback:{fired,reason}, provenance:{firstViolations,
rewriteViolations,droppedLines} }`.

Fleet view:

```sql
SELECT id,
       metadata->'analysis'->'experienceAgent'->'coverageBefore'->>'covered' AS covered,
       metadata->'analysis'->'experienceAgent'->'rewrite'->>'kept'           AS kept,
       metadata->'analysis'->'experienceAgent'->'fallback'->>'fired'         AS fell_back,
       metadata->'analysis'->'experienceAgent'->'provenance'->>'droppedLines' AS dropped
FROM pipeline_runs
WHERE pipeline_type = 'strategist'
  AND metadata->'analysis' ? 'experienceAgent'
ORDER BY created_at DESC LIMIT 50;
```

## Surface 4 -- isolated LLM cost

The two passes book under distinct agent names: `strategist-experience` (first
pass) and `strategist-experience-rewrite`:

```sql
SELECT agent,
       (system_prompt_tokens + user_message_tokens) AS input_tokens,
       output_tokens, total_cost_cents, latency_ms
FROM prompt_invocations
WHERE application_id = '<APPLICATION_ID>'
  AND agent LIKE 'strategist-experience%'
ORDER BY invoked_at;
```

## What good looks like

- `outcome=aware`/`rewritten` dominate; a rising `fallback{reason=provenance-invalid}`
  means the agent is mis-citing -- read the `_provenance_reject` tokens and tune
  the persona, never loosen the validator.
- `net_fired_total{pass=surface_keywords}` trending to zero = the agent covers
  ATS keywords by construction; sustained firings = coverage gap, check which
  targets `experience_agent_scored` reports missing.
- `kept_first{reason=no-coverage-gain}` sustained high = the re-write pass burns
  a Sonnet call without improving coverage -- candidate for tuning or removal.
- Dropped-lines counts in the diagnostics show how much of the user's history is
  being consciously excluded; a spike means the JD relevance filter is too
  aggressive.
