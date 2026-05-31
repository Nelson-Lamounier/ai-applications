# Repo Activity Structured Store — Design

> **Date:** 2026-05-31
> **Author:** Nelson Lamounier (with Claude)
> **Status:** Approved (brainstorming) → ready for implementation plan

## Problem

The case-study generation pipeline (`job-strategist`) **re-fetches commits and
pull requests from the GitHub REST API at generation time**, even though
ingestion already scanned the repository. This violates the application's core
principle: **ingestion (and repo sync/resync) is the only time GitHub is
scanned; all downstream features act on the ingested user KB.**

Concretely today:

- `case-study-loader.ts` takes a `commitLoader` + `pullRequestLoader` that wrap
  `GitHubAdapter`, and fetches commits (50/repo) + PRs (25/repo) live from
  GitHub every time a case study is generated.
- Ingestion **already** fetches commits (500/repo,
  `RepoIngestionOrchestrator.fetchAndChunkCommits`) but persists them only as
  **lossy weekly prose chunks** in `document_embeddings` — the per-commit
  `sha` (full), `authored_at` (full timestamp), `author_name`, and `message`
  are not recoverable in structured form. So case-study cannot read them back
  and re-fetches.
- Ingestion does **not** fetch PRs at all — case-study's re-fetch is the only
  way PR data enters the system.

This adds GitHub API cost + latency on every generation, requires a
`GITHUB_TOKEN` at generation time, and breaks if GitHub is unreachable.

## Goal

Make ingestion the single source of truth for commit + PR data by persisting it
**structured**, and refactor case-study to read **only from the DB** — never
GitHub. After this change, `job-strategist` is a pure consumer of the user KB.

## Non-goals (YAGNI)

- Migration-time backfill of existing repos (re-sync repopulates instead).
- Per-commit file-diff / additions-deletions (the list endpoint omits these;
  out of scope).
- Changing the RAG/semantic-search behaviour of commit prose chunks.
- Moving the chatbot's PgSemanticCache or the public-api read-cache.

---

## Architecture

```
INGESTION / SYNC / RESYNC  ──(GitHub API — the ONLY scan)──┐
  listCommits (cap 500)                                     │
  listPullRequests (cap 100)   ← NEW: PRs now ingested      │
        │                                                   │
        ├─► repo_commits        (structured rows)  ─────────┤  source of truth
        ├─► repo_pull_requests  (structured rows)  ─────────┤
        └─► weekly prose chunks DERIVED from the fetched    │
            commits (existing CommitChunker, same fetch) ───► document_embeddings (RAG, unchanged consumer)

CASE-STUDY GENERATION  ──(reads DB only — NO GitHub, NO GITHUB_TOKEN)──
  loadCaseStudyContext → SELECT repo_commits + repo_pull_requests + document_embeddings
        │
        └─► packContext (token budget) → Sonnet → persist
```

**Key decisions (from brainstorming):**

1. **Two representations, one fetch.** Commits are fetched once during
   ingestion, written to `repo_commits` (structured), and the existing weekly
   prose chunks are **derived from those same in-memory commits** — not a
   second fetch, not a parallel format. Structured rows are authoritative; the
   prose chunk is a derived RAG view. This removes the lossy-prose dependency.
2. **PRs ingested too.** Ingestion gains a `listPullRequests` call (cap 100) and
   persists to `repo_pull_requests`. No prose chunks for PRs (they were never
   RAG-embedded); case-study reads them structured.
3. **Re-sync repopulates.** No migration backfill. Structured tables start
   empty and fill as repos sync/resync (aligns with "scan only at sync").
4. **Graceful empty-data.** If a project's repos have no structured commits yet
   (not resynced), case-study generates from KB chunks alone — never blocks.
5. **Redis cache enabled** for the case-study + clustering jobs as part of this
   work (env wiring in kubernetes-bootstrap), since the cache key now also
   covers PR identity.

---

## Component design

### 1. Schema — migration `045_repo_commits_pulls.sql`

`applications/platform-rds-bootstrap/migrations/045_repo_commits_pulls.sql`.
Follows existing conventions: idempotent (`IF NOT EXISTS`), denormalised
`user_id`, RLS on `app.current_user_id`, `GRANT … TO tucaken_app`.

