# Pipeline stage-timing runbook

How to observe the Strategist analysis pipeline's per-stage wall-clock cost,
and how to read the headline before/after story from Phase 5 PR-B: the
monolithic writer LLM call was deleted and replaced with five independent,
narrowly-scoped section agents (analysis, experience, projects, skills,
cover-letter), four of which now run CONCURRENTLY in one batch instead of
inside a single ~360s sequential call.

> Dashboards are provisioned out-of-repo (Grafana Cloud); this runbook is the
> source of truth for the panel queries. Metrics/events appear only after the
> PR-B image is deployed and a paid analysis run has executed.

## Correlation keys

Every Loki event carries `pipeline_run_id`, `application_id`, and `trace_id`
(`trace_id` is `null` in `run-pipeline` -- filter by `pipeline_run_id`).

## Before / after

Before PR-B, one `strategist-writer` Sonnet call with an 8192-token thinking
budget produced the ENTIRE resume + cover letter + analysis narrative in one
sequential pass -- roughly 360s of the end-to-end run, invisible as a single
line inside `job_strategist_duration_seconds{operation="analyse"}`.

After PR-B, that call is gone. The pipeline instead runs eight stages, four of
which (`batch1`) execute concurrently via `Promise.all`:

| Stage       | What runs                                                              | Concurrency          |
|-------------|-------------------------------------------------------------------------|-----------------------|
| `research`  | KB retrieval, resume parsing, gap analysis (Research Agent)             | sequential            |
| `batch1`    | analysis + experience + projects + skills agents                        | concurrent (4-way)    |
| `reconcile` | deterministic resume-skeleton reconciliation (`reconcileResumeSections`)| sequential            |
| `batch2`    | summary + cover-letter agents (cover-letter needs the finished body)    | concurrent (2-way)    |
| `guards`    | resume/cover-letter guard passes                                        | sequential            |
| `length`    | page-budget trimming                                                    | sequential            |
| `persist`   | write the tailored resume                                               | sequential            |
| `ats_gate`  | ATS re-write feedback loop                                              | sequential             |

Expectation: `batch1` is bounded by its SLOWEST member (not the sum of all
four) -- expect roughly 15-45s depending on which agent's extended-thinking
budget dominates (the analysis agent keeps a 2048-token thinking budget; the
other three run with `thinkingBudget: 0` under a forced tool). The removed
~360s writer stage should show up nowhere in the new stage breakdown; total
end-to-end duration (`job_strategist_duration_seconds{operation="analyse"}`)
should move from roughly 8 minutes to roughly 3 minutes once the batches
replace the old sequential writer call.

## Surface 1 -- Prometheus metrics

- `job_strategist_pipeline_stage_seconds{stage}` (Histogram, buckets
  `[1, 5, 15, 30, 60, 120, 240, 480]`) -- wall-clock duration of each of the 8
  stages above, fed through `lib/stage-timing.ts`'s `stageSeconds` helper.
  Records on BOTH the success and the throw path (a failing stage still
  contributes its real cost). THE headline metric for this runbook.
- `job_strategist_duration_seconds{operation, outcome}` (Histogram, buckets
  `[10, 30, 60, 120, 300, 600, 1200, 1800]`) -- end-to-end run duration; the
  total-run trend this pipeline's stage breakdown explains.
- `job_strategist_runs_total{operation, outcome}` (Counter) -- run volume, for
  normalising the duration trend against traffic.

Panels (datasource UID `prometheus`):

```promql
# p50/p95 per stage
histogram_quantile(0.50, sum by (le, stage) (rate(job_strategist_pipeline_stage_seconds_bucket[$__range])))
histogram_quantile(0.95, sum by (le, stage) (rate(job_strategist_pipeline_stage_seconds_bucket[$__range])))

# batch1 vs the old writer stage -- should sit well under 45s once deployed
histogram_quantile(0.95, sum by (le) (rate(job_strategist_pipeline_stage_seconds_bucket{stage="batch1"}[$__range])))

# total-run trend (operation="analyse")
histogram_quantile(0.50, sum by (le) (rate(job_strategist_duration_seconds_bucket{operation="analyse"}[$__range])))
histogram_quantile(0.95, sum by (le) (rate(job_strategist_duration_seconds_bucket{operation="analyse"}[$__range])))
sum by (outcome) (increase(job_strategist_runs_total{operation="analyse"}[$__range]))
```

## Surface 2 -- the three new agents' outcome metrics

- `job_strategist_skills_agent_outcome_total{outcome, reason}` (Counter).
  `outcome`: `agent` (dedicated skills agent filled the section) vs `fallback`
  (deterministic `deterministicSkills` used). `reason`: `ok` (agent);
  `membership-invalid` (ledger-membership violated -- `unknown_skill:*`),
  `caps` (category/item cap exceeded), `agent-error` (network/schema failure)
  (fallback).
