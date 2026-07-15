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
- `job_strategist_section_net_fired_total{section="experience", pass, outcome}`
  (Counter, `pass = guard | length | reframe | metric_weave | revalidate |
  surface_keywords`, `outcome = changed | restored`) -- increments when a
  downstream safety-net pass diverged from the pre-pass experience snapshot.
  Since the job-strategist experience e2e-provenance work (`withExperienceLock`,
  `agents/writer/experience-lock.ts`), every one of those passes runs inside
  the lock: `outcome="changed"` is the ORIGINAL tripwire increment (the pass's
  raw output diverged) and should now read effectively ZERO for
  `section="experience"` -- the lock always restores the divergence before it
  reaches the next stage. `outcome="restored"` is the live signal: it fires
  exactly when the lock caught and reverted a divergence, i.e. the pass tried
  to touch agent-owned Experience. Sustained `restored` firings on `guard` or
  `surface_keywords` mean the agent under-delivers fidelity/keywords by
  construction (read the Loki events to see what changed before the revert).
  `pass="length"` firing `restored` is less alarming on its own -- length
  budget legitimately WANTS to touch experience when the resume is over
  budget, and the lock is what stops it, so a nonzero rate here is expected
  whenever the run overflows the page budget. PR-B removed the older,
  experience-only `job_strategist_experience_net_fired_total{pass}` counter
  this generalised one superseded (see the projects-agent-observability
  runbook, which shares the same counter across both agent-owned sections --
  `section="projects"` has no lock yet, so it only ever emits
  `outcome="changed"`).

Panels (datasource UID `prometheus`):

```promql
sum by (outcome) (increase(job_strategist_experience_agent_outcome_total[$__range]))
sum by (outcome, reason) (increase(job_strategist_experience_agent_outcome_total[$__range]))
sum by (le) (increase(job_strategist_experience_agent_coverage_bucket[$__range]))
sum by (pass, outcome) (increase(job_strategist_section_net_fired_total{section="experience"}[$__range]))
```

## Surface 2 -- Loki event stream

Datasource UID `loki`. Two shapes coexist: BATCH-1 structured events (carry an
`event` field, emitted by `logExperienceAgentEvents`/`logExperienceCoverageFinal`
in `experience-agent-diagnostics.ts`) and two later, message-keyed lines
(`log.info`/`log.warn` with no `event` field, emitted directly in
`run-pipeline.ts`) added by the e2e-provenance work. NOTE the run-id field
name SPLITS by shape -- the shared logger applies no key-casing transform:
the seven structured events stamp snake_case `pipeline_run_id`; the two
message-keyed lines emit camelCase `pipelineRunId` (the raw variable name at
their call sites). A query filtering only `pipeline_run_id` silently drops
the message-keyed lines.

Structured (`event=` filterable): `experience_agent_targets`,
`experience_agent_scored`, `experience_agent_dropped`, `experience_agent_rewrite`,
`experience_agent_provenance_reject`, `experience_agent_fallback`,
`experience_agent_coverage_final`.