```sql
CREATE TABLE IF NOT EXISTS repo_commits (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repository_id  UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    repo_full_name TEXT NOT NULL,
    sha            TEXT NOT NULL,                 -- full 40-char
    author_name    TEXT NOT NULL,
    author_login   TEXT,
    authored_at    TIMESTAMPTZ NOT NULL,
    message        TEXT NOT NULL,                 -- full subject+body
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (repository_id, sha)                   -- idempotent re-sync
);
CREATE INDEX IF NOT EXISTS idx_repo_commits_lookup
    ON repo_commits (user_id, repo_full_name, authored_at DESC);

CREATE TABLE IF NOT EXISTS repo_pull_requests (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repository_id  UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    repo_full_name TEXT NOT NULL,
    number         INTEGER NOT NULL,
    title          TEXT NOT NULL,
    body           TEXT,
    state          TEXT NOT NULL CHECK (state IN ('open','closed','merged')),
    author_login   TEXT,
    created_at_gh  TIMESTAMPTZ NOT NULL,          -- PR opened (GitHub)
    merged_at      TIMESTAMPTZ,
    html_url       TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (repository_id, number)                -- idempotent re-sync
);
CREATE INDEX IF NOT EXISTS idx_repo_pulls_lookup
    ON repo_pull_requests (user_id, repo_full_name, merged_at DESC NULLS LAST);
```

Both: `ENABLE ROW LEVEL SECURITY`, `rls_repo_commits` / `rls_repo_pull_requests`
policies (`user_id = current_setting('app.current_user_id', true)::uuid`),
`GRANT SELECT, INSERT, UPDATE, DELETE … TO tucaken_app`.

Resync uses `ON CONFLICT (repository_id, sha|number) DO UPDATE` → no dupes,
mutable fields (state, merged_at, message) refresh.

### 2. Data-access — `RdsRepoActivityStore`

`applications/shared/src/rds/implementations/RdsRepoActivityStore.ts`:

```
upsertCommits(userId, repositoryId, repoFullName, commits: RepoCommit[]): Promise<number>
upsertPullRequests(userId, repositoryId, repoFullName, pulls: RepoPullRequest[]): Promise<number>
```

