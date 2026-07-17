# Phase 0 — Current State Discovery

**Status:** Read-only inventory produced during the Projects → Multi-Repo
Case-Study migration. Sits alongside the migrations it informs. Decisions
recorded in §6 are locked-in defaults for Phase 1 (per user review on
2026-05-21); revisit only by amending this doc.

**Repo scope:** This audit covers the `ai-applications` monorepo (backend,
infra, RDS bootstrap, ingestion). The frontend lives in a **separate
repository** `tucaken-app`, sampled here read-only for design-token
references.

---

## TL;DR — What the migration spec got wrong

The migration spec (`migration-projects-to-multi-repo.md`) makes six
concrete assumptions. Five are wrong; one needs nuance.

| Spec claim | Actual | Source |
|---|---|---|
| `uuidv7` primary keys | `gen_random_uuid()` → **UUIDv4** everywhere | `applications/platform-rds-bootstrap/src/index.ts:40-77` |
| Embedding `vector(1536)` | **`vector(1024)`** (Titan Embed v2) | `applications/shared/src/rds/types.ts:58`, multiple migrations |
| Prisma/Drizzle/Alembic | **Raw numbered SQL** + node `pg` runner in K8s Job | `applications/platform-rds-bootstrap/src/index.ts:283-320` |
| Step Functions or Celery/BullMQ for onboarding | **K8s Jobs + `pipeline_runs` RDS state machine** | `applications/job-strategist/src/run-pipeline.ts:1-`, `pipeline-runs.ts:16` |
| AI middleware "schema format TBD" | **Zod** schemas + Bedrock tool-use blocks | `applications/job-strategist/src/schemas/resume-data.schema.ts:83-92` |
| "Verify `/u/[username]/p/[slug]` does not collide" | **No collision** — no such route pattern exists in `tucaken-app` | `tucaken-app/src/routeTree.gen.ts` |

**Net effect on Phase 1 schema:** every `id uuidv7` becomes
`id UUID DEFAULT gen_random_uuid()`, every `vector(1536)` becomes
`vector(1024)`, and the migration file becomes
`applications/platform-rds-bootstrap/migrations/030_projects.sql`
(029 is the latest occupied number on `develop`).

---

## 1. Database

### 1.1 Schema source-of-truth

- **Tool:** Raw PostgreSQL DDL, numbered `.sql` files, applied by a
  TypeScript `pg` runner running as a Kubernetes Job on every deploy.
- **Base DDL (embedded in TS):**
  `applications/platform-rds-bootstrap/src/index.ts:34-281`
- **Numbered migrations:**
  `applications/platform-rds-bootstrap/migrations/` — 029 is the latest
  occupied number at time of audit.
- **Runner:** loads numbered files in lexical order
  (`applications/platform-rds-bootstrap/src/index.ts:283-293`). **No
  `schema_migrations` tracking table** in the runner today despite the
  rollback runbook implying one — every migration is re-applied every
  bootstrap. Therefore **`IF NOT EXISTS` / `IF EXISTS` / `DROP POLICY IF
  EXISTS` guards are mandatory on every statement**.

### 1.2 Existing tables in the Projects neighbourhood

| Table | Where | Notes |
|---|---|---|
| `users` | `src/index.ts:40-48` | UUID v4 PK |
| `repositories` | `src/index.ts:63-77` | UUID v4 PK, FK → users CASCADE, UNIQUE `(user_id, provider, full_name)` |
| `repository_profiles` | `migrations/014_repository_profiles.sql:1-111` | Already implements ~60% of per-repo extraction. `classification` enum, `extraction_status` state machine, `extracted`/`user_overrides` JSONB. |
| `repository_profile_embeddings` | `migrations/014_repository_profiles.sql:76-111` | `vector(1024)` Titan v2, HNSW `(m=16, ef_construction=64)`, `chunk_type ∈ {one_liner, description, highlight}` |
| `user_profile_rollup` | `migrations/024_user_profile_rollup.sql:12-28` | One row per user. Aggregate over `repository_profiles`. |
| `user_profile_rollup.mirror / reveal` | `migrations/025_user_profile_mirror_reveal.sql` | SP2 work (in flight). User-scoped identity narrative — distinct from per-project `tagline`/`pitch`. |
| `document_embeddings` | `src/index.ts:79-94` | `vector(1024)`. **Loose-coupled to repos via `(user_id, repo_full_name)` TEXT — NOT a UUID FK.** Deliberate: embeddings survive repo re-index. Phase 1 must preserve this. |

