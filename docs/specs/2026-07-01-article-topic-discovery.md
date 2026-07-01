# Article Topic Discovery + Verified Metrics — Design & Plan (Gaps 2 + 3)

- **Date:** 2026-07-01
- **Repos:** `ai-applications` (discovery + pipeline), `tucaken-app` (admin-api + builder UI)
- **Status:** Approved design; ready to implement
- **Companion done:** Gap 1 (metadata persist, `ced4474`), Gap 4 (Specificity & Result QA dimension, `d4b1774`)

## Goal

Stop feeding the article pipeline a bare ≤500-char prompt. Instead, **mine
narrow, high-signal article topics (war stories) from the evidence the Project
case-study generator already produced**, present them to the admin as a
pre-seeded dropdown, and pass the chosen candidate to the pipeline as a
**structured brief** that carries the repo's **verified measured numbers** — so
those numbers survive the anti-fabrication rail (Gap 3) instead of being stripped.

## Locked decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Where discovery runs | **Piggyback on case-study generation** (reuse loaded context + `project_challenges`/`project_decisions`) | Evidence already loaded; near-zero extra cost; no re-scan/re-embed |
| Trigger | **Auto-run** after each case-study synthesis | It is a cheap transform of already-produced analysis |
| Candidate storage | New `article_topic_candidates` table, keyed by **`github_repo_id`** (+ `user_id`); `repo_full_name` kept as display label only | Stable across repo renames; user-scoped so v2 can open it to users |
| Access (v1) | Builder dropdown is **admin-gated** now; data model is user-scoped so v2 removes only the UI gate | Covers both use cases |
| Brief | Structured `ArticleBrief` replaces the short prompt | Grounds generation in real evidence + carries verified metrics |
| Verified metrics (Gap 3) | Ride the candidate → brief → Writer "Verified Metrics" context block; QA treats them as verified | Numbers survive the DORA rail without licensing fabrication |
| Article body format | **Stays MDX** — no change | Protects the built UI; JSON-block migration is a separate spec |
| Candidate/brief format | **JSON** | Structured data, no UI-render coupling |

## Non-goals (this spec)

- Changing the article body output format (MDX → JSON blocks) — separate spec.
- Opening topic-discovery to non-admin users (v2).
- Re-scanning/re-embedding repos for discovery (explicitly avoided).

## Architecture

```
repo sync ─▶ case-study gen (loadCaseStudyContext, project_challenges/decisions)
                     │  reuse in-memory context + synthesised challenges
                     ▼
        deriveArticleCandidates()  (cheap Haiku pass; NO re-scan)
                     │  each challenge/decision → candidate {title, problem, angle,
                     │  evidence_refs[], verified_metrics[], skills[]}
                     ▼
        article_topic_candidates  (github_repo_id, user_id, status='suggested')
                     │
  tucaken-app admin builder ◀── GET /api/admin/articles/topic-candidates?githubRepoId=
                     │  admin picks a candidate → structured ArticleBrief
                     ▼
  POST /api/admin/pipelines/article-job/:slug  (brief in body; mark candidate 'used')
                     ▼
  article pipeline: Research(brief) → Writer(+Verified Metrics block, Gap 3)
                     → QA(+Specificity dimension Gap 4; verified-metrics-aware)
                     → persist(title/excerpt/tags, Gap 1)   [body stays MDX]
```

## Components & tasks

### A. Migration — `article_topic_candidates` (ai-applications)
`applications/platform-rds-bootstrap/migrations/NNN_article_topic_candidates.sql`
(next number after current head on `develop`). Columns:
`id, user_id (FK users), github_repo_id BIGINT NOT NULL, repo_full_name TEXT,
project_id UUID, source_pipeline_run_id UUID, title TEXT NOT NULL, problem TEXT
NOT NULL, angle TEXT, primary_keyword TEXT, evidence_refs JSONB DEFAULT '[]',
verified_metrics JSONB DEFAULT '[]', skills TEXT[] DEFAULT '{}', status TEXT
NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','used','dismissed')),
used_article_slug TEXT, created_at, updated_at`. Index
`(user_id, github_repo_id, status)`. Idempotent (`IF NOT EXISTS`). Apply to dev
via the in-cluster psql path used for migration 110.

### B. `TopicCandidateRepository` (ai-applications shared)
`upsertCandidates`, `listByRepo(userId, githubRepoId, status?)`,
`markUsed(id, slug)`, `markDismissed(id)`. Jest tests (mock pool, assert SQL +
params include `github_repo_id`).

### C. `deriveArticleCandidates()` discovery step (ai-applications)
Hook into the case-study orchestrator **after** synthesis + persistence. Input:
the already-produced case-study result (challenges, decisions, highlights) + the
loaded context (source signals, tech evidence). A cheap Haiku pass converts each
challenge/decision into a candidate, extracting `verified_metrics` (numbers found
in the cited commits/PRs/diffs/README) and a specific problem-framed `title`.
Non-blocking (try/catch, fail-open, like the grounding verifier). Feature-flag
`ARTICLE_TOPIC_DISCOVERY=1`. NO new retrieval/embedding.

### D. `ArticleBrief` type + Research Agent intake (ai-applications)
`ArticleBrief = { title, problem, angle, primaryKeyword, evidenceRefs[],
verifiedMetrics[], targetAudience }`. The article-job env accepts a brief
(JSON) alongside/instead of the S3 draft. `research-agent` uses the brief as the
authored direction; `verifiedMetrics` are injected into the Writer user message
as a **"Verified Metrics (authoritative — you may cite these)"** block.

### E. Gap 3 — Writer + QA prompt changes (ai-applications)
- `blog-persona.ts` DORA rule: broaden from "DORA metrics" to "any performance/
  cost metric: cite ONLY numbers present in the **Verified Metrics** block or the
  KB. The Verified Metrics block IS an authoritative source — cite those numbers."
- `qa-persona.ts` Technical Accuracy: "Numbers that match the provided Verified
  Metrics context are verified — do NOT flag them as unverified." Keeps the
  anti-fabrication guard for everything else.

### F. admin-api endpoints (tucaken-app/admin-api)
- `GET /api/admin/articles/topic-candidates?githubRepoId=…` → `{ candidates }`
  (requireAdminGroup). Repository read from the shared DB.
- Extend `POST /api/admin/pipelines/article-job/:slug` to accept an optional
  `brief` (structured) and `candidateId`; on dispatch, mark the candidate `used`
  with the slug.
- Frontend server fns in `src/server/` mirror these (requireAdmin).

### G. Builder dropdown (tucaken-app)
In the article creation surface (AiArticleForm / ArticleBuilder), add a
**"Start from a suggested topic"** control: fetch candidates by project/repo,
show `title + problem + evidence + metrics`; selecting one pre-fills the brief
and dispatches with the structured brief. Admin-gated. `happy-dom` component test.

## Verification
- ai-applications: Jest per-workspace + typecheck (build `shared` first); apply
  migration to dev; smoke the discovery step against the one existing project.
- tucaken-app: Vitest (frontend) + Jest (admin-api); build; the builder dropdown
  test.
- End-to-end: pick a candidate → pipeline runs → article persisted with real
  title/tags (Gap 1) and a measured number that passes QA (Gaps 3+4).

## Build order
1. A + B (migration + repository) — foundation, apply to dev.
2. C + D (discovery step + brief intake) — the ai-applications core.
3. E (Writer/QA verified-metrics prompt changes).
4. F (admin-api + frontend server fns).
5. G (builder dropdown UI).
6. Cross-repo verification + PRs (ai-applications → develop, tucaken-app → main).
