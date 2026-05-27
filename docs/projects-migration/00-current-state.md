# Phase 0 — Current State Discovery

**Status:** Read-only inventory. Do not begin Phase 1 until the user has reviewed this document.

**Repo scope:** This audit covers the `ai-applications` monorepo (backend, infra, RDS bootstrap, ingestion). The frontend lives in a **separate repository** `tucaken-app`, sampled here read-only for design-token references.

---

## TL;DR — What the migration doc got wrong

The migration spec (`migration-projects-to-multi-repo.md`) makes six concrete assumptions. Five are wrong; one needs nuance.

| Doc claim | Actual | Source |
|---|---|---|
| `uuidv7` primary keys | `gen_random_uuid()` → **UUIDv4** everywhere | `applications/platform-rds-bootstrap/src/index.ts:40-77` |
| Embedding `vector(1536)` | **`vector(1024)`** (Titan Embed v2) | `applications/shared/src/rds/types.ts:58`, multiple migrations |
| Prisma/Drizzle/Alembic | **Raw numbered SQL** + node `pg` runner in K8s Job | `applications/platform-rds-bootstrap/src/index.ts:283-320` |
| Step Functions or Celery/BullMQ for onboarding | **K8s Jobs + `pipeline_runs` RDS state machine** | `applications/job-strategist/src/run-pipeline.ts:1-`, `pipeline-runs.ts:16` |
| AI middleware "schema format TBD" | **Zod** schemas + Bedrock tool-use blocks | `applications/job-strategist/src/schemas/resume-data.schema.ts:83-92` |
| "Verify `/u/[username]/p/[slug]` does not collide" | **No collision** — no such route pattern exists in `tucaken-app` | `tucaken-app/src/routeTree.gen.ts` |

**Net effect on Phase 1 schema:** every `id uuidv7` becomes `id UUID DEFAULT gen_random_uuid()`, every `vector(1536)` becomes `vector(1024)`, and the migration file becomes `applications/platform-rds-bootstrap/migrations/02X_projects.sql`.

---

## 1. Database

### 1.1 Schema source-of-truth

- **Tool:** Raw PostgreSQL DDL, numbered `.sql` files, applied by a TypeScript `pg` runner running as a Kubernetes Job on every deploy.
- **Base DDL (embedded in TS):** `applications/platform-rds-bootstrap/src/index.ts:34-281`
- **Numbered migrations:** `applications/platform-rds-bootstrap/migrations/` — 29 files at time of audit, latest in use is `025_user_profile_mirror_reveal.sql`.
- **Runner:** loads numbered files in lexical order, single transaction per file, all files inside one Pod transaction (`applications/platform-rds-bootstrap/src/index.ts:283-293`).
- **All migrations idempotent** (`IF NOT EXISTS` / `IF EXISTS` guards throughout). **No down-migration convention exists today** — see §6 Open Decisions.

### 1.2 Existing tables in the Projects neighbourhood

#### `users` — `applications/platform-rds-bootstrap/src/index.ts:40-48`
- PK: `UUID DEFAULT gen_random_uuid()` (v4)
- Columns: `email`, `full_name`, `avatar_url`, `plan`, timestamps

#### `repositories` — `applications/platform-rds-bootstrap/src/index.ts:63-77`
- PK: `UUID DEFAULT gen_random_uuid()`
- FK: `user_id → users(id) ON DELETE CASCADE`
- UNIQUE: `(user_id, provider, full_name)`
- Columns include `index_status`, `indexed_at`, `error_message`, `default_branch` (added later, line 279-280)

#### `repository_profiles` — `applications/platform-rds-bootstrap/migrations/014_repository_profiles.sql:1-111`
- PK: UUID v4
- FKs: `user_id → users`, `repository_id → repositories` (both CASCADE; `repository_id` nullable so embeddings survive repo deletion)
- `classification` enum: `project | fork | tutorial | abandoned | noise | stale`
- `extraction_status` state machine: `pending | extracting | ready_for_review | completed | failed`
- `extracted` JSONB + `user_overrides` JSONB (user edits are sticky)
- `quality_score NUMERIC(3,2)` + `quality_breakdown` JSONB
- **This table already implements ~60% of what the migration doc calls "projects" — except it's still 1 repo = 1 profile.**

