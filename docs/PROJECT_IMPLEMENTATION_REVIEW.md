# Project Implementation Review — for building the Project UI

> **Generated:** 2026-05-30
> **Scope:** The portfolio-domain **Project** feature (`projects` and its child tables) — how it differs from a `repository`, what problem it solves, how a single project integrates **two or more** repositories, and the exact data contract the UI consumes.
> **Evidence base:** repo code (branch `fix/lambda-xray-native-tracing`, all project commits merged to `develop`), migrations `030`–`033`, the clustering / case-study services in `applications/shared/src/projects/`, the public-API route, and a **live query of dev RDS** (`tucaken` DB, PG 18.2, `dev-account` profile, via pgbouncer tunnel).

---

## 0. TL;DR — read this first

1. **`repository` ≠ `project`.** A *repository* is one raw git repo. A *project* is the **interview / case-study unit** that sits **above** repositories and can span several of them. The bridge is `project → project_components → project_repositories → repositories` (many-to-many).
2. **Two repos in one project** are modelled as **two `project_components`** (e.g. `frontend`, `backend`), each linked to its repository through a `project_repositories` row. A repo can also contribute a **subpath** (monorepo subset), so the link carries a `subpath` column.
3. **The feature is code-complete and merged to `develop`** — schema (030-033), the Phase 2A *Clustering Service*, the Phase 2B *Case-Study Generation Service*, and the Phase 3 public share route all exist.
4. **✅ The `projects` tables ARE deployed to dev RDS** (fixed 2026-05-30). All 41 migrations (`003`–`043`) now apply cleanly end-to-end; the `031` backfill created one `single_repo` project (`nelson-lamounier-cdk-monitoring`). The fix required making early migrations idempotent — see §7 for the (two-layered) root cause and the permanent fix.
5. **The UI contract you build against is the JSON returned by `GET /public/projects/:username/:slug`** — fully denormalised, JSON-stable, designed to be rendered as-is. Exact shape in §6.
6. **Authenticated (owner) project CRUD ALREADY EXISTS** — in `tucaken-app/admin-api` (a separate Cognito-JWT + RLS Hono service), **not** in `ai-applications/api/public-api`. Full CRUD + confirm/merge/split/regenerate, already wired to frontend server functions and React Query hooks. **Do not rebuild it** — see §8.

---

## 1. The conceptual model: repository vs repository_profile vs project

Three distinct layers, bottom-up:

| Layer | Table | Grain | What it is |
|-------|-------|-------|------------|
| **Raw repo** | `repositories` | 1 per `(user, provider, full_name)` | The git repo as ingested. Name, language, topics, index status. No narrative. |
| **Per-repo AI profile** | `repository_profiles` | 1 per `(user_id, repo_full_name)` | AI extraction *of a single repo*: `classification` (`project`/`fork`/`tutorial`/`abandoned`/`noise`/`stale`), `quality_score`, `extracted` JSONB (incl. `tech_stack`), feature/hidden flags. This is the **old, single-repo portfolio model.** |
| **Project (interview unit)** | `projects` + 10 child tables | 1 per real-world project (may span repos) | The **case study**: pitch, tagline, decisions, challenges, highlights, stack with justifications, depth markers, architecture diagram, resume bullets. |

> **Important naming trap:** `repository_profiles.classification` can equal the string `'project'`. That is *not* the `projects` table — it just means "this repo looks like real project work, not a fork/tutorial". Don't conflate them in the UI.

> **Second trap (infra):** `infra/lib/config/projects.ts`, `infra/lib/factories/project-registry.ts` etc. are **CDK infrastructure "projects"** (stack groupings). Completely unrelated to the portfolio domain. Ignore them for this UI.

### What problem does `projects` solve?

The `repository_profiles` model is **one-repo-one-card**. Real engineering work doesn't map cleanly to repos:

- A product is often split across `myapp-web` + `myapp-api` + `myapp-infra` (multi-repo).
- Or it lives inside a monorepo subdirectory (`apps/web` inside one repo).
- Recruiters / interviewers care about the **project narrative** (what problem, what decisions, what challenges, what stack and *why*) — not a flat list of repos.

`projects` introduces the **unit a candidate describes in an interview** and attaches AI-generated, evidence-grounded, user-editable case-study content to it. It is the storytelling layer over the raw repos.

