# Phase 5 -- Per-Section Agents + Deterministic Reconciler -- Design

**Date:** 2026-07-14
**Status:** Approved design -- pending implementation plans
**Builds on:** Phase 3 (summary agent, PR #483) and Phase 4 (experience agent, PR #484), both on develop.
**Delivery:** ONE spec (this document), TWO stacked PRs (PR-A, PR-B below). The live
UI JD A/B runs after PR-B deploys and validates Phases 3+4+5 together.

## Problem

After Phases 3+4 the strategist-writer still burns the pipeline's dominant cost --
a Sonnet extended-thinking call (~6 min, ~80% of wall-clock, 8192 thinking budget,
64K maxTokens) -- yet most of what it emits is now skeleton or verbatim:

- summary: empty (Phase 3 agent fills it); experience: roster skeleton (Phase 4).
- education / certifications / profile: instructed to REPRODUCE VERBATIM from
  loader blocks -- no authoring.
- projects: highlights are QUOTE-ONLY selections from `project_resume_bullets`
  (case-study pipeline output); deterministic code (`relocateProjectExperience` /
  `fillEmptyHighlights`) already reconstructs them when the writer misfiles or
  blanks them. The writer's genuine contribution is bullet RANKING against the JD
  and the <=40-word description phrasing.

Its genuinely-LLM outputs are the analysis narrative (`analysisXml`: fit rating,
reframes, gap mitigations, ESL) + archetype selection (whose `leadIdentity` /
`archetypeId` / `sectionOrder` feed the guards), the cover letter (authored INSIDE
analysisXml today), and skills selection.

Pipeline wiring issues found by the Phase 5 trace:

1. `restoreProjectHighlights` runs once (before the ATS attainable loop); the
   loop's surfaceKeywords re-emit round-trip has NO restore afterwards -- a silent
   project-bullet blanking path.
2. `project_resume_bullets` must be read via `withUserRls` (pgbouncer transaction
   pooling silently yields 0 rows otherwise) -- any new loader must preserve this.

## Goals

1. Dedicated Projects agent (full Phase-4 mirror: provenance + ATS lane) over a
   TWO-LANE pool: curated case-study quotes enforced BY SCHEMA (bullet ids,
   never bullet text) + repo-current research evidence strictly attributed per
   project, from which at most 2 grounded bullets may be composed for JD targets
   the curated pool cannot answer (resolves case-study staleness vs repo sync).
2. Remove the strategist-writer LLM entirely: three dedicated agents (analysis,
   cover-letter, skills) + a deterministic reconciler that assembles the resume.
3. Rewire run-pipeline: section agents run in PARALLEL after research; documented
   ordering contract; fix the restore gap; extend net-fired instrumentation.
4. Phase-3/4-grade observability, cost isolation, evals per agent.

## Non-goals

- Free tier (untouched; own writer).
- Research agent, jd-extractor, guard chain, length budget, ATS gate internals --
  all unchanged (the downstream safety net stays, instrumented).
- Changing the `analysisXml` consumer contract (grounding verifier, path checker,
  semantic cache, admin UI all keep working unchanged).
- Retiring net passes (still evidence-gated on net-fired counters).

## Decisions (locked with the user)

1. **Projects agent = full Phase-4 mirror** (agent + provenance validator + ATS
   lane with one bounded re-write). The re-write's levers are re-SELECTION of
   bullets and the description prose (bullets themselves are immutable quotes).
2. **Full writer split**: analysis-agent + cover-letter-agent + skills-agent +
   deterministic reconciler. The writer's extended-thinking call is deleted.
3. **One spec, two stacked PRs**: PR-A ships the projects agent + wiring fixes
   (writer drops projects to skeleton, keeps analysis/cover-letter/skills);
   PR-B ships the writer split + reconciler + parallelisation.

## Architecture (target, after PR-B)

```text
research -> matching guards -> ledger/provenance          [unchanged]
   |
   v
PARALLEL section-agent stage (Promise.all; replaces executeStrategistAgent):
   analysis-agent    Sonnet, thinkingBudget 2048 (the one deliberative task)
   experience-agent  shipped Phase 4 (forced tool, tb 0)
   projects-agent    NEW (forced tool, tb 0)
   skills-agent      NEW (forced tool, tb 0, small)
   cover-letter-agent NEW (forced tool, tb 0; only when includeCoverLetter)
   |
   v
reconcileResume (NO LLM) -- assembles tailored_resume_json:
   profile/education/certifications verbatim blocks
   + experience/projects/skills agent outputs
   + sectionOrder + leadIdentity from analysis-agent
   |
   v
summary-agent (shipped Phase 3; AFTER reconciler so it sees the real body)
   |
   v
existing chain unchanged: cover-letter guard, relocate, guardResume, migration
reframe, length budget, number strip, weave (experience restored), revalidate,
integrity, restoreProjectHighlights, persist, ATS gate + attainable loop
(+ NEW post-loop restoreProjectHighlights), prose lint, metadata, cache, status
```

Expected effect: the ~6-min extended-thinking call disappears; the parallel stage
is bounded by its slowest member (experience agent, ~10-30s class); pipeline
wall-clock drops from ~8 min toward ~3 min; Sonnet spend roughly halves.

## Components

### PR-A

#### projects-agent (`agents/writer/projects-agent.ts` + `projects-message.ts` + `projects-schema.ts` + `projects-provenance.ts` + `projects-ats-flow.ts`)

- **TWO-LANE bullet pool per project** (user decision -- resolves case-study
  staleness: `project_resume_bullets` is written by the user-triggered
  case-study pipeline and LAGS the repo sync, while the research agent's
  verified matches are grounded in the synced KB fresh on every run):
  - **Curated lane** `[p{i}.b{j}]`: verbatim quotes from `loadProjectResumeBullets`
    (withUserRls preserved). The narrative backbone -- quote-only, preferred.
  - **Repo-current lane** `[p{i}.r{k}]`: research `verifiedMatches` mapped to
    THIS project STRICTLY by repo ownership, resolved by REPOSITORY ID, not by
    name-vs-name string comparison:
    1. Extract `owner/repo` from the match's `evidenceFiles`/`sourceCitation`
       paths (REUSE the evidence-lane parser -- paths embed the repo name at
       ingestion time; this name hop is unavoidable at entry).
    2. Resolve that name to the `repositories` row (per-user lookup map of
       `full_name -> {id, github_repo_id}` loaded once per run) -- the row
       carries the internal UUID and the immutable GitHub numeric id.
    3. Attribute the match to a project ONLY when the resolved `repositories.id`
       is in that project's `project_repositories.repository_id` set (already a
       UUID FK -- rename-proof on this hop).
    An UNRESOLVED name (repo renamed after ingestion, not yet reconciled by the
    reconcileRepoName maintenance path) attributes to NO project and increments
    a labelled Loki/counter event (`projects_repo_unresolved`) -- fail-closed,
    never guessed. Matches with no repo provenance, or whose repo is owned by
    no project, appear in NO project's lane. A repo owned by multiple projects
    contributes its matches to each owner. Lane records carry
    `{repositoryId, githubRepoId, fullName}` in the diagnostics for audit.
