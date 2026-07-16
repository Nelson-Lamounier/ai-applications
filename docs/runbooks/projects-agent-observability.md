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
- `job_strategist_section_net_fired_total{section, pass, outcome}` (Counter,
  `section = experience | projects | projects_description`,
  `pass = guard | length | surface_keywords` plus experience-only
  `reframe | metric_weave | revalidate`, `outcome = changed | restored`) --
  increments when a downstream safety-net pass diverged from the pre-pass
  section snapshot. This is the retirement evidence for `guard` and
  `surface_keywords` on `section="projects"`: `outcome="changed"` trending
  to zero means the agent delivers fidelity/keywords by construction, and
  sustained firings mean it under-delivers (read the Loki events to see what
  changed). `pass="length"` is NOT a retirement signal -- it legitimately
  fires whenever the combined resume exceeds the page budget and trimming
  touches projects. `section="projects"` (highlights/github/name) has no
  immutability lock (unlike `section="experience"`, see below), so it only
  ever emits `outcome="changed"` -- `outcome="restored"` never appears there.
  NOTE: PR-B removed the OLD, experience-only
  `job_strategist_experience_net_fired_total{pass}` counter this generalised
  one superseded (`section="experience"` here is its exact equivalent). The
  job-strategist experience e2e-provenance work then wrapped every
  `section="experience"` call site in `withExperienceLock`
  (`agents/writer/experience-lock.ts`), turning that section's
  `outcome="changed"` tripwire into enforcement (it now reads ~0; watch
  `outcome="restored"` instead) -- see the experience-agent-observability
  runbook for the experience-scoped panel query and semantics.
- `section="projects_description"` (Task 2, `withProjectsDescriptionLock`,
  `agents/writer/experience-lock.ts`) -- the FIELD-scoped twin of the
  experience lock, restoring ONLY `projects[].description` (never
  `highlights`/`github`) the moment any of the 8 downstream resume-mutating
  passes (guard repair, migration reframe, length x2, metric weave,
  revalidate x2, surface_keywords -- see `withSectionLocks`, `run-pipeline.ts`)
  diverges from the pre-pass description. Unlike plain `section="projects"`,
  this IS an enforcement lock, so it only ever emits `outcome="restored"`
  (never `"changed"` -- a divergence is always reverted before the pass
  returns). This is the retirement evidence for the OLD "three-beat" pitch +
  differentiator + metric recipe (`rewrite.ts`'s `project_restates_bullets` /
  `project_pitch_missing` codes, now DETECTED-but-ADVISORY-ONLY -- no rewrite
  is even attempted for them, since any attempt would be reverted here
  anyway): sustained `outcome="restored"` firings mean some pass is still
  trying to rewrite the description (persona/prompt drift on that pass, not
  a bug in the lock), while a steady ~0 means the stamp survives untouched,
  same target shape as the experience lock's `outcome="restored"` reading ~0.
  Each restore also writes one `projects_description_lock_restored` entry to
  the violation log (see `ViolationLog`, `lib/observability/violation-log.ts`)
  under the pass's own stage.
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
sum by (pass, outcome) (increase(job_strategist_section_net_fired_total{section="projects"}[$__range]))
sum by (pass) (increase(job_strategist_section_net_fired_total{section="projects_description", outcome="restored"}[$__range]))
increase(job_strategist_projects_repo_unresolved_total[$__range])
```

## Surface 2 -- Loki event stream

Datasource UID `loki`. Events: `projects_agent_targets`, `projects_agent_scored`,
`projects_agent_normalised`, `projects_agent_rewrite`,
`projects_agent_provenance_reject`, `projects_agent_fallback`,
`projects_repo_unresolved`.

`projects_agent_normalised` (fields: `extras`, a bounded int) fires once per
run, ONLY when `extras > 0` -- the count of items/fields the normalise-then-
validate pass (`normaliseProjectsAgentOutput`, `projects-schema.ts`) stripped
from the agent's raw tool-call response before it could pass
`ProjectsAgentOutputSchema.parse`, summed across the first draft and any
re-write call (`ProjectsAgentDiagnostics.normalisedExtras`). Two known,
harmless sources make up most of the count and should NOT be tuned away by
loosening the validator: (1) whenever the model emits ANY non-empty
`description` text on an entry (the tool schema tells it the field is
system-authored and discarded, but a model may still fill it), that text is
unconditionally blanked, one extra per such entry (Task 2 -- the pipeline
always re-stamps the field from the stored pitch); (2) the model's own
provenance habit of echoing `sources` alongside a `bulletId` on an otherwise-
curated highlight. EXPECTED TREND: zero is achievable and is the target --
it means the model stopped emitting a description at all AND stopped
echoing sources on curated highlights, so the normaliser had nothing to
strip. A NON-zero count is not a rejection (the response still ships,
normalised) but IS a persona-tuning signal: a rising count over time means
the model is volunteering more malformed shapes, worth a prompt-tuning look
before it drifts toward a shape the normaliser does not yet tolerate.

```logql
{namespace="job-strategist"} | json | event="projects_agent_normalised"
  | line_format "{{.pipeline_run_id}} extras={{.extras}}"