Message-keyed (filter by `msg=` instead of `event=`), both added in the
e2e-provenance work: `experience_jd_echo_rewrite_applied` (the routed jd-echo
re-write in `routeExperienceJdEcho` spliced a valid, provenance-clean rephrase
-- fires at most once per run, carries `flagged`, the count of guard
violations it addressed) and `experience_mutated_downstream` (the Task-4
final-text assert, `experienceMutatedDownstream`, found the shipped Experience
section diverged from `assembleExperience(kept)` -- see "What good looks
like": this should never fire).

Replay one run end to end (structured events only):

```logql
{namespace="job-strategist"} | json | event=~"experience_agent_.*"
  | pipeline_run_id="<PIPELINE_RUN_ID>"
```

Add the two message-keyed lines to the same replay (both run-id spellings --
see the field-name split above):

```logql
{namespace="job-strategist"} | json
  | pipeline_run_id="<PIPELINE_RUN_ID>" or pipelineRunId="<PIPELINE_RUN_ID>"
  | msg=~"experience_agent_.*|experience_jd_echo_rewrite_applied|experience_mutated_downstream"
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

Which career lines were dropped and why (`experience_agent_dropped`, emitted
only when `diag.provenance.dropped.length > 0`; bounded to 30 entries / 200
chars per reason by `boundDropped`, see experience-ats-flow.ts):

```logql
{namespace="job-strategist"} | json | event="experience_agent_dropped"
  | line_format "{{.pipeline_run_id}} {{.dropped}}"
```

Final-text coverage (`experience_agent_coverage_final` -- see Surface 3 for
why this is the number to compare across an A/B, not `coverageBefore`):

```logql
{namespace="job-strategist"} | json | event="experience_agent_coverage_final"
  | line_format "{{.pipeline_run_id}} covered={{.covered}}/{{.of}} missing={{.missing}}"
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
rewriteViolations,droppedLines,dropped}, coverageFinal:{targets,covered,missing}|null }`.

`coverageFinal` is the ONE number to use for an A/B or before/after comparison:
`coverageBefore`/`rewrite.coverageAfter` score DRAFT text at decision time
(before the jd-echo route, guards, length budget, and surface-keywords all
run); `coverageFinal` is stamped by `stampExperienceCoverageFinal` immediately
before this metadata write, against whatever text actually shipped (`kept` is
locked immutable after the agent runs -- see `experience-lock.ts` -- so its
bullet `sources` stay valid for the final text). It is `null` only on the
verbatim-career fallback path (no agent output to score).

Fleet view:

```sql
SELECT id,
       metadata->'analysis'->'experienceAgent'->'coverageBefore'->>'covered' AS covered_before,
       metadata->'analysis'->'experienceAgent'->'coverageFinal'->>'covered'  AS covered_final,
       metadata->'analysis'->'experienceAgent'->'rewrite'->>'kept'           AS kept,
       metadata->'analysis'->'experienceAgent'->'fallback'->>'fired'         AS fell_back,
       metadata->'analysis'->'experienceAgent'->'provenance'->>'droppedLines' AS dropped
FROM pipeline_runs
WHERE pipeline_type = 'strategist'
  AND metadata->'analysis' ? 'experienceAgent'
ORDER BY created_at DESC LIMIT 50;
```

## Surface 4 -- isolated LLM cost

Up to three Bedrock calls can fire per run -- the first pass, the ATS
coverage re-write (`resolveExperienceAts`), and the jd-echo cleanup re-write
(`routeExperienceJdEcho`) -- but only two distinct agent names: the first pass
books as `strategist-experience`; BOTH re-write paths book as
`strategist-experience-rewrite` (the `LIKE` below captures all of them; the
Loki `experience_agent_rewrite` and `experience_jd_echo_rewrite_applied`
events are how you tell which one fired):

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
- `section_net_fired_total{section="experience",pass="surface_keywords",outcome="restored"}`
  trending to zero = the agent covers ATS keywords by construction (surface-keywords
  never needed to touch experience, so the lock never fired); sustained
  firings = coverage gap, check which targets `experience_agent_scored`
  reports missing. `outcome="changed"` on ANY pass for `section="experience"`
  should never be nonzero -- if it is, a call site is missing its
  `withExperienceLock` wrap (experience-lock.ts); treat that as a bug, not a
  tuning signal.
- `kept_first{reason=no-coverage-gain}` sustained high = the re-write pass burns
  a Sonnet call without improving coverage -- candidate for tuning or removal.
- Dropped-lines counts in the diagnostics show how much of the user's history is
  being consciously excluded; a spike means the JD relevance filter is too
  aggressive -- read `experience_agent_dropped`'s `dropped[]` reasons, not just
  the count.
- `coverageFinal` (metadata + the `experience_agent_coverage_final` Loki event)
  is the number for any A/B or before/after comparison -- `coverageBefore`
  measures the FIRST draft, before the jd-echo route and every downstream
  safety-net pass; only `coverageFinal` reflects what actually shipped.
- `experience_jd_echo_rewrite_applied` firing is expected and healthy whenever
  `experience_bullet_jd_echo` guard violations were raised -- it means the
  advisory got FIXED, not just reported (`guardResume`'s own repair on
  Experience is undone by the lock, so this route is the only path that
  actually rewrites an echoing bullet).
- `experience_mutated_downstream` should NEVER fire. It is the final,
  post-hoc proof that every resume-mutating pass respected the Task-2 lock; if
  it fires, some call site mutates Experience outside `withExperienceLock` --
  treat it exactly like an `outcome="changed"` net-fired reading: a bug to fix,
  not a tuning signal.