---

## 2. Data model (schema source of truth)

Defined in `applications/platform-rds-bootstrap/migrations/030_projects.sql` (schema), `031` (backfill), `032` (proposal state), `033` (case-study run-state). Base tables (`repositories`, `users`, `pipeline_runs`) live in `applications/platform-rds-bootstrap/src/bootstrap.ts`.

### Core entity — `projects`

```
projects
  id                 UUID PK
  user_id            UUID  → users(id)
  slug               TEXT  (UNIQUE per user_id)
  name               TEXT
  tagline            TEXT          -- AI-written (case study)
  pitch              TEXT          -- AI-written (case study)
  type               side_project | open_source | production_saas | client_work | internal_tool | learning_project
  shape              single_repo | multi_repo | monorepo_subset      ← KEY for the UI
  status             active | stable | dormant | archived
  role_exhibited     sole_builder | lead | contributor | maintainer
  visibility         private | unlisted | public                     ← gates the public route
  started_at / ended_at / last_activity_at  TIMESTAMPTZ
  is_ai_suggested    BOOL    -- TRUE = a clustering proposal
  is_user_confirmed  BOOL    -- FALSE + is_ai_suggested = awaiting user review
  summary_embedding  vector(1024)
  -- 032 (proposal provenance):
  proposal_pipeline_run_id  UUID → pipeline_runs(id)
  proposal_reasoning        TEXT   -- why the AI grouped these repos
  proposal_confidence       high | medium | low
  -- 033 (case-study lifecycle):
  case_study_status         pending | generating | complete | failed
  case_study_generated_at / case_study_pipeline_run_id / case_study_model / case_study_input_hash
  user_overrides            JSONB  -- stickiness: which sections the user hand-edited
```

### The repo-linking spine (this is how N repos join one project)

```
project_components                         project_repositories
  id        UUID PK                          id                    UUID PK
  project_id → projects(id)                  project_component_id  → project_components(id)
  name      TEXT                             repository_id         → repositories(id)
  kind      frontend|backend|infra|          subpath               TEXT ('' = whole repo;
            mobile|data|ml|docs|shared                              'apps/web' = monorepo subset)
  order_index INT                            UNIQUE(component_id, repository_id, subpath)
```

A **component** is a logical section of the project (frontend, backend, infra…). Each component links to one **or more** repositories via `project_repositories`. A repository can appear under multiple components/projects without ambiguity because the link is keyed by `(component, repository, subpath)`.

### Case-study child tables (all `project_id`-scoped, all RLS-protected)

| Table | Grain | Holds |
|-------|-------|-------|
| `project_tags` | PK `(project_id, tag)` | free-form tags |
| `project_stack_items` | many | `category` (language/framework/database/infrastructure/observability/ci_cd/external_service), `name`, `justification`, optional `used_in_component_id`, `source_signals`, `order_index` |
| `project_decisions` | many | ADR-style: `title`/`context`/`decision`/`consequences`, `confidence`, `source_signals`, `is_user_confirmed` |
| `project_highlights` | many | `title`, `description`, `source_signals` |
| `project_challenges` | many | `problem`, `solution`, `source_signals` |
| `project_resume_bullets` | 1 per `(project, angle)` | `angle` (backend/frontend/infrastructure/fullstack/data_ml/product_leadership), `bullets` JSONB[] |
| `project_depth_markers` | 1 per project | `has_tests`, `test_coverage_signal`, `has_ci`, `ci_maturity`, `documentation_density`, `has_deployment_evidence`, `deployment_url`, `refactor_count` |
| `project_architecture` | 1 per project | `diagram_format` (mermaid/svg), `diagram_source`, `nodes` JSONB, `edges` JSONB, `is_user_edited` |

**`source_signals`** (on decisions / challenges / highlights / stack items) is the **evidence trail** — the commits / PRs / files that justify each claim:

```jsonc
{
  "commits": [{ "repoFullName": "...", "sha": "...", "authoredAt": "...", "message": "..." }],
  "pulls":   [{ "repoFullName": "...", "number": 12, "title": "...", "htmlUrl": "...", "mergedAt": "..." }],
  "files":   [{ "repoFullName": "...", "path": "...", "chunkId": "uuid?" }],
  "ungroundedClaims": ["..."],
  "grounding": "GROUNDED" | "NOT_GROUNDED" | "NOT_VERIFIED"
}
```