- `job_strategist_cover_letter_agent_outcome_total{outcome, reason}`
  (Counter). `outcome`: `agent` (letter generated) vs `omitted`. `reason`:
  `ok` (agent); `not-requested` (`ctx.includeCoverLetter === false`),
  `agent-error` (call failed) (omitted).
- The analysis agent has NO outcome metric: `parseAnalysisResponse` throws on
  an empty/blank `analysisXml`, which aborts the whole run -- that failure is
  already visible on `job_strategist_runs_total{outcome}`. Its facts (Phase 0
  archetype id/confidence, gap-mitigation count) are Loki events + a metadata
  fold only (see Surfaces 3-4 below).

Panels:

```promql
sum by (outcome, reason) (increase(job_strategist_skills_agent_outcome_total[$__range]))
sum by (outcome, reason) (increase(job_strategist_cover_letter_agent_outcome_total[$__range]))
```

## Surface 3 -- Loki event stream

Datasource UID `loki`. Events (namespaced `${agentKey}_${suffix}` by the
shared `logSectionAgentEvents` emitter in
`agents/writer/section-agent-diagnostics.ts`):

- `skills_agent_scored` (always), `skills_agent_membership_reject` (only on a
  ledger-membership violation -- carries the raw `unknown_skill:*` tokens,
  Loki-only, never a metric label), `skills_agent_fallback` (only on
  fallback).
- `cover_letter_agent_generated` / `cover_letter_agent_omitted` (exactly one
  fires per run where a letter was requested).
- `analysis_agent_archetype` (always -- archetype id/confidence/whether a lead
  identity was produced), `analysis_agent_mitigations` (only when at least
  one Phase-3 gap defence was produced).

Replay one run end to end:

```logql
{namespace="job-strategist"} | json | event=~"skills_agent_.*|cover_letter_agent_.*|analysis_agent_.*"
  | pipeline_run_id="<PIPELINE_RUN_ID>"
```

## Surface 4 -- durable per-run diagnostics (SQL) + isolated LLM cost

Skills and cover-letter fold into `pipeline_runs.metadata.analysis` alongside
`experienceAgent`/`projectsAgent`/`summaryAts` (`skillsAgent`,
`coverLetterAgent`); the analysis agent folds its compact summary under
`analysisAgent`:

```sql
SELECT jsonb_pretty(metadata->'analysis'->'skillsAgent')      AS skills_agent,
       jsonb_pretty(metadata->'analysis'->'coverLetterAgent') AS cover_letter_agent,
       jsonb_pretty(metadata->'analysis'->'analysisAgent')    AS analysis_agent
FROM pipeline_runs WHERE id = '<PIPELINE_RUN_ID>';
```

Each of the three new agents books LLM spend under its own `agent` name in
`prompt_invocations` -- isolated cost, no shared bucket with the deleted
writer or with each other:

```sql
SELECT agent,
       (system_prompt_tokens + user_message_tokens) AS input_tokens,
       output_tokens, total_cost_cents, latency_ms
FROM prompt_invocations
WHERE application_id = '<APPLICATION_ID>'
  AND agent LIKE 'strategist-analysis%'
ORDER BY invoked_at;

-- swap the LIKE pattern for 'strategist-skills%' or 'strategist-cover-letter%'
-- to isolate each agent's spend; 'strategist-experience%' / 'strategist-projects%'
-- are covered by their own runbooks.
```

## What good looks like

- `job_strategist_pipeline_stage_seconds{stage="batch1"}` p95 stays well under
  the old ~360s writer cost -- expect roughly 15-45s, bounded by whichever of
  the four concurrent agents runs longest (usually `analysis`, the only one
  that keeps a nonzero thinking budget).
- `job_strategist_duration_seconds{operation="analyse"}` p50 trends toward
  roughly 3 minutes; a sustained regression toward the old ~8-minute baseline
  means either `batch1`/`batch2` lost their concurrency (check for an
  accidental `await` before a `Promise.all`) or a downstream stage
  (`guards`/`length`/`ats_gate`) grew a new re-write loop.
- `skills_agent_outcome_total{outcome="fallback",reason="membership-invalid"}`
  sustained high means the skills agent is naming ledger `gap` tools --
  tighten the persona, never loosen `validateSkillsMembership`.
- `cover_letter_agent_outcome_total{outcome="omitted",reason="agent-error"}`
  sustained high is a genuine agent-reliability regression (distinct from
  `not-requested`, which is expected traffic for `includeCoverLetter=false`
  runs).

## Pointer check -- experience/projects runbooks

`docs/runbooks/experience-agent-observability.md` and
`docs/runbooks/projects-agent-observability.md` were checked for stage-timing
references: neither mentions `job_strategist_pipeline_stage_seconds` or the
old writer-stage cost. Their only cross-references are to the (already
retired, already documented in both files) `job_strategist_experience_net_fired_total{pass}`
counter, which `job_strategist_section_net_fired_total{section, pass}`
superseded in Task 9 -- unrelated to stage timing. No pointer updates needed.