```

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
`bullet_count:*`, `composed_cap:*`, `github_mismatch:*`; `which`
distinguishes the first draft from the re-write. The old `description_words`
and `pitch_overlap` tokens are RETIRED: the description field is
system-stamped from the stored pitch AFTER validation and the normaliser
blanks any agent emission BEFORE it, so there is nothing of the model's to
validate -- `pitch_overlap` in particular fired on the blanked echo of every
entry, forcing every run into the fallback; seeing either token in old logs
dates the run to before the retirement):

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
rewriteViolations,composedCount}, unresolvedRepos:string[], normalisedExtras:number }`.
`normalisedExtras` here is the SAME number the `projects_agent_normalised`
Loki event carries (Surface 2) -- persisted so a fleet-wide SQL query can
trend it without replaying Loki.

Fleet view:

```sql
SELECT id,
       metadata->'analysis'->'projectsAgent'->'coverageBefore'->>'covered' AS covered,
       metadata->'analysis'->'projectsAgent'->'rewrite'->>'kept'           AS kept,
       metadata->'analysis'->'projectsAgent'->'fallback'->>'fired'         AS fell_back,
       metadata->'analysis'->'projectsAgent'->'provenance'->>'composedCount' AS composed_count,
       metadata->'analysis'->'projectsAgent'->'unresolvedRepos'            AS unresolved_repos,
       metadata->'analysis'->'projectsAgent'->>'normalisedExtras'          AS normalised_extras
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

## Surface 5 -- operations-angle theme evidence (Task 3)

Kind-scoped, theme-driven, retrieval-only evidence gather (NO new LLM call --
see docs/superpowers/specs/2026-07-16-projects-operations-evidence-design.md)
that runs BEFORE the Projects agent, inside `buildProjectAgentInputsWithOperationsEvidence`
(`run-pipeline.ts`) / its extracted pure core `buildProjectAgentInputsFromMeta`
(`agents/evidence/operations-wiring.ts`). When the JD's flattened hard-requirement
skills + preferred skills + concepts match any of the seven `OPERATIONS_THEMES`
entries (`agents/evidence/operations-themes.ts` -- database operations,
performance tuning, storage, networking protocols, security hardening, backup
recovery, cluster orchestration), up to 3 activated themes each retrieve up to
2 kind-scoped facts per project (capped at 6 facts per project overall) and
APPEND them to the research agent's `verifiedMatches` before the two-lane pool
is built -- so operations facts flow through the exact same fail-closed
repository-ID attribution as every other verified match (see "What good looks
like" below on `project_components.kind`). A JD with zero theme hits is a
complete no-op: no retrieval calls, no events, pool identical to before this
feature shipped.

**Diagnostics block.** `ProjectsAgentDiagnostics.themes` (`projects-ats-flow.ts`)
-- `{ activated: string[], factCounts: Record<themeKey, number> }` -- `activated`
is the ordered list of theme KEYS the JD hit (bounded: one of the seven ontology
keys, never free text); `factCounts` is theme key -> fact count gathered across
every project. `EMPTY_OPERATIONS_THEMES_DIAG` (`{ activated: [], factCounts: {} }`)
is the value on every no-op path (zero themes, meta-load failure, or a
gather-time throw that never produced a fact). Persisted into the SAME
`pipeline_runs.metadata.analysis.projectsAgent` blob as Surface 3 above:

```sql
SELECT id,
       metadata->'analysis'->'projectsAgent'->'themes'->'activated'   AS themes_activated,
       metadata->'analysis'->'projectsAgent'->'themes'->'factCounts'  AS theme_fact_counts