- **Payload** (`projects-message.ts`): the two-lane pool; documented
  pitch/stack/decisions/repo URLs from `loadProjectEvidenceBlock`; JD
  requirements + top-6 attainable targets (REUSE `selectExperienceAtsTargets`);
  re-write fields (draft + missing targets). Composition rule in the message:
  curated bullets first; a composed bullet is allowed ONLY for a JD target the
  curated pool does not answer, max 2 composed per project.
- **Tool schema** (`emit_projects`, forced, thinkingBudget 0): per project
  `{name, github, description, highlights: [{bulletId} | {text, sources: [matchId]}]}`
  -- curated bullets by ID only (system assembles text from the DB: quote-only
  by construction); composed bullets carry text + the repo-current match id(s)
  they are grounded in.
- **Provenance validator** (pure): every bulletId exists in THAT project's
  curated pool, no duplicates; every composed bullet cites >=1 match id from
  THAT project's repo-current lane (cross-project citation = violation, the
  strict-attribution guarantee); <=2 composed bullets per project; ONE entry per
  documented project, name verbatim; github from the project's repo-URL set;
  3-6 bullets when the pool has >=3 (min = pool size when smaller); description
  <=40 words AND >=30% token overlap with the documented pitch (pre-checks the
  existing `checkProjectPitchAlignment` bar).
- **ATS lane** (Phase-4 mirror): strict `scoreSummaryCoverage` over the assembled
  projects text; fire ONE re-write when any target missing, agent name
  `strategist-projects-rewrite`; the re-write's levers are re-SELECTION of
  curated quotes, grounded COMPOSITION from the repo-current lane (within the
  <=2 cap), and the description prose; keep rule = provenance-valid + higher
  coverage, ties/invalid/throw -> first. **Fallback** (agent error or invalid
  first pass): deterministic assembly -- CURATED bullets only, ranked by
  strict-coverage score against the canonical JD skills, description =
  documented pitch trimmed to 40 words, github/name verbatim. Never empty when
  the DB has bullets.
- Writer migration: `projects.md` persona rewritten to skeleton rule (emit
  `projects: []`; the dedicated pass authors entries), version bump + manifest;
  message-builder project sections move to the agent payload.

#### Pipeline wiring fixes (PR-A)

- `restoreProjectHighlights` ALSO runs after the ATS attainable loop's re-emit
  sequence (before the re-persist), closing the silent-blanking path.