### 1.3 pgvector

- **Dim: 1024.** Sourced from **`amazon.titan-embed-text-v2:0`** via
  Bedrock
  (`applications/shared/src/rds/implementations/TitanEmbeddingProvider.ts:44`).
- **All embedding tables use HNSW** `(m=16, ef_construction=64)` with
  `vector_cosine_ops`.
- **Cost tracking:** `TitanEmbeddingProvider.ts:89-98` writes to
  `bedrock_costs`.

### 1.4 Database backend

- **RDS Postgres** (not Aurora DSQL).
- Extensions: `vector`, `uuid-ossp` (`src/index.ts:36-37`).
- RLS enabled on all user-scoped tables
  (`migrations/003_cognito_user_provisioning.sql`), enforced via
  `app.current_user_id` session variable.
- App connects via PgBouncer post-bootstrap; bootstrap connects directly.
- Application role for GRANTs: **`tucaken_app`** (see existing GRANT
  patterns in migration 014).

### 1.5 Expand/contract discipline

Per `applications/platform-rds-bootstrap/ROLLBACK.md`:

- **App rollback is instant; schema rollback is not.** Argo Rollouts
  blue/green keeps the previous ReplicaSet warm; the database has no
  equivalent.
- **Schema must remain backward-compatible with the running app at all
  times.** Phase 1 is purely additive (new tables only) so this constraint
  is satisfied trivially; no contract step needed.
- One concern per numbered file. Phase 1 splits into
  **030 (schema + indexes + RLS)** and
  **031 (backfill of single-repo default projects)** so the schema and
  data migrations remain independently revertible.

---

## 2. Backend

### 2.1 Existing project-domain API routes

**None.** No routes under `/api/projects/*` exist. The
`api/public-api/` service (Hono on Node) currently exposes only
`/healthz`, `/api/articles*`, `/api/tags`, `/api/resumes/active`,
`/api/chatbot*`, `/api/chat`.

### 2.2 GitHub integration

- **`GitHubAdapter`** at
  `applications/ingestion/src/acquisition/GitHubAdapter.ts` —
  REST only, token via `GITHUB_TOKEN`, 5K req/h.
