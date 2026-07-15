# Projects-agent observability runbook

How to observe, debug, and cost-account the dedicated Projects agent (Phase 5).
The lane runs inside `fillResumeProjects` in the job-strategist analysis
pipeline, AFTER the Experience agent and BEFORE the summary agent (the writer
emits an empty `projects: []` skeleton; the Experience agent fills roles
first so the summary agent sees real body content, not empty skeletons): the
Projects agent composes each documented project's entries from a two-lane
pool -- CURATED (already-written resume bullets) and REPO-CURRENT (facts
freshly attributed from the Skill Evidence Ledger by repository ID) -- under
a schema-enforced, provenance-guarded contract; coverage is scored strictly
against the SAME top-N ATS targets picked for the Experience lane (one JD-target
selection shared by both agent-owned sections, not a second independent pick);
at most one bounded re-write fires; on any failure (schema/network/provenance)
the section falls back to a deterministic, curated-bullets-only ranking so the
pipeline never persists a fabricated project entry.

> Dashboards are provisioned out-of-repo (Grafana Cloud); this runbook is the
> source of truth for the panel queries. Metrics/events appear only after the
> Phase 5 image is deployed and a paid analysis run has executed.

## Correlation keys

Every Loki event carries `pipeline_run_id`, `application_id`, and `trace_id`
(`trace_id` is `null` in `run-pipeline` -- filter by `pipeline_run_id`).

## Surface 1 -- Prometheus metrics

