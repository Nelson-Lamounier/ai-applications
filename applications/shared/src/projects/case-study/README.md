<!-- @format -->

# case-study/

Generates the **per-project case study**: the recruiter-facing artefact with
a product pitch, verified stack, engineering decisions, highlights,
challenges, an architecture diagram, depth markers, and resume bullets. One
run covers one project. One Sonnet call emits the whole payload through a
forced tool; deterministic code supplies every number and every grounding
verdict.

## Data flow

```text
projects / project_components / project_repositories   (which repos, which roles)
document_embeddings   (KB chunks, README product context, fileClass lane counts)
repo_commits / repo_commit_files / repo_pull_requests  (activity evidence)
repo_sync_state       (archetype signals)
technology_evidence   (SBOM-verified stack)
user_profile_rollup   (seniority → stage)
        ↓
loadCaseStudyContext  →  packContext (120k-token budget)
        ↓
Redis exact cache (scope casestudy:<userId>:<projectId>, key = input hash;
                   bypassed on refine runs)
        ↓ miss
bedrockCaseStudyAgent (Sonnet 4.6, tool emit_case_study, 32k max tokens,
                       deterministic schema repair + one bounded retry)
        ↓
groundFromCitations   (GROUNDED iff a row cites >= 1 commit/PR/file)
depthMarkers override (loader-derived values replace the model's, always)
        ↓
persistCaseStudy      (one transaction, eight tables)
        ↓
article-topic discovery (optional byproduct, ARTICLE_TOPIC_DISCOVERY=1)
```

## Inputs (reads)

The loader (`case-study-loader.ts`) reads, per project: `projects`,
`project_components`, `project_repositories` (joined to `repositories` and
`repository_profiles`), `repo_sync_state.archetype_signals`,
`document_embeddings` three ways (full-text-selected KB chunks capped at 24,
README rows for product context, fileClass lane counts for depth markers),
`repo_commits` (fair-share interleaved across repos), `repo_pull_requests`,
`repo_commit_files` (most-changed files, cap 30; fix-density difficulty
signals), `technology_evidence` (verified stack, cap 80), and
`user_profile_rollup.direction` (seniority). Archetype/stage calibration
uses `../archetype` plus the `project_archetypes` / `project_stage_overlays`
ontology tables via `RdsProjectOntologyRepository`.

## Outputs (writes)

`persistCaseStudy` fans the payload across eight tables in one transaction:

| Table | Content | Idempotency |
| --- | --- | --- |
| `projects` | tagline, pitch, name, product_description (write-once), case_study_status/model/input_hash, computed archetype + stage | sticky-gated by `user_overrides` |
| `project_stack_items` | category, name, justification, component link | insert-if-absent on `(project_id, content_hash)`, prune superseded |
| `project_decisions` | title, context, decision, consequences, confidence | same, and user-confirmed rows are never pruned |
| `project_highlights` | title, description | same |
| `project_challenges` | problem, solution | same |
| `project_depth_markers` | the deterministic depth markers | upsert on project_id |
| `project_architecture` | Mermaid diagram (normalised via `mermaid-normalise.ts`) + nodes/edges | upsert, skipped when user-edited |
| `project_resume_bullets` | per-angle bullet sets | upsert on `(project_id, angle)` |

User-authored rows (NULL content_hash) always survive regeneration.

## Payload

`CaseStudySchema` (`case-study-types.ts`), all `.strict()`:

- `displayName`, `productStatement` (write-once, README-derived), `tagline`, `pitch`
- `stack` (max 40) - category one of `language, framework, database,
  infrastructure, observability, ci_cd, external_service`
- `decisions` (max 5), `highlights` (max 5), `challenges` (max 5)
- `architecture` - `{ diagramFormat: mermaid|svg, diagramSource, nodes, edges }`
- `depthMarkers` - test coverage (`none|light|moderate|strong`), CI maturity
  (`none|basic|deploys_to_prod|multi_env`), doc density
  (`none|readme_only|docs_dir|comprehensive`), deployment evidence, refactor count