This lets the UI render "here's the proof" links next to each decision/challenge.

### Row-Level Security

**Every** `project*` table has RLS: `user_id = current_setting('app.current_user_id')::uuid`. Any owner-facing query MUST run `SET LOCAL app.current_user_id = $1` first (see `applications/chatbot-authenticated/src/session.ts:7`). The **public route deliberately bypasses RLS** by filtering `visibility='public'` in the SQL `WHERE` clause instead of setting the session user.

---

## 3. How a project that integrates 2 repositories is represented

Concrete worked example — a project `tucaken` built from `tucaken-web` + `tucaken-api`:

```
projects
  └─ { id: P1, slug: "tucaken", name: "Tucaken", shape: "multi_repo",
       is_ai_suggested: true, proposal_confidence: "high",
       proposal_reasoning: "Shared 'tucaken' name prefix; web calls api; overlapping React/Node stack" }

project_components
  ├─ { id: C1, project_id: P1, name: "Frontend", kind: "frontend", order_index: 0 }
  └─ { id: C2, project_id: P1, name: "Backend",  kind: "backend",  order_index: 1 }

project_repositories
  ├─ { project_component_id: C1, repository_id: R(tucaken-web), subpath: "" }
  └─ { project_component_id: C2, repository_id: R(tucaken-api), subpath: "" }
```

- **Two repos → two components → two link rows.** The `kind` of each component tells the UI how to label/group the repo (Frontend vs Backend).
- A **monorepo subset** project (`shape='monorepo_subset'`) would have one repo linked under multiple components, each with a different `subpath` (e.g. `apps/web`, `apps/api`).
- The write code lives in `applications/shared/src/projects/clustering-persistence.ts` (lines ~112-151): insert `projects` → loop components → loop `repositoryIds` per component → insert `project_repositories` with `ON CONFLICT DO NOTHING`.

**Read path** for the UI (denormalised, in the public route) joins component → repo:

```sql
SELECT pc.id AS component_id, r.full_name AS repository_full_name, pr.subpath
  FROM project_repositories pr
  JOIN project_components pc ON pc.id = pr.project_component_id
  JOIN repositories r       ON r.id  = pr.repository_id
 WHERE pc.project_id = $1 AND r.is_private = FALSE
 ORDER BY pc.order_index, r.full_name;
```

So in the response, `repositories[]` rows carry `component_id`, letting the UI **group repos under their component**.

---

## 4. Lifecycle & pipeline — how projects come into existence

```
                    ┌─────────────────────────────────────────────────────────┐
                    │  Repo ingestion (existing)                                │
                    │  repositories + repository_profiles + embeddings filled   │
                    └───────────────────────────┬─────────────────────────────┘
                                                 │
        ┌────────────────────────────────────────┼───────────────────────────────────┐
        ▼                                          ▼                                    ▼
 ┌───────────────┐                    ┌────────────────────────┐          ┌──────────────────────────┐
 │ Backfill (031)│                    │ Clustering Service 2A  │          │ Case-Study Service 2B    │
 │ 1 single_repo │                    │ proposes multi_repo    │          │ writes the narrative      │
 │ project / repo│                    │ groupings (AI)         │          │ (AI, grounded)            │
 └───────────────┘                    └────────────────────────┘          └──────────────────────────┘
```

### Phase 1 — schema + backfill (`030`, `031`)
Migration `031` creates exactly **one `single_repo` project + one `shared` component + one link** for every existing `repositories` row that isn't already linked. Idempotent (`WHERE NOT EXISTS`). Slug = lower-cased `full_name` with non-alphanumerics collapsed to dashes.