#### `repository_profile_embeddings` — `migrations/014_repository_profiles.sql:76-111`
- `embedding vector(1024)`, HNSW index `(m=16, ef_construction=64)`
- `chunk_type` enum: `one_liner | description | highlight`

#### `user_profile_rollup` — `migrations/024_user_profile_rollup.sql:12-28`
- PK: `user_id` (one row per user)
- Aggregate over `repository_profiles` filtered by `classification='project' AND NOT is_hidden AND extraction_status='completed'`
- `methodology_version INTEGER` for re-computation control

#### `user_profile_rollup` — Mirror/Reveal cols (current worktree SP2) — `migrations/025_user_profile_mirror_reveal.sql:7-10`
- `mirror JSONB` (identity paragraph), `reveal JSONB` (structured inferences), `synthesis_refreshed_at TIMESTAMPTZ`

#### `document_embeddings` — `applications/platform-rds-bootstrap/src/index.ts:79-94`
- `embedding vector(1024)` (Titan v2)
- Loose-coupled to repositories via `(user_id, repo_full_name)` TEXT — **NOT** a UUID FK to `repositories.id`. Deliberate: embeddings survive repo re-index. Phase 1 must preserve this.

#### Other domains FK'd to `users` (not to repos):
- `resumes` (`src/index.ts:124-133`), `job_applications` (`resumes.job_application_id`), `user_career_history`, `experience_embeddings`, `resume_imports` (`migrations/010_resume_import_pipeline.sql`)

### 1.3 pgvector

- **Dim: 1024.** Sourced from **`amazon.titan-embed-text-v2:0`** via Bedrock (`applications/shared/src/rds/implementations/TitanEmbeddingProvider.ts:44`).
- **All embedding tables use HNSW** `(m=16, ef_construction=64)` with `vector_cosine_ops`.
- **Cost tracking** integrated: `TitanEmbeddingProvider.ts:89-98` writes to `bedrock_costs` table.

### 1.4 Database backend

- **RDS Postgres** (not Aurora DSQL).
- Extensions installed: `vector`, `uuid-ossp` (`src/index.ts:36-37`).
- RLS enabled on all user-scoped tables (`migrations/003_cognito_user_provisioning.sql`), enforced via `app.current_user_id` session variable.
- App connects via PgBouncer post-bootstrap; bootstrap connects directly.

---

## 2. Backend

### 2.1 Existing project-domain API routes

**None.** No routes under `/api/projects/*` exist. The `api/public-api/` service (Hono on Node) currently exposes:

- `GET  /healthz` (`api/public-api/src/routes/health.ts`)
- `GET  /api/articles`, `/api/articles/:slug`, `/api/tags` (articles.ts, tags.ts)
- `GET  /api/resumes/active` (resumes.ts)
- `POST /api/chatbot/{invoke,public,authenticated}`, `POST /api/chat` (chatbot.ts:155-230)

### 2.2 GitHub integration

- **`GitHubAdapter`** at `applications/shared/src/ingestion/implementations/GitHubAdapter.ts` — REST only (no GraphQL), token via `GITHUB_TOKEN`, 5K req/h.
- **No webhook handler** found.
- Ingestion orchestrator: `applications/shared/src/ingestion/orchestrator/RepoIngestionOrchestrator.ts`.
- Sync state journal: `RdsSyncStateRepository.ts` → `repo_sync_state` table (composite PK on user+repo, includes `kb_quality_*` and `retrieval_*` columns).

### 2.3 KB embedding generation

- **Provider:** `TitanEmbeddingProvider` (Bedrock, model `amazon.titan-embed-text-v2:0`, dim 1024, max 30K chars input).
- **Pipeline:** `applications/shared/src/rds/pipeline/IngestionPipeline.ts:108-` — sequential per-chunk embedding (portfolio scale, <10K chunks/repo).

### 2.4 Onboarding orchestrator

- **Not Step Functions, not Celery, not BullMQ, not FastAPI tasks.**
- **Mechanism:** K8s Jobs dispatched from admin-api; pipeline state persisted to **`pipeline_runs`** RDS table.
- **Entry point:** `applications/job-strategist/src/run-pipeline.ts:1-` — `executeResearchAgent` → `executeStrategistAgent` → `persistTailoredResume`.
- **State machine** (`pipeline-runs.ts:16`): `queued → researching → analysing → persisting → complete`.
- **LinkedIn/Resume import preprocessing:** lives in `applications/resume-import-processor/` (PDF/DOCX parse + Bedrock enrichment).
- **No existing onboarding step beyond resume + KB.** Steps 6–8 from the migration doc (clustering → review → case study) are net-new orchestration to insert.