FROM pipeline_runs
WHERE pipeline_type = 'strategist'
  AND metadata->'analysis'->'projectsAgent'->'themes'->'activated' <> '[]'::jsonb
ORDER BY created_at DESC LIMIT 50;
```

**Loki event: `projects_theme_evidence`.** Emitted by `logProjectsThemeEvidence`
(`agents/writer/projects-agent-diagnostics.ts`), called from the wiring right
after the gather completes -- independent of, and well before,
`projects_agent_*` (those fire only once the Projects agent itself resolves).
Fires ONLY when at least one fact was gathered (a themeless or evidence-less
run produces no event, no log noise). Payload: `themes`, a nested
`{ themeKey: { repoFullName: count } }` cross-tab built from the raw
`VerifiedMatch[]` the gather returned (theme label mapped back to its bounded
ontology key), NOT from the flat `factCounts`/`byRepo` summaries -- this is
the only surface that answers "which repo grounded which theme":

```logql
{namespace="job-strategist"} | json | event="projects_theme_evidence"
  | line_format "{{.pipeline_run_id}} {{.themes}}"
```

Which-repo-grounded-which-theme, for one run (the same query, scoped):

```logql
{namespace="job-strategist"} | json | event="projects_theme_evidence"
  | pipeline_run_id="<PIPELINE_RUN_ID>"
  | line_format "{{.themes}}"