### Phase 2A — Project Clustering Service (multi-repo proposals)
- **Code:** `applications/shared/src/projects/clustering-{agent,signals,loader,orchestrator,persistence}.ts`
- **Entrypoint (K8s Job):** `applications/job-strategist/src/run-clustering.ts`
- **Model:** **Haiku 4.5** (`eu.anthropic.claude-haiku-4-5-20251001-v1:0`, env `CLUSTERING_MODEL`)
- **Signals computed deterministically before the LLM** (`clustering-signals.ts`): (1) shared **naming prefixes**, (2) shared GitHub **topics**, (3) shared **tech stack** (from `repository_profiles.extracted->'tech_stack'`), (4) **embedding-pair cosine similarity** over `repository_profile_embeddings` (threshold **0.78**, capped at 32 pairs). Generic tokens (`typescript`, `react`, ≤2 chars, pure digits) are filtered so they don't dominate.
- **Output:** rows in `projects` with `is_ai_suggested=TRUE`, `is_user_confirmed=FALSE`, `shape='multi_repo'`, `proposal_reasoning`, `proposal_confidence`, `proposal_pipeline_run_id`, plus the components + links. Prior unconfirmed proposals are cleared first; repos already in *confirmed* projects are excluded.
- **Requires ≥2 repos per user** with overlapping signals — otherwise no proposal.

### Phase 2B — Case-Study Generation Service (the narrative)
- **Code:** `applications/shared/src/projects/case-study-{agent,loader,orchestrator,persistence,types}.ts` + `source-signals.ts`
- **Entrypoint (K8s Job):** `applications/job-strategist/src/run-case-study.ts`
- **Model:** **Sonnet 4.6** (`eu.anthropic.claude-sonnet-4-6-20260310-v1:0`, env `CASE_STUDY_MODEL`) — recruiter-facing prose, so the stronger model.
- **Input context** (`case-study-loader.ts`): project + components + repos, ≤50 commits/repo, ≤25 PRs/repo, ≤24 KB chunks from `document_embeddings`.
- **Populates:** `projects.tagline`/`pitch`/`summary_embedding` + `case_study_status='complete'`, and fans out to `project_stack_items`, `project_decisions`, `project_highlights`, `project_challenges`, `project_depth_markers`, `project_architecture`, `project_resume_bullets`.
- **Idempotency:** each child row keyed by `content_hash = SHA256(content + source_signals)`; partial unique index `(project_id, content_hash)`. Re-runs skip identical evidence. `user_overrides` JSONB marks sections the user hand-edited so regeneration **never clobbers manual edits** ("stickiness").
- **Grounding:** `BedrockGroundingVerifier` (mode=`flag`) runs after generation, flagging ungrounded claims into `source_signals.grounding` — it never rewrites content.

### Phase 3 — Public share route ✅ implemented (see §6)

### Phase 4 — Onboarding orchestrator (user-driven trigger)
New repos flow through the same backfill path → default single-repo project. **User confirmation of AI multi-repo proposals** (flip `is_user_confirmed=TRUE`, or dismiss → delete cascade) is the Phase 5 review-UI work — **this is part of what you're building.**

---

## 5. TypeScript contracts (use these to type the UI)

Domain types live in `applications/shared/src/projects/`:

- `types.ts` — clustering: `RepoClusteringDigest`, `ClusteringSignals`, `ClusteringComponent` (`{ name, kind, repositoryIds }`), `ClusteringProposal` (`{ name, confidence, reasoning, components }`), `PROJECT_COMPONENT_KINDS`.
- `case-study-types.ts` — `CaseStudy` (Zod), `CaseStudyContext`, `SourceSignal`, and the enum families:
  - `PROJECT_TYPES`, `PROJECT_STATUS`, `RESUME_BULLET_ANGLES`, `STACK_CATEGORIES`, `TEST_COVERAGE_SIGNALS`, `CI_MATURITY`, `DOC_DENSITY`.
- `index.ts` — barrel exports.

The **public renderer already exists** in the sibling app: `tucaken-app/src/features/projects/components/public/PublicCaseStudy.tsx` (consumes a Zod-validated `PublicCaseStudyData`). Existing (some placeholder) components: `ProjectCard`, `ProjectDetail`, `ProjectFilterBar`, `ProjectEditor`, `ProjectReviewStep`, `ShareCaseStudy`. Dashboard route `tucaken-app/src/app/_dashboard/projects.tsx` is a "coming soon" placeholder.

---

## 6. The UI data contract — public case-study endpoint

**`GET /public/projects/:username/:slug`** — `api/public-api/src/routes/projects.ts:106`
(mounted in `api/public-api/src/index.ts`; DB pool in `api/public-api/src/lib/pg.ts` via pgbouncer; 5-min CDN cache + Redis read-cache keyed by `projectCaseStudyKey(project.id)`.)