### 2.5 AI middleware — structured outputs

- **Format: Zod.** Examples:
  - `applications/job-strategist/src/schemas/resume-data.schema.ts:83-92`
  - `applications/resume-import-processor/src/bedrock/enrich-role.ts:178-190`
  - `applications/resume-import-processor/src/bedrock/extract-career.ts:345`
- **Pattern:** Bedrock returns JSON via tool-use blocks, code filters `toolUseBlock` then `.safeParse()` on `.input`.
- **Grounding verifier** in use for chatbot: `applications/chatbot/src/index.ts:50` (`BedrockGroundingVerifier`, `mode: 'block'`).

### 2.6 Async / job-status pattern

- **RDS-backed state**, no external queue for in-process pipelines:
  - Status: `UPDATE pipeline_runs SET status = $2 WHERE id = $1` (`pipeline-runs.ts:18-28`)
  - Metadata: `UPDATE ... SET metadata = COALESCE(metadata, '{}') || $2::jsonb` (`pipeline-runs.ts:36-44`)
  - Parallel update: `job_applications.kanban_status` (`pipeline-runs.ts:93-102`)
- **Event-driven path** (used for self-healing): EventBridge → SQS FIFO → Lambda with DLQs (`infra/lib/stacks/self-healing/agent-stack.ts:477-514`). Not used for user onboarding today, but available pattern.

### 2.7 Auth + response envelope

- **Auth:** API key from Secrets Manager via EC2 Instance Profile, 15-min TTL cache (`api/public-api/src/routes/chatbot.ts:37-70`). Sent upstream as `x-api-key`.
- **Envelope:** Hono `c.json(data, status)`. Errors return `{ error: <code>, message: <human> }` shape, e.g. `{ error: 'InternalError', message: '...' }` (chatbot.ts:95-126). Success responses are domain-shaped, **not wrapped**.

---

## 3. Frontend (cross-repo: `tucaken-app`)

> The Projects UI does not live in `ai-applications`. Phase 5 work will be a PR against `tucaken-app`.

### 3.1 Existing Projects component
- `tucaken-app/src/app/_dashboard.projects.tsx:1-43` — **placeholder only.** Route `/_dashboard/projects`, rendered inside `DashboardPage` wrapper, copy reads "Projects coming soon."
- Route registered in `tucaken-app/src/routeTree.gen.ts:26,114-118`.

### 3.2 Tailwind + design tokens
- **Tailwind v4** with `@tailwindcss/vite`. Tokens defined in `@theme` block: `tucaken-app/src/styles.css` (font stack, `--text-xs` … `--text-5xl`).
- **Palette in use:** accent `teal-{400,500,600}` + `emerald-{400,600}`; neutral `zinc-{50,100,200,400,500,600,700,800,900}`.
- **Prose mapping:** `tucaken-app/typography.ts:32-70` (full light/dark prose vars).
- **No new colours, fonts, or motion patterns must be introduced** — comply with migration doc §"Constraints & Don'ts".

### 3.3 Dark mode
- `tucaken-app/src/contexts/ThemeContext.tsx:1-115` — context + `localStorage`, applies `.dark` class on `<html>`.
- **Default theme: dark** (`ThemeContext.tsx:11`).
- Anti-flash inline script in `__root.tsx:31-50`.

### 3.4 Motion
- `motion@^12.38.0` (Framer Motion successor).
- **Named patterns to reuse** (do not invent new):
  - `MotionButton` text-swap reveal — `tucaken-app/src/components/ui/MotionButton.tsx:30-129` (spring `{stiffness: 400, damping: 30}`, respects `useReducedMotion`).
  - `MagneticButton` mouse-tracking — `tucaken-app/src/features/home/lib/MagneticButton.tsx:26-48` (spring `{stiffness: 200, damping: 15, mass: 0.4}`).
  - `AuthShell` entrance fade-up — `tucaken-app/src/features/auth/components/AuthShell.tsx:69-78`.