- **No webhook handler** in the projects domain (webhooks exist for
  OAuth at `/webhooks/github` — see merged PR #19).
- Ingestion orchestrator:
  `applications/ingestion/src/RepoIngestionOrchestrator.ts`.
- Sync state journal: `RdsSyncStateRepository.ts` → `repo_sync_state`.

### 2.3 KB embedding generation

- **Provider:** `TitanEmbeddingProvider` (Bedrock, dim 1024, max 30K chars
  input). Sequential per-chunk embedding for portfolio scale (<10K
  chunks/repo) — `applications/ingestion/src/knowledge/IngestionPipeline.ts`.

### 2.4 Onboarding orchestrator

- **K8s Jobs + `pipeline_runs` RDS state machine.** Not Step Functions,
  Celery, BullMQ, or FastAPI tasks.
- **Entry point:** `applications/job-strategist/src/run-pipeline.ts`.
- **State machine:** `queued → researching → analysing → persisting → complete`
  (`pipeline-runs.ts:16`).
- **Insertion point for Phase 4:** after `user_profile_rollup` refresh
  (and once SP2 mirror/reveal generation lands), insert
  `8. Project clustering (async) → 9. Review (UI) → 10. Case study
  generation (async)`.

### 2.5 AI middleware — structured outputs

- **Format: Zod** + Bedrock tool-use blocks
  (`applications/job-strategist/src/schemas/resume-data.schema.ts:83-92`,
  `applications/resume-import-processor/src/bedrock/enrich-role.ts:178-190`).
- **Grounding verifier:** `BedrockGroundingVerifier` (mode `'block'`) in
  `applications/chatbot/src/index.ts:50`. **Reuse for `source_signals`
  evidence trail in Phase 2** — do not invent a parallel evidence model.

### 2.6 Async / job-status pattern

- RDS-backed state via `pipeline_runs` for in-process pipelines.
- Event-driven path (EventBridge → SQS FIFO → Lambda) exists for
  self-healing (`infra/lib/stacks/self-healing/agent-stack.ts:477-514`)
  but is **not** used for user onboarding.

### 2.7 Auth + response envelope

- **Auth:** API key from Secrets Manager via EC2 Instance Profile, 15-min
  TTL cache (`api/public-api/src/routes/chatbot.ts:37-70`).
- **Envelope:** Hono `c.json(data, status)`. Errors:
  `{ error: <code>, message: <human> }`. Successes are domain-shaped, no
  outer wrapper. Phase 3 must follow this exactly.

---

## 3. Frontend (cross-repo: `tucaken-app`)

> Phase 5 lands in a separate repo. Tracked here only so Phase 1–4
> implementers know what the contract must serve.

| Aspect | Value | Source |
|---|---|---|
| Existing Projects route | `/_dashboard/projects` — placeholder ("coming soon") | `tucaken-app/src/app/_dashboard.projects.tsx:1-43` |
| Tailwind version | v4 with `@tailwindcss/vite` | `tucaken-app/src/styles.css`, `package.json` |
| Palette | accent `teal-{400,500,600}` + `emerald-{400,600}`; neutral `zinc-{50…900}` | `tucaken-app/typography.ts:32-70` |
| Dark mode | `.dark` class on `<html>`, context-managed, defaults to dark | `tucaken-app/src/contexts/ThemeContext.tsx` |
| Motion | `motion@^12.38.0`. Named patterns: `MotionButton` (spring `{400,30}`), `MagneticButton` (spring `{200,15,0.4}`), `AuthShell` fade-up | `tucaken-app/src/components/ui/MotionButton.tsx:30-129`, `tucaken-app/src/features/home/lib/MagneticButton.tsx:26-48` |
| Primitives | `@headlessui/react@^2.2.9` + `lucide-react`. **No Radix, no shadcn, no Tailwind Plus.** | `tucaken-app/package.json:24,51` |
| Path alias | `@/* → ./src/*` | `tucaken-app/tsconfig.json:16` |
| Public route shape | `/u/[username]/p/[slug]` **does not collide** with anything | `tucaken-app/src/routeTree.gen.ts` |

---

## 4. Onboarding flow today

```
1. Sign-up / Cognito provisioning
2. Resume upload     → resume-import-processor (PDF/DOCX → career_history + experience_embeddings)
3. GitHub connect    → GitHubAdapter + RepoIngestionOrchestrator
4. KB generation     → IngestionPipeline → document_embeddings (1024-d Titan)
5. repository_profiles extraction (SP0)
6. user_profile_rollup refresh (SP0/SP1)
7. Mirror / Reveal synthesis (SP2 — in flight)
```

LinkedIn is referenced in the spec but not surfaced as an explicit step
in the current code; if it exists, it lives inside
`resume-import-processor` enrichment.

---

## 5. Overlap between spec and shipped work

The spec treats Projects as net-new; SP0–SP2 already implemented the
foundations under different names. Phase 1 **extends**, doesn't duplicate.

| Spec target | Existing equivalent | Phase 1 action |
|---|---|---|
| `projects` table | none yet — `repository_profiles` covers single-repo case | **Build new `projects` table above `repositories`** |
| `project_stack_items.justification` | `repository_profiles.extracted->'tech_stack'` JSONB | Lift to typed table at project scope |
| `project_decisions` (ADR style) | not present | Net-new |
| `project_highlights` | `repository_profile_embeddings.chunk_type='highlight'` rows | Lift to typed table |
| `project_depth_markers` | partial in `repo_sync_state.kb_quality_breakdown` + `repository_profiles.quality_breakdown` | Aggregate at project scope |
| `project_resume_bullets` (per-angle) | resume generation in job-strategist | Reuse `BedrockGroundingVerifier` (Phase 2) |
| `project_architecture` Mermaid | not present | Net-new (Phase 2) |
| `mirror` / `reveal` per-project | user-scoped on `user_profile_rollup` | Decided: keep user-scoped + add per-project `tagline`/`pitch`. Not the same artifact. |
| `summary_embedding` | mirrors `repository_profile_embeddings` pattern | Reuse Titan 1024-d + HNSW |

---

## 6. Locked-in decisions (user review 2026-05-21)

1. **UUID v4** (`gen_random_uuid()`) — consistent with rest of codebase;
   uuidv7 is a separate cross-cutting RFC.
2. **`vector(1024)`** — Titan Embed v2 dimension; matches every other
   embedding table.
3. **No down-migration tooling** — codebase is forward-only with
   `IF EXISTS` contract migrations landing in later numbered files.
   Phase 1 is purely additive (only new tables), so the natural
   "down" is a future `0NN_projects_drop.sql` if ever needed.
4. **Per-project `tagline`/`pitch` ≠ user-scoped `mirror`/`reveal`.** Both
   coexist.
5. **Discovery + migration docs live at**
   `applications/platform-rds-bootstrap/docs/projects-migration/` (co-located
   with the migrations they describe; not in `docs/`, which is git-ignored).
6. **Cross-repo PRs.** Phase 1–4 in `ai-applications`; Phase 5 in
   `tucaken-app`.
7. **Job orchestration:** extend `pipeline_runs` K8s-Job pattern. Do not
   introduce SQS-FIFO for clustering or case-study generation.
8. **`source_signals`** uses a typed Zod schema mirroring
   `BedrockGroundingVerifier` claim format. Validated on write.
9. **Redis caching** scope (AI-gen cache, GitHub API cache) lands in
   Phase 2/3 implementation PRs — not in this Phase 1 schema PR.

---

## 7. Phase 1 PR scope (this repo, off `develop`)

Two migration files plus an E2E test, all idempotent and additive:

- **`030_projects.sql`** — 10 new tables, indexes, RLS policies, GRANTs
  to `tucaken_app`, HNSW index on `projects.summary_embedding`, and a
  reusable `set_updated_at` trigger reused from earlier migrations.
- **`031_projects_backfill.sql`** — for every existing `repositories`
  row, insert one default `projects` row (`shape='single_repo'`,
  `is_ai_suggested=false`, `is_user_confirmed=false`), one
  `project_components` row (`kind='shared'`, naming `"Main"`), and
  one `project_repositories` link. Slug = `lower(repo_short_name)` with
  per-user `-N` suffix on collision. `ON CONFLICT DO NOTHING` so the
  migration is safe to re-run.
- **E2E test** (Jest + `pg`, lives at
  `applications/platform-rds-bootstrap/__tests__/projects-migration.test.ts`):
  spin up an ephemeral schema, seed N users + repos, run base DDL + 030 +
  031, assert:
  - row counts match seeded data
  - one project per repo
  - one component per project (`kind='backend'`)
  - one project_repositories link per project, pointing back to the
    correct repository_id
  - slugs unique per user
  - RLS denies cross-user reads with `app.current_user_id` set
  - re-running 030 + 031 is a no-op (idempotency check)

The test runs against `PG*` env vars (matching the bootstrap runner's
convention). A `just` recipe wires it up so contributors run it the same
way smoke tests run today.

---

## 8. Phase ordering (unchanged from spec, adjusted for reality)

1. **Phase 1** (this PR) — schema + backfill + E2E. `ai-applications`.
2. **Phase 2** — clustering + case-study + architecture services. Extend
   `pipeline_runs`, reuse `BedrockGroundingVerifier`, Zod schemas.
   Feature-flag gated.
3. **Phase 3** — Hono routes under `api/public-api/src/routes/projects.ts`.
   Follow existing error envelope. No deprecated endpoints to retire
   (none exist).
4. **Phase 4** — onboarding step insertion in `run-pipeline.ts`; add
   clustering after rollup + mirror/reveal.
5. **Phase 5** — `tucaken-app` PR. New feature folder
   `src/features/projects/`. Reuse `MotionButton`, `MagneticButton`,
   headlessui primitives, Mermaid via `mermaid.js`.
6. **Phase 6** — categorization filters + public share URL
   `/u/[username]/p/[slug]`.
7. **Cleanup** — feature-flag removal; no deprecated code to delete since
   the existing Projects UI is a placeholder.