- Batched multi-row `INSERT … ON CONFLICT … DO UPDATE`, returning rowcount.
- Runs under the project RLS pattern (caller sets `app.current_user_id`, or the
  store sets `SET LOCAL` within a transaction — match how the ingestion
  pipeline's existing repositories set it).
- Consumes the existing `RepoCommit` / `RepoPullRequest` types from
  `ingestion/interfaces/IRepoAdapter.ts` (no new shapes).

### 3. Ingestion writes — `RepoIngestionOrchestrator`

Currently `fetchAndChunkCommits` fetches commits → chunks → returns chunks.
New flow:

- Inject an optional `RepoActivityStore` + the `repositoryId` (resolved from
  `repositories` by `(user_id, full_name)`) into the orchestrator, the same way
  `commitChunker` is injected today. `run-ingestion.ts` constructs the store
  with the pool (where `IngestionPipeline` already gets its deps).
- **Commits:** after `listCommits`, call `store.upsertCommits(...)` with the
  fetched commits, **then** derive the weekly prose chunks from those same
  in-memory commits (existing `CommitChunker.chunkWeekly`). One fetch, two
  outputs.
- **PRs (new):** `listPullRequests` (cap 100) → `store.upsertPullRequests(...)`.
  No chunks. Best-effort: PR scope may be absent on a fresh install — a failure
  logs and continues (mirrors the commit best-effort stance).
- **Failure stance:** the *fetch* stays best-effort (file ingestion must still
  complete). Persisting *successfully-fetched* data is the new contract — a
  store write error surfaces (it indicates a real DB problem, not a GitHub
  scope gap).
- `forceReindex` path gets the same treatment (it already re-runs
  `fetchAndChunkCommits`).

### 4. Case-study read-path — drop GitHub

`case-study-loader.ts`:

- **Remove** the `commitLoader` + `pullRequestLoader` parameters.
- Commits via SQL:
  `SELECT sha, author_name, authored_at, message FROM repo_commits
   WHERE user_id = $1 AND repo_full_name = ANY($2) ORDER BY authored_at DESC`
  (then `packContext` applies the token budget — see dependency note).
- PRs via SQL:
  `SELECT number, title, body, state, merged_at, html_url, created_at_gh
   FROM repo_pull_requests WHERE user_id = $1 AND repo_full_name = ANY($2)
   ORDER BY merged_at DESC NULLS LAST`.
- Empty result sets are valid → `commits: []` / `pulls: []`; generation
  proceeds from KB chunks alone.

`run-case-study.ts`:

- Delete `buildAdapter`, `buildCommitLoader`, `buildPullRequestLoader`.
- **Drop `GITHUB_TOKEN`** from `env-case-study.ts` (no longer required).
- Stop passing the loaders to the orchestrator.

`admin-api` (tucaken-app) `dispatchCaseStudyJob`: stop injecting `GITHUB_TOKEN`
into the case-study Job env.

### 5. Cache key — `computeInputHash`

`case-study-orchestrator.ts:computeInputHash` currently hashes project fields,
repo fields, and **commit SHAs only**. Commit SHAs are unchanged by this work
(same commits, same SHAs, just DB-sourced) → **existing cache entries for
commit-only projects remain valid**. Add PR identity to the hash so PR changes
rotate the key:

```
for (const pr of c.pulls) h.update(`${pr.number}:${pr.state}:${pr.mergedAt ?? ''}`);
```

Content-addressed → stale entries expire by the 30-day TTL; no explicit
invalidation needed.

### 6. Redis enablement (kubernetes-bootstrap)

The case-study + clustering Jobs already construct `RedisExactCache.fromEnvironment()`
but `REDIS_CACHE_HOST` is unset in the Job spec → fail-open disabled (every run
hits Sonnet/Haiku). Wire the env into the job-strategist Job spec / dispatch:

```
REDIS_CACHE_HOST=redis-cache-master.redis-cache.svc.cluster.local
REDIS_CACHE_PORT=6379
REDIS_CACHE_TLS=false
REDIS_CACHE_PASSWORD=<from existing redis-cache secret>
```

Fail-open proven — a wrong host/secret degrades to uncached, never broken.

---

## Testing

- **Migration 045:** idempotent re-apply; both tables + RLS policies + grants
  present; unique constraints enforce upsert.
- **RdsRepoActivityStore:** `upsertCommits`/`upsertPullRequests` insert on first
  call; re-upsert with same `(repository_id, sha|number)` updates, not
  duplicates; rowcounts correct; queries scoped by `user_id` (pg-mock, existing
  admin-api/shared test pattern).
- **RepoIngestionOrchestrator:** commits persisted via store AND prose chunks
  still derived (same count as before); PRs persisted; `listPullRequests`
  failure logs + continues; store write error surfaces.
- **case-study-loader:** reads commits/PRs from DB; returns empty arrays when
  none; performs **no** GitHub calls (no adapter constructed).
- **computeInputHash:** deterministic; commit-only hash byte-identical to
  today's (cache back-compat); adding/removing a PR rotates the hash; changing
  a commit SHA rotates the hash.
- **packContext:** unchanged (existing PR #101 tests remain green).

---

## Sequencing (3 PRs)

> **Dependency note:** the case-study token-budget fix (PR #101,
> `packContext` + `CASE_STUDY_MAX_TOKENS=32768`) is in flight on its own branch.
> PR 2 below builds on it. Land #101 first (or rebase PR 2 on it).

1. **ai-applications — ingestion writes** (migration 045 + `RdsRepoActivityStore`
   + orchestrator commit/PR persist + derive chunks). After this, ingestion
   populates the structured tables. No consumer change yet — safe to ship alone.
2. **ai-applications — case-study reads DB** (loader DB queries, drop
   `commitLoader`/`pullRequestLoader`, drop `GITHUB_TOKEN` from
   `env-case-study.ts`, `computeInputHash` PR addition). Depends on PR 1's
   tables + PR #101.
3. **kubernetes-bootstrap — cache + token wiring** (`REDIS_CACHE_*` env into the
   job-strategist Job; admin-api drops `GITHUB_TOKEN` from case-study dispatch).

## Rollout

1. Merge PR 1 → bootstrap applies migration 045.
2. Resync the two dev repos (`cdk-monitoring`, `ai-applications`) → populates
   `repo_commits` + `repo_pull_requests`.
3. Merge PR 2 + PR 3 → case-study reads DB only.
4. Regenerate the multi_repo case study → verify content lands, no GitHub call,
   and a second regenerate is a Redis cache hit (no Sonnet invocation).