- Global `<MotionConfig reducedMotion="never">` wraps the app (`__root.tsx:135`).

### 3.5 Primitives
- **`@headlessui/react@^2.2.9`** + **`lucide-react`** icons.
- **No Radix, no shadcn/ui, no Tailwind Plus / Tailwind UI license.** ~30 in-house components in `tucaken-app/src/components/ui/`.
- Phase 5 must build new project components from these primitives + in-house UI library. Do **not** introduce Radix/shadcn for this feature.

### 3.6 TypeScript conventions
- Path alias: `@/* → ./src/*` (`tucaken-app/tsconfig.json:16`, `vite.config.ts:67`).
- Strict mode + `noUnusedLocals/Parameters` enforced.
- Feature-folder layout: `src/features/<feature>/{components,lib,hooks}`. Projects UI should follow this pattern → `src/features/projects/...`.

### 3.7 Route collision check
- **No route matches `/u/[username]/p/[slug]` or any `/u/*` or `/p/*` pattern.** Public routes are `/`, `/sign-in*`, `/pricing`, `/checkout/*`, `/onboarding`, `/login`, `/github/callback`, `/articles.preview.$slug`. The doc's proposed share URL is safe to claim.

---

## 4. Onboarding flow today

Mapped from `applications/job-strategist/src/run-pipeline.ts`, `applications/resume-import-processor/`, and dashboard routes in `tucaken-app`:

```
1. Sign-up / Cognito provisioning
2. Resume upload     → resume-import-processor (PDF/DOCX → career_history + experience_embeddings)
3. GitHub connect    → GitHubAdapter listFiles + RepoIngestionOrchestrator
4. KB generation     → IngestionPipeline → document_embeddings (1024-d Titan)
5. repository_profiles extraction (SP0)
6. user_profile_rollup refresh (SP0/SP1)
7. Mirror / Reveal synthesis (SP2 — IN FLIGHT in this worktree)
```

**LinkedIn:** referenced in the migration doc but **not surfaced** as an explicit onboarding step in the current codebase. If it exists, it lives inside `resume-import-processor` enrichment.

**Insertion point for Phase 4:** after step 7 (mirror/reveal), add `8. Project clustering (async)` → `9. Review step (UI)` → `10. Case study generation (async)`.

---

## 5. Existing work that overlaps with the migration spec

The migration doc treats Projects as net-new, but **prior work (SP0–SP2) has already implemented the foundations** under different names. Phase 1 should **extend**, not duplicate:

| Migration-doc target | Existing equivalent | Action |
|---|---|---|
| `projects` table | none — but `repository_profiles` solves single-repo case | **Build new `projects` table above `repositories`**; `repository_profiles` continues as repo-level extraction |
| `project_stack_items.justification` | `repository_profiles.extracted->'tech_stack'` JSONB | Lift to typed table at project scope |
| `project_decisions` (ADR style) | not present | Net-new |
| `project_highlights` | `repository_profile_embeddings.chunk_type='highlight'` rows | Lift highlights to typed table |
| `project_depth_markers` | partial in `repo_sync_state.kb_quality_breakdown` + `repository_profiles.quality_breakdown` | Aggregate at project scope |
| `project_resume_bullets` (per-angle) | resume generation in job-strategist | Reuse `BedrockGroundingVerifier` pipeline |
| `project_architecture` Mermaid | net-new | Net-new |
| `mirror` / `reveal` per-project | exists at **user** scope on `user_profile_rollup` (SP2) | Decide: per-project mirror/reveal too? — see §6 |
| `summary_embedding` on projects | mirrors `repository_profile_embeddings` pattern | Reuse Titan 1024-d + HNSW |

---

## 6. Open decisions (resolve before Phase 1 PR)