```

**Fail-open failure investigation.** A retrieval-side failure (bad store
construction, a rejected `retrieve()` call, or `gatherOperationsEvidence`
itself throwing) logs a WARN `operations_evidence_failed_open` with the raw
error message -- the run still ships the ordinary pool (research-agent
`verifiedMatches` only), just with zero theme facts:

```logql
{namespace="job-strategist"} | json | event="operations_evidence_failed_open"
```

A meta-load failure (the projects/repositories SELECT itself, e.g. RLS/DB
outage) is the OUTER, pre-existing fail-open path and logs
`project_agent_inputs_load_failed_fail_open` -- same event as before this
feature shipped, degrading all the way to the empty skeleton pool (no
curated bullets, no repo-current facts, no theme facts):

```logql
{namespace="job-strategist"} | json | event="project_agent_inputs_load_failed_fail_open"
```

**No dedicated Prometheus metric.** Theme activation/fact counts are
Loki + SQL only (Surfaces above) -- deliberately no new Counter/Histogram
label (`activated`/`factCounts` are open-ended enough across the seven-theme
ontology that a metric label would either be unbounded or need its own
seven-way enum for marginal value; the bounded outcome/coverage/repo-unresolved
metrics in Surface 1 are unaffected -- operations facts are indistinguishable
from any other repo-current fact once they reach the agent).

## Ordering and the highlights length budget (deterministic, no LLM)

These two behaviours are NOT agent output -- they run unconditionally after
the section is filled (agent path or fallback), so they have no dedicated
Prometheus metric or Loki event; this section documents the code path
directly for when a resume's project ORDER or highlight COUNT looks
surprising.

**JD-ranked entry ordering (Task 3).** Both the agent-composition rules
(persona/`projects-message.ts`: "ordered most-JD-relevant project first")
and the deterministic fallback (`deterministicProjects`,
`projects-ats-flow.ts`) order entries by JD relevance, most-relevant first.
The fallback's ordering is exact and testable: each pool entry is ranked by
`coveredTargets` -- the count of ATS targets its OWN selected (post-slice)
highlights term-match via `experienceTermMatch` -- sorted DESC, ties broken
by the pool's original index (stable). A project with zero JD-relevant
curated bullets sorts to the bottom regardless of where it sits in the
`projects` table; this is why a resume can show a project ahead of one
documented earlier. Not a bug to "fix" by touching the pool order -- if a
project should rank higher, its curated bullets need to actually
term-match the JD, or its repo-current lane needs a relevant fact (see the
STALENESS signal above).

**The 180-word highlights budget and its 1-bullet floor (Task 4).**
`LENGTH_BUDGET.projectsHighlightWords` (`ats/length/length-budget.ts`) caps
the combined word count of every project's highlight bullets (summed
across all entries) at 180 -- tracked separately from
`LENGTH_BUDGET.projectsWords` (descriptions only) in `measureResume`, and
flagged as its own `overBudget` reason, `projects_highlights`. When the
resume is over EITHER the description or highlights projects budget,
`hardTrim`'s `trimProjectHighlights` fires: whole-bullet drops ONLY (a
highlight may be a byte-fidelity curated quote, so it is never reworded or
truncated mid-bullet), round-robin starting from the LAST entry's LAST
bullet and working backward (entries are already JD-ordered by the ranking
above, so the least-relevant entry loses bullets first), wrapping across
entries until back under budget. FLOOR: no entry is ever trimmed below 1
remaining highlight -- a stripped-bare entry reads as filler, so the floor
mirrors `minBulletsPerRole`'s spirit for experience. If every entry is
already at the 1-bullet floor and the section is STILL over 180 words, the
trim stops there and the section ships over budget -- deliberately
fail-open (a professionally-written project bullet is worth more than a
hard word-count guarantee); the condense prompt's highlights line (see the
persona) is the intended lever for that shape, not a stricter hard trim.

## What good looks like

- `outcome=aware`/`rewritten` dominate; a rising `fallback{reason=provenance-invalid}`
  means the agent is mis-citing across projects or over-composing -- read the
  `_provenance_reject` tokens and tune the persona, never loosen the validator.
- `section_net_fired_total{section="projects",pass="surface_keywords",outcome="changed"}`
  trending to zero = the agent covers ATS keywords by construction; sustained
  firings = coverage gap, check which targets `projects_agent_scored` reports
  missing. (`highlights`/`github`/`name` have no immutability lock yet, so
  `outcome="changed"` is still the live signal here -- unlike
  `section="experience"`, where the same label now reads ~0 because the lock
  restores every divergence; see the experience-agent-observability runbook.)
- `section_net_fired_total{section="projects_description",outcome="restored"}`
  reading ~0 = the description stamp is surviving every downstream pass
  untouched (the expected steady state, same shape as the experience lock).
  A sustained non-zero reading means some pass is still attempting to
  rewrite `projects[].description` -- it is always reverted before shipping,
  so this is never a correctness risk, only a wasted-effort signal; check
  the `projects_description_lock_restored` violation-log entries for which
  pass keeps firing and tune that pass's prompt, not the lock.
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
- `job_strategist_projects_agent_outcome_total{outcome="aware"|"rewritten"}`
  on an operations-flavoured JD (a run with a non-empty
  `themes.activated` in Surface 5) with a healthy `factCounts` and STILL a
  low/zero coverage on operations-shaped ATS targets is a persona-tuning
  signal, not a retrieval bug: the facts reached the pool, the agent chose
  not to compose from them -- check the persona rule that prefers operations
  evidence for operations-flavoured JDs before touching the gather.
- `project_components.kind` is now LOAD-BEARING for resume generation, not
  descriptive-only metadata: `agents/evidence/operations-evidence.ts`'s
  kind-scoped retrieval gate (Surface 5) reads it per member repo, and a
  repo whose `kind` is missing, misclassified, or stale (e.g. an infra repo
  still tagged `ml` from an earlier case-study run) simply never qualifies
  for ANY operations theme -- it is silently excluded from every
  `gatherOperationsEvidence` retrieval call for that project, with no
  warning and no failed event (this is normal kind-scoping, not a fail-open
  path). If an operations-flavoured JD run shows `themes.activated`
  non-empty but `factCounts` stays at 0 (or a specific project's own
  operations coverage looks thin) for a project you KNOW has relevant infra
  docs, check that project's `project_components.kind` rows before
  suspecting the retrieval or the ontology.