- `username` resolves via `oauth_connections.username` (provider=`github`). Route shape mirrors tucaken-app `/u/[username]/p/[slug]`.
- Returns **404** unless `visibility='public'` AND `status <> 'archived'`. Private repos are excluded from the `repositories[]` list (`r.is_private = FALSE`).

**Exact JSON response shape (build your UI types from this):**

```jsonc
{
  "username": "nelson-lamounier",
  "slug": "tucaken",
  "name": "Tucaken",
  "tagline": "string | null",
  "pitch": "string | null",
  "type": "production_saas",
  "shape": "multi_repo",                 // single_repo | multi_repo | monorepo_subset
  "status": "active",
  "roleExhibited": "sole_builder",
  "startedAt": "ISO | null",
  "endedAt": "ISO | null",
  "lastActivityAt": "ISO | null",
  "updatedAt": "ISO",
  "components":   [{ "id": "uuid", "name": "Frontend", "kind": "frontend", "order_index": 0 }],
  "repositories": [{ "component_id": "uuid", "repository_full_name": "owner/repo", "subpath": "" }],
  "decisions":    [{ "title", "context", "decision", "consequences", "confidence", "source_signals", "order_index" }],
  "highlights":   [{ "title", "description", "order_index" }],
  "challenges":   [{ "problem", "solution", "source_signals", "order_index" }],
  "stack":        [{ "category", "name", "justification", "order_index" }],
  "depthMarkers": { "has_tests", "test_coverage_signal", "has_ci", "ci_maturity",
                    "documentation_density", "has_deployment_evidence", "deployment_url", "refactor_count" } /* | null */,
  "architecture": { "diagram_format", "diagram_source", "nodes", "edges" } /* | null */,
  "resumeBullets":[{ "angle", "bullets": ["..."] }],
  "tags":         ["string"]
}
```

**UI grouping tip:** join `repositories[].component_id` → `components[].id` to render repos under their component heading (Frontend / Backend / Infra). For `monorepo_subset`, show `subpath` as a path chip.

---

## 7. Live dev-RDS state — RESOLVED 2026-05-30

**Status:** all 41 migrations (`003`–`043`) now apply cleanly to dev and the schema is fully live — verified by running the complete sequence end-to-end (`ALL_MIGRATIONS_APPLIED_OK`) and spot-checking column markers: `projects.case_study_status` (033), `technology_aliases.prose_safe` (037), `technology_evidence` `code-prose` constraint (038), `pending_subscriptions` (039), `users.cancel_at_period_end` (040), `users.deleted_at` (041), `repo_sync_state.embedded_count`/`phase` (042/043). 11 `project_*` tables present; `031` backfill created one `single_repo` project (`nelson-lamounier-cdk-monitoring`). **You can now read real project rows from dev.**

### Root cause — two layers

1. **Stale pinned image tag (GitOps).** The bootstrap runner is deployed by the `kubernetes-bootstrap` repo: ArgoCD app `platform-rds-eks-development` → Helm chart `charts/platform-rds/chart` → `bootstrap-job.yaml` (`PostSync` hook), running image `…/platform-rds-bootstrap:<tag>`. `<tag>` is bumped **manually** in `values-development.yaml` (ArgoCD Image Updater is not wired to this chart) and was stuck at `c0e075f0…` — the **migration-024-era** image. CI builds + pushes a new image to ECR on every merge to develop and publishes the URI to SSM `/k8s/development/job-images/platform-rds-bootstrap`, but nothing bumped the pinned tag, so the cluster kept re-running an image that physically lacked migrations 025–043.

2. **Non-idempotent early migrations (the real blocker).** The runner has **no `schema_migrations` table — it re-applies every `.sql` on every boot**, relying on `IF NOT EXISTS` guards. But migrations `010`/`011`/`014`/`015` used bare `CREATE TABLE` / `CREATE INDEX` / `CREATE TRIGGER` / `CREATE POLICY`, and `038` a bare `DROP CONSTRAINT`. Once those objects existed, migration **010 threw `42P07` (`relation "resume_imports" already exists`) and aborted the whole run before 011–043 executed.** This is why even pinning the correct image (`3849333…`, which bundles all 41 migrations) failed at the same spot — confirmed by running it in-cluster (Job + debug Pod: `Bootstrap failed: relation "resume_imports" already exists` at 010).