1. **uuidv7 vs v4.** Current codebase is uniformly v4. Adopting v7 only for new tables creates inconsistency. **Recommendation:** stay on `gen_random_uuid()` (v4) for Phase 1; treat uuidv7 as a separate cross-cutting RFC.
2. **Embedding dim.** Spec says 1536, codebase says 1024 (Titan v2). **Recommendation:** `vector(1024)` for `projects.summary_embedding`. If higher fidelity is needed, that's a model swap RFC affecting **every** embedding table.
3. **Down-migration convention.** None exists today; all migrations are forward-only idempotent. **Recommendation:** add `migrations/down/02X_projects.down.sql` alongside the new file and run-on-demand via a `bootstrap --rollback` flag — but confirm with user before adding tooling.
4. **Per-project mirror/reveal?** SP2 currently writes `mirror`/`reveal` to `user_profile_rollup` (user-scoped). The migration doc's `tagline` + `pitch` overlap conceptually. **Recommendation:** keep user-scoped mirror/reveal for whole-portfolio identity, and use `projects.tagline`/`projects.pitch` for per-project narrative. They are not the same artifact.
5. **`docs/` is git-ignored.** This file will not be committed where written. **Recommendation:** relocate to `applications/platform-rds-bootstrap/docs/projects-migration/00-current-state.md` (or another non-ignored location) before commit, OR move from `docs/` to `kb/` (Tucaken KB convention per `kb-doc` skill).
6. **Cross-repo PR coordination.** Phase 5 work lands in `tucaken-app`, not `ai-applications`. **Recommendation:** treat each phase as a per-repo PR; Phase 1–4 in `ai-applications`, Phase 5 in `tucaken-app`. Wire via the public API contract defined in Phase 3.
7. **Job orchestration choice for clustering + case-study gen.** Options: extend existing `pipeline_runs` K8s-Job pattern (sync within K8s, status in RDS) **or** adopt the EventBridge→SQS FIFO→Lambda pattern from self-healing. **Recommendation:** extend `pipeline_runs` — it's the established convention, already integrates RLS, cost tracking, and grounding.
8. **`source_signals` schema.** Spec says JSONB with commit SHAs, PRs, file paths. **Recommendation:** typed Zod schema mirroring `BedrockGroundingVerifier` claim format, validated on write. Reuse what grounding already produces; do not invent a parallel evidence model.
9. **Redis caching scope.** Redis is available at EKS infra level. The application-layer keys + invalidation strategy for AI-gen cache (project_id + content_version) and GitHub API cache are **not yet implemented**. **Recommendation:** scope these into Phase 2/3 implementation PRs, not infra.

---

## 7. Recommended Phase 1 scope (after user reviews this doc)

A single migration `applications/platform-rds-bootstrap/migrations/026_projects.sql`:

- All ten new tables from spec §"Phase 1: Data Model", with corrected types: UUID v4 PKs, `vector(1024)` for embeddings, `gen_random_uuid()` defaults.
- Backfill: for every `repositories` row, create one `projects` row (`shape='single_repo'`, `is_ai_suggested=false`, `is_user_confirmed=false`) + one `project_components` row + one `project_repositories` link.
- Slug generation collision-safe per user (lower(full_name) with `-N` suffix on collision).
- Idempotent (`IF NOT EXISTS` throughout) to match house convention.
- HNSW index on `projects.summary_embedding` matching existing `(m=16, ef_construction=64, vector_cosine_ops)`.
- RLS policies on all new tables, scoped via `app.current_user_id` (per `migrations/003`).
- **Down-migration only if decision §6.3 lands as "yes."**
- E2E test (TypeScript + `pg`, follows `applications/platform-rds-bootstrap` test style): seed user with N repos → run migration → assert N projects, N components, N project_repositories rows, unique slugs per user, RLS denies cross-user access.

---

## 8. Phase ordering proposal

Unchanged from migration doc, with these adjustments:

1. **Phase 1** — schema + backfill + E2E. PR in `ai-applications`.
2. **Phase 2** — clustering + case-study + architecture services. Extend `pipeline_runs`, reuse `BedrockGroundingVerifier`, Zod schemas. Feature-flag gated.
3. **Phase 3** — Hono routes under `api/public-api/src/routes/projects.ts`. Follow existing error envelope. Old endpoints to keep alive: **none exist** to deprecate.
4. **Phase 4** — Onboarding step insertion in `run-pipeline.ts`; add clustering after rollup + mirror/reveal.
5. **Phase 5** — `tucaken-app` PR. New feature folder `src/features/projects/`. Reuse `MotionButton`, `MagneticButton`, headless-ui primitives, Mermaid via `mermaid.js`.
6. **Phase 6** — Categorization filters + public share URL `/u/[username]/p/[slug]` (no collision).
7. **Cleanup** — feature-flag removal; no deprecated code to delete since current Projects UI is a placeholder.