- `job_strategist_projects_agent_outcome_total{outcome, reason}` (Counter).
  `outcome`: `aware` (no re-write needed), `rewritten`, `kept_first`, `fallback`
  (deterministic curated-only ranking used). `reason` is a bounded enum:
  `coverage-met`, `no-targets` (aware); `rewrite-covers-more` (rewritten);
  `no-coverage-gain`, `rewrite-provenance-invalid`, `rewrite-threw` (kept_first);
  `provenance-invalid`, `agent-error` (fallback). The raw error string is
  NEVER a label (Loki-only, on the `projects_agent_failed_deterministic_fallback_used`
  warn log and inside the `projects_agent_fallback` event's diagnostics).
- `job_strategist_projects_agent_coverage` (Histogram, buckets `[0..6]`) --
  covered ATS targets in the FIRST pass; sampled only when targets exist and the
  run did not fall back.
- `job_strategist_section_net_fired_total{section, pass}` (Counter,
  `section = experience | projects`, `pass = guard | length | surface_keywords`)
  -- increments when a downstream safety-net pass CHANGED an agent-owned
  section after its fill pass ran. This is the retirement evidence for
  `guard` and `surface_keywords` on `section="projects"`: those trending to
  zero means the agent delivers fidelity/keywords by construction, and
  sustained firings mean it under-delivers (read the Loki events to see what
  changed). `pass="length"` is NOT a retirement signal -- it legitimately
  fires whenever the combined resume exceeds the page budget and trimming
  touches projects. NOTE: PR-B removed the OLD, experience-only
  `job_strategist_experience_net_fired_total{pass}` counter this generalised
  one superseded (`section="experience"` here is its exact equivalent) --
  see the experience-agent-observability runbook for the experience-scoped
  panel query.
- `job_strategist_projects_repo_unresolved_total` (Counter, unlabelled) --
  incremented by the COUNT of repo-citation names that failed fail-closed
  attribution to a known project's repository ID during pool construction
  (`ProjectAgentInputs.unresolvedRepos`, see `project-agent-inputs.ts`). The
  name list itself is Loki-only (`projects_repo_unresolved` event) -- never a
  metric label (unbounded cardinality).

Panels (datasource UID `prometheus`):

```promql
sum by (outcome) (increase(job_strategist_projects_agent_outcome_total[$__range]))
sum by (outcome, reason) (increase(job_strategist_projects_agent_outcome_total[$__range]))
sum by (le) (increase(job_strategist_projects_agent_coverage_bucket[$__range]))
sum by (pass) (increase(job_strategist_section_net_fired_total{section="projects"}[$__range]))
increase(job_strategist_projects_repo_unresolved_total[$__range])
```

## Surface 2 -- Loki event stream

Datasource UID `loki`. Events: `projects_agent_targets`, `projects_agent_scored`,
`projects_agent_rewrite`, `projects_agent_provenance_reject`,
`projects_agent_fallback`, `projects_repo_unresolved`.

Replay one run end to end:

```logql
{namespace="job-strategist"} | json | event=~"projects_agent_.*|projects_repo_unresolved"
  | pipeline_run_id="<PIPELINE_RUN_ID>"
```

Fallback investigation (the raw error lives here, not in the metric; also
check the `projects_agent_failed_deterministic_fallback_used` warn log for the
same message with `agent="strategist-projects"`):

```logql
{namespace="job-strategist"} | json | event="projects_agent_fallback"
  | line_format "{{.pipeline_run_id}} {{.reason}}"
```

Provenance rejections (which validator tokens fired -- `unknown_project:*`,
`duplicate_project:*`, `missing_project:*`, `unknown_bullet:*`,
`cross_project_citation:*`, `duplicate_bullet:*`, `uncited_composed:*`,
`bullet_count:*`, `composed_cap:*`, `github_mismatch:*`,
`description_words:*`, `pitch_overlap:*`; `which` distinguishes the first
draft from the re-write):

```logql
{namespace="job-strategist"} | json | event="projects_agent_provenance_reject"
```

Unresolved-repo triage (repo-citation names that could not be attributed to
ANY project's known repository ID during pool construction -- see "What good
looks like" below for what this usually means):

```logql
{namespace="job-strategist"} | json | event="projects_repo_unresolved"
  | line_format "{{.pipeline_run_id}} {{.repos}}"
```

## Surface 3 -- durable per-run diagnostics (SQL)

Persisted at `pipeline_runs.metadata.analysis.projectsAgent` (same
`updatePipelineRunMetadata` write as `experienceAgent` and `summaryAts` --
a single shallow top-level merge of the whole `analysis` object, not a
per-key `jsonb_set`):

```sql
SELECT jsonb_pretty(metadata->'analysis'->'projectsAgent') AS projects_agent
FROM pipeline_runs WHERE id = '<PIPELINE_RUN_ID>';
```

Shape: `{ targets:[{skill,source,verdict,requirement}],
coverageBefore:{targets,covered,missing}, rewrite:{fired,reason,coverageAfter,
kept,keptReason}, fallback:{fired,reason}, provenance:{firstViolations,
rewriteViolations,composedCount}, unresolvedRepos:string[] }`.

Fleet view:

```sql
SELECT id,
       metadata->'analysis'->'projectsAgent'->'coverageBefore'->>'covered' AS covered,
       metadata->'analysis'->'projectsAgent'->'rewrite'->>'kept'           AS kept,
       metadata->'analysis'->'projectsAgent'->'fallback'->>'fired'         AS fell_back,
       metadata->'analysis'->'projectsAgent'->'provenance'->>'composedCount' AS composed_count,
       metadata->'analysis'->'projectsAgent'->'unresolvedRepos'            AS unresolved_repos
FROM pipeline_runs
WHERE pipeline_type = 'strategist'
  AND metadata->'analysis' ? 'projectsAgent'
ORDER BY created_at DESC LIMIT 50;
```

## Surface 4 -- isolated LLM cost

The two passes book under distinct agent names: `strategist-projects` (first
pass) and `strategist-projects-rewrite`:

```sql
SELECT agent,
       (system_prompt_tokens + user_message_tokens) AS input_tokens,
       output_tokens, total_cost_cents, latency_ms
FROM prompt_invocations
WHERE application_id = '<APPLICATION_ID>'
  AND agent LIKE 'strategist-projects%'
ORDER BY invoked_at;
```

## What good looks like

- `outcome=aware`/`rewritten` dominate; a rising `fallback{reason=provenance-invalid}`
  means the agent is mis-citing across projects or over-composing -- read the
  `_provenance_reject` tokens and tune the persona, never loosen the validator.
- `section_net_fired_total{section="projects",pass="surface_keywords"}`
  trending to zero = the agent covers ATS keywords by construction; sustained
  firings = coverage gap, check which targets `projects_agent_scored` reports
  missing.
- `kept_first{reason=no-coverage-gain}` sustained high = the re-write pass
  burns a Sonnet call without improving coverage -- candidate for tuning or
  removal.
- A rising `job_strategist_projects_repo_unresolved_total` (or a growing
  `projects_repo_unresolved` name list) is a RENAME/RECONCILE signal, not a
  code bug: a repo-scoped citation's full name (`owner/repo`) does not match
  any row in `repositories`, most often because a GitHub repo was renamed or
  transferred after the project's `project_repositories` link was written.
  Fix by reconciling the project's repository link (or re-running repo sync),
  not by relaxing the fail-closed attribution in `project-agent-inputs.ts`.
- STALENESS signal: a growing share of `composedCount > 0` runs (i.e. the
  projects section increasingly leans on the repo-current lane rather than
  the curated pool) means the underlying case studies are lagging behind
  what the repository sync already knows -- regenerate the case studies so
  the curated lane catches back up, rather than letting the agent keep
  composing fresh bullets every run to cover the same drifted gap.