- Net-fired instrumentation extended: `job_strategist_projects_agent_outcome_total`
  {outcome,reason} + coverage histogram + net tracking for the projects section
  via a NEW generalised counter `job_strategist_section_net_fired_total{section,pass}`.
  PR-A emits BOTH the new counter (sections experience+projects) and the existing
  `job_strategist_experience_net_fired_total` (unchanged, so no dashboard break);
  PR-B removes the old experience-specific counter and updates the runbooks.
- Ordering contract comment block at the top of main() documenting the required
  stage order and why (research -> agents -> reconcile -> summary -> net -> ATS).

### PR-B

#### analysis-agent (`agents/analysis/analysis-agent.ts` + persona module)

Authors the analysis narrative + archetype selection. Sonnet, thinkingBudget
2048 (deliberative; still ~4x below the old writer). Output contract: the SAME
`analysisXml` string shape consumed today (phase_0 archetype block, metadata
tags, mitigation blocks, resume_tailoring suggestions) MINUS `<cover_letter>` and
MINUS `<tailored_resume_json>` -- extraction helpers move over unchanged;
`extractArchetypeSelection`/`extractMetadataFromXml`/`extractGapMitigations`
continue to work byte-compatibly. Grounding verifier, `verifyAnalysisPaths`,
semantic cache, and admin UI are untouched. Failure = pipeline failure (load
bearing, same severity as writer failure today).

#### cover-letter-agent (`agents/writer/cover-letter-agent.ts`)

Forced-tool call emitting the CoverLetterSchema JSON (greeting, paragraphs,
signoff); persona = the existing `cover-letter.md` module (own version bump as it
becomes standalone). Runs in the parallel stage only when `includeCoverLetter`.
`guardCoverLetter` downstream unchanged. Failure: omit the letter + violation
logged (never blocks the resume).

#### skills-agent (`agents/writer/skills-agent.ts`)

Small forced-tool call: input = verified + partial matches, JD requirements,
role emphasis; output = ordered skill groups matching the current skills schema.
Validator: every emitted skill is in the verified/transferable ledger set (gaps
structurally excluded). Fallback: deterministic ordering of verified matches.

#### reconcileResume (`lib/resume-reconciler.ts`, pure)

`reconcileResume({contact, education, certifications, experience, projects,
skills, sectionOrder, leadIdentity}) -> StructuredResumeData`. Validates against
the single-source base schemas (`schemas/resume-sections.ts`); REFUSES to emit an
empty required section -- fills from the deterministic fallbacks instead (career
highlights verbatim for experience is already Phase 4's fallback; projects
fallback per above; skills fallback per above). Summary stays '' here (Phase 3
agent fills after). keyAchievements: [] (retired instruction preserved).
`executeStrategistAgent`, `STRATEGIST_CONFIG`, the writer personas
(`_base_1..5`, `experience.md` skeleton module, `projects.md` skeleton module,
`skills-education.md`) are deleted/archived; prompt-manifest pruned (integrity
test's stale-entry check enforces this).

#### Parallelisation (PR-B)

`Promise.all([analysis, experience, projects, skills, coverLetter?])` directly
after the ledger; each agent already has bounded fallbacks; a rejected
load-bearing member (analysis) fails the run, others degrade to fallbacks.
`fillResumeExperience`/`fillResumeSummary` splices are refactored into the new
stage shape but keep their internal logic, diagnostics, and metric names.

## Observability / cost (both PRs)

Per new agent: bounded-outcome Counter {outcome,reason} + Loki event stream +
fold into `pipeline_runs.metadata.analysis.<agentKey>` (single shallow-merge-safe
write) + distinct AgentName union members (`strategist-projects`,
`strategist-projects-rewrite`, `strategist-analysis`, `strategist-cover-letter`,
`strategist-skills`) for `prompt_invocations` isolation. Runbook extended
(`docs/runbooks/`): section-agent panel set + the pipeline-duration before/after
panel (writer removal is the headline).

## Testing / evals

- Unit: each validator, each ats-flow decision table, reconciler (assembly,
  refuse-empty, schema round-trip), restore-gap regression test (ATS-loop re-emit
  cannot blank project highlights).
- Evals (CLAUDE.md section 5): `evals/projects` (quote-only ids, pitch-overlap
  description, JD-relevant selection golden, one-entry-per-project),
  `evals/skills` (ledger-membership, JD ordering), `evals/analysis` (archetype
  validity, no-fabrication vs research brief, mitigation grounding),
  cover-letter reuses its guard rules as graders.
- Live A/B after PR-B: duration/cost before-vs-after, section quality, net-fired
  trends, provenance-reject rates.

## Consequences

- The pipeline's dominant cost/latency (extended-thinking writer) is removed;
  prose authorship is five focused, individually evaluable agents plus two
  shipped ones; assembly is deterministic and unit-testable.
- Two new failure lanes (projects/skills) degrade deterministically; analysis
  remains the single load-bearing LLM besides research.
- prompt_invocations gains five agent names; per-section cost is directly
  queryable.