### The fix (permanent + applied)

1. **Idempotency (the durable fix, in this repo):** made `010`/`011`/`014`/`015` use `CREATE TABLE/INDEX IF NOT EXISTS`, named the anonymous `chat_*` indexes, added `DROP TRIGGER/POLICY IF EXISTS` before each trigger/policy, and `DROP CONSTRAINT IF EXISTS` in `038`. The full sequence now runs clean end-to-end (proven against dev). **This is what makes future bootstraps work** — the next CI image off develop will apply everything.
2. **GitOps tag bump:** `bootstrap.image.tag` in `kubernetes-bootstrap/.../values-development.yaml` raised `c0e075f0…` → `3849333…`. *(In that repo's working tree — commit + push it so ArgoCD runs the right image; note it must be re-built off develop **after** the idempotency fix merges, or it will still die at 010.)*
3. **Applied to dev now:** ran the full idempotent sequence through the pgbouncer tunnel, which no-op'd existing objects and applied the two genuinely-missing column migrations (037, 040). Schema verified live.
4. **Repeatability (this repo):** `applications/platform-rds-bootstrap/k8s/bootstrap-job.yaml` (on-demand Job), `just db-bootstrap-run`, and `applications/platform-rds-bootstrap/README.md` documenting the canonical tag-bump procedure + break-glass path.

> ⚠️ **Sequence to land this properly:** merge the idempotency fixes to develop → CI builds a new image → bump the dev tag to that new image → ArgoCD PostSync applies it. Bumping the tag to `3849333…` *without* the idempotency fix merged will still fail at 010.

**Still to do for narrative data:** the backfill only creates the skeleton single-repo project. Populating case-study content needs the clustering + case-study Jobs (`job-strategist`); multi_repo clustering needs ≥2 ingested repos for one user.

**What live data exists right now:**

| Table | Rows | Notes |
|-------|-----:|-------|
| `users` | 4 | `lamounierleao@gmail.com`, `lamleao@icloud.com`, `smoke-e2e@tucaken.dev`, `lamounier_88@hotmail.com` |
| `oauth_connections` | 1 | only 1 GitHub identity → only 1 user can have a *public* URL |
| `repositories` | **1** | `Nelson-Lamounier/cdk-monitoring` (user `1d4c645a…`), `index_status=complete`, indexed 2026-05-29 |
| `repository_profiles` | 2 | `cdk-monitoring` (quality **1.00**), `sindresorhus/is` (quality 0.55) — both `classification=project`, `completed` |
| `repository_profile_embeddings` | 45 | |
| `document_embeddings` | 2846 | all from cdk-monitoring (327 files) |
| `repo_sync_state` | 1 | cdk-monitoring: kb_quality 0.80, retrieval 0.92, phase `finalizing` |
| `pipeline_runs` | 0 | no clustering/case-study run has executed |

**Consequence for multi-repo:** the only fully-ingested user has **1 repository**. Clustering needs ≥2 repos with overlapping signals, so **no `multi_repo` project can be proposed in dev as-is**. To exercise the multi-repo UI you'll need to ingest ≥2 related repos for one user (or seed `projects`/`project_components`/`project_repositories` rows manually after the schema is bootstrapped).

**Schema note for the public route:** `oauth_connections` uses column **`username`** (not `provider_username`). The route joins on `oc.username = :username`.

---

## 8. What this means for the Project UI you're building

1. **Owner-facing CRUD ALREADY EXISTS — do not rebuild it.** It lives in `tucaken-app/admin-api` (a separate Hono BFF, k8s ns `admin-api`, port 3002), **not** in `ai-applications/api/public-api` (which is public/read-only by design). Auth = Cognito JWT (Bearer); RLS binding = `withUser(pool, userId, fn)` in `tucaken-app/admin-api/src/lib/pg.ts` (`SET LOCAL ROLE tucaken_app` + `SET LOCAL app.current_user_id`). Routes at `/api/admin/projects` (`tucaken-app/admin-api/src/routes/projects.ts`; data-access `tucaken-app/admin-api/src/lib/repositories/projects.ts`): list / create / get / patch / delete, plus `/:id/confirm`, `/:id/regenerate`, `/:id/decisions[/:did]`, `/:id/architecture`, `/merge`, `/:id/split`, `/clustering/run`, `/clustering/proposals`. Frontend already wired: server functions `tucaken-app/src/server/projects.ts`, React Query hooks `tucaken-app/src/features/projects/server/`, owner DTOs `tucaken-app/src/features/projects/lib/types.ts`. So the UI work is dashboard views on existing hooks (replacing the `tucaken-app/src/app/_dashboard/projects.tsx` placeholder) — no new backend. (The first draft's "no backend" claim was wrong: that pass only explored the `ai-applications` repo, missing `tucaken-app/admin-api`.)
2. **Build the public viewer against the §6 JSON** — it's stable and SSR-friendly, and a renderer (`PublicCaseStudy.tsx`) already exists to mirror.
3. **Model `shape` explicitly in the UI:** `single_repo` (one repo, minimal chrome), `multi_repo` (group repos by component), `monorepo_subset` (show subpaths).
4. **Proposal-review flow** is real product surface: list `is_ai_suggested=TRUE AND is_user_confirmed=FALSE` projects, show `proposal_reasoning` + `proposal_confidence`, confirm/dismiss.
5. **Surface evidence:** render `source_signals` (commits/PRs/files + `grounding` status) as proof links on decisions/challenges/highlights/stack. This is the trust differentiator.
6. **Case-study lifecycle states** (`case_study_status`: pending/generating/complete/failed) need loading/empty/error UI — a freshly-clustered project has no narrative until 2B runs.
7. **Render `project_architecture`** as a Mermaid diagram (`diagram_format='mermaid'`, `diagram_source`); `is_user_edited` guards regeneration.
8. **Before any of this shows live data**, the rds-bootstrap + job-strategist Jobs must run against dev (§7).

---

## 9. File & evidence index

**Schema / migrations**
- `applications/platform-rds-bootstrap/migrations/030_projects.sql` — projects + 10 child tables, RLS, indexes
- `…/031_projects_backfill.sql` — default single-repo project per repo
- `…/032_projects_proposal_state.sql` — AI-proposal provenance columns
- `…/033_projects_case_study_status.sql` — case-study lifecycle + content-hash idempotency
- `…/014_repository_profiles.sql` — the older per-repo profile model
- `applications/platform-rds-bootstrap/src/bootstrap.ts` — base `users` (~30), `repositories` (~53), `pipeline_runs` (~169)
- `applications/platform-rds-bootstrap/docs/projects-migration/00-current-state.md` — design docs

**Services (Phase 2)**
- Clustering: `applications/shared/src/projects/clustering-{agent,signals,loader,orchestrator,persistence}.ts`; job `applications/job-strategist/src/run-clustering.ts`
- Case study: `applications/shared/src/projects/case-study-{agent,loader,orchestrator,persistence,types}.ts`, `source-signals.ts`; job `applications/job-strategist/src/run-case-study.ts`
- Types: `applications/shared/src/projects/{types,case-study-types,index}.ts`

**Serving / UI**
- Public route: `api/public-api/src/routes/projects.ts` (registered in `…/src/index.ts`)
- DB pool: `api/public-api/src/lib/pg.ts`; config `…/lib/config.ts`; cache `…/lib/cache.ts`
- RLS session setter example: `applications/chatbot-authenticated/src/session.ts:7`
- Existing frontend: `tucaken-app/src/features/projects/components/public/PublicCaseStudy.tsx`, `…/components/{ProjectCard,ProjectDetail,ProjectFilterBar,ProjectEditor,ProjectReviewStep,ShareCaseStudy}.tsx`, dashboard `tucaken-app/src/app/_dashboard/projects.tsx`

**Test scripts**
- `scripts/test-projects-clustering.ts`, `scripts/test-projects-case-study.ts`, `scripts/test-projects-migration.ts`

**Git (all merged to `develop`)**
- `f9ef2ce` feat(rds-bootstrap): add projects multi-repo schema (030)
- `98bc808` feat(public-api): GET /public/projects/:username/:slug (Phase 3a)
- `8a5b534` feat(public-api): cache project case-study assembly by id
- Branches: `feat/projects-migration-phase-1`, `feat/projects-clustering-phase-2a`, `feat/projects-case-study-phase-2b`, `feat/projects-public-share-route`