- `resumeBullets` - one set per angle, angle one of `backend, frontend,
  infrastructure, fullstack, data_ml, product_leadership`

Every stack/decision/highlight/challenge row carries `sourceSignals`:
commits, PRs, files cited, `ungroundedClaims`, and a `grounding` verdict
(`GROUNDED | NOT_GROUNDED | NOT_VERIFIED`). `verifiedTech` on stack items is
stamped server-side from `technology_evidence`; the model never fills it.

## Refine mode (on by default)

When a completed case study exists, `reconstructPriorCaseStudy` reloads it
with stored source signals, `underrepresentedRepos` finds repos the prior
never cited, and `scopeEvidenceToRepos` narrows the evidence to the new
repos. The agent then refines the prior instead of regenerating from
scratch. Refine runs bypass the cache. Opt out with
`CASE_STUDY_DISABLE_REFINE=true`.

## Files

| File | Role |
| --- | --- |
| `case-study-types.ts` | All Zod schemas + enums for the payload and the `CaseStudyContext` the agent receives. Migrations 030/031 are the source of truth for the enums. |
| `case-study-loader.ts` | Builds the `CaseStudyContext` from RDS (no GitHub network I/O). Also computes archetype/stage calibration. |
| `case-study-context-budget.ts` | `packContext`: bounds the context to ~120k estimated tokens (PRs first, then KB chunks, then commits). |
| `case-study-agent.ts` | The Bedrock agent: prompt, forced tool `emit_case_study`, prompt-version hash (busts the cache on prompt edits), schema repair + one bounded retry on Zod failure. |
| `case-study-schema-repair.ts` | Deterministic salvage before the retry: clamp oversized fields, coerce a bare-string architecture into the object shape. Never calls the model. |
| `case-study-orchestrator.ts` | `runCaseStudyOrchestration`: load, cache, agent, grounding, depth-marker override, persist, optional article-topic discovery. |
| `case-study-persistence.ts` | The transactional eight-table fan-out with sticky edits and content-hash idempotency. |
| `case-study-refine.ts` | Prior-case-study reconstruction + evidence scoping for refine runs. |
| `case-study-depth.ts` | Deterministic depth markers, evidence mix, and difficulty signals from lane counts + archetype signals. |
| `case-study-verified-stack.ts` | SBOM grounding: `buildVerifiedStackMap` + `stampStackSignals` mark stack items GROUNDED (with version/purl/file:line) or NOT_GROUNDED. |
| `source-signals.ts` | `computeContentHash` (the per-row dedup key) and source-signal helpers. |
| `mermaid-normalise.ts` | Makes LLM-emitted Mermaid parseable (escape sequences, nested quotes, punctuation labels). Duplicated render-side in the tucaken repo; keep the two identical. |
| `article-topic-discovery.ts` | Optional byproduct: turns challenges + decisions into article topic candidates per repo. |
| `case-study-product-grader.ts` | Eval-only graders: tagline/pitch lead with the product, not the infra. |
| `case-study-narrative-grader.ts` | Eval-only graders: work leads the narrative, tech is not the spine, confident voice; plus an opt-in LLM overview judge (`emit_overview_score`). |
| `case-study-refine-grader.ts` | Eval-only graders for refine runs: new-repo coverage, no duplicates, caps, prior continuity. |
| `__tests__/` | Unit tests plus `.eval.test.ts` prompt-contract evals. |

Graders never gate persistence; they run in CI and the live eval harness.

## Entrypoint

`applications/job-strategist/src/run-case-study.ts` (one-shot K8s Job,
dispatched by the admin API one project at a time). Required env:
`CASE_STUDY_PIPELINE_RUN_ID`, `PROJECT_ID`, `USER_ID`, `PG_*`. Status flow:
`queued → fetching_context → generating → grounding → persisting →
complete/failed`. The system tour runs inline afterwards (see
`../system-tour`).
