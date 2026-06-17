# Spec — Grounded change-impact: commit diff/stats ingestion (Increment 1)

Date: 2026-06-17
Status: draft for review
Scope: Increment 1 of 3. Foundation only — no LLM narration yet.

## Problem

The "X% to Y% performance increase" design (LLM reads old vs new code, estimates a
percentage) cannot be built on the current store, and its naive form violates this
repo's grounding discipline:

1. **No diffs, no old code.** Ingestion stores *current* file content only;
   incremental sync discards old blobs. `repo_commits` holds commit *messages*,
   not changes. `GitHubAdapter.listCommits` uses the list endpoint, which omits
   per-commit stats and file lists.
2. **No measured performance signal.** Latency/throughput live in Prometheus/
   Grafana and are never correlated to a commit SHA.
3. **LLM-estimated percentages are fabricated numbers.** A model emitting
   "40–60% faster" from a diff, with no benchmark input, is exactly what
   `number-provenance.ts` / `stripUngroundedNumbers` / the grounding verifier
   exist to prevent.

## Goal of Increment 1

Make "old vs new" retrieval **possible** and capture **deterministic, honest**
change facts. No LLM, no percentages yet. After Increment 1:

- Per-commit stats (additions, deletions, files changed) are stored.
- Per-file unified diffs (patches) are stored, size-capped.
- Deterministic LOC/churn metrics are queryable per commit and per file.
- The data is RLS-scoped, idempotent, incremental, and migration-ledgered.

Non-goals (later increments): complexity-delta, diff embedding/retrieval, the
narration agent, CI/perf measurement.

## The grounding contract (locked now, enforced in Increment 3)

Defined here so Increment 1 is built toward it.

- **Layer 1 (deterministic, no LLM)** is the only source of numbers. LOC delta,
  files changed, churn, and later cyclomatic-complexity delta are *computed*,
  never generated.
- **A performance percentage may be emitted ONLY when a measured benchmark exists
  for the (before SHA, after SHA) pair.** No measurement → no percentage. The
  agent narrates the structural change qualitatively instead.
- **The narration agent may not emit a number absent from its grounded input.**
  Enforced two ways: (a) the prompt receives only the Layer-1 facts + any measured
  perf rows; (b) the output passes `stripUngroundedNumbers` / the grounding
  verifier — any number not tracing to an input fact is stripped or flagged.
- Per-phase eval (CLAUDE.md rule): the narration agent ships with an eval that
  asserts **no output number is absent from the grounded input** (anti-fabrication).

## Data model

### `repo_commits` — add stats columns

```
ALTER TABLE repo_commits
  ADD COLUMN additions      integer,   -- nullable until detail fetched
  ADD COLUMN deletions      integer,
  ADD COLUMN files_changed  integer,
  ADD COLUMN stats_fetched_at timestamptz;  -- null = detail not yet pulled
```

### `repo_commit_files` — new (per-file change in a commit)

```
CREATE TABLE repo_commit_files (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL,
  repository_id     uuid NOT NULL,
  repo_full_name    text NOT NULL,
  github_repo_id    bigint,
  commit_sha        text NOT NULL,
  file_path         text NOT NULL,
  status            text NOT NULL,        -- added|modified|removed|renamed
  previous_filename text,                 -- for renames
  additions         integer NOT NULL DEFAULT 0,
  deletions         integer NOT NULL DEFAULT 0,
  changes           integer NOT NULL DEFAULT 0,
  patch             text,                 -- unified diff hunk; null if capped/binary
  patch_truncated   boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, repo_full_name, commit_sha, file_path)
);
CREATE INDEX ON repo_commit_files (user_id, repo_full_name, file_path);  -- "diffs touching file X"
-- RLS: USING (user_id = current_setting('app.current_user_id', true)::uuid)
```

Decision — **patch-based, not snapshot-based.** Store the diff hunk, not full old
file content. "Previous state" is reconstructable from current chunk +
reverse-applying patches if ever needed. Far cheaper; sufficient for change
narration. (Alternative — full per-commit snapshots — rejected: storage blowup,
no added value for Increment 1.)

## Ingestion changes

### `IRepoAdapter` / `GitHubAdapter`

Add `getCommitDetail(repoFullName, sha): Promise<CommitDetail>` hitting
`/repos/{repo}/commits/{sha}` → `{ stats: {additions, deletions, total}, files:
[{ filename, status, additions, deletions, changes, previous_filename?, patch? }] }`.

Guardrails (CLAUDE.md network + tarball caps):
- Request timeout + response-size cap on the adapter call.
- **Per-patch size cap** (e.g. 64 KB): over-cap or binary → `patch = null`,
  `patch_truncated = true`. Stats still kept.
- **Per-commit total-diff cap**: stop storing patches past N KB; keep stats.
- Skip generated/vendored paths via the existing `FileFilter` denylist.

### Orchestrator wiring

- Only fetch detail for commits **new since the watermark** (the incremental
  `last_synced_commit_sha` machinery already exists). Never re-fetch.
- Bounded-concurrency pool (reuse `FILE_FETCH_CONCURRENCY` pattern) to stay under
  GitHub's secondary rate limit; 1 detail call per commit.
- Hard cap (`MAX_COMMIT_DETAILS`, default 500) — and `log()` what was dropped (no
  silent truncation).
- Persistence transactional + idempotent (UNIQUE upsert); track created IDs.
  Best-effort: a detail-fetch failure logs and continues (one bad commit never
  aborts the run), matching the existing commit/PR ingestion behaviour.

### Migration

Numbered migration via the existing ledger (checksums, rejects changed historical
migrations). One migration: stats columns + `repo_commit_files` + RLS policy + indexes.

## Deterministic metrics (Layer 1, this increment)

Pure functions, TDD, no LLM:
- `loc_delta = additions - deletions`, `churn = additions + deletions` (free from
  stats).
- `files_changed`, per-file `changes`.
- Cyclomatic-complexity delta is **Increment 2** (needs decision-point counting on
  old vs new function text).

## Increment roadmap

- **Inc 1 (this spec):** commit diff/stats ingestion → schema + adapter + bounded
  incremental fetch + deterministic LOC/churn. Data exists and is queryable.
- **Inc 2:** deterministic complexity-delta; structured per-change summary;
  retrieval to fetch "diffs touching function/file X" (joins `repo_commit_files`
  to a code-chunk hit, reusing the new `fileClass`/neighbour machinery).
- **Inc 3:** measured-perf hook (CI benchmark → `repo_commit_perf` keyed by SHA)
  + the grounded narration agent (forced-tool JSON, grounding-gated per the
  contract above, with its anti-fabrication eval).

## Build order (each step ends in a commit, git-commit skill)

1. Migration: stats columns + `repo_commit_files` + RLS + indexes. → `feat(rds)`
2. `GitHubAdapter.getCommitDetail` + types, with timeout/size caps. TDD (mocked). → `feat(shared)`
3. Orchestrator: incremental bounded detail-fetch + transactional upsert + caps. TDD. → `feat(shared)`
4. Deterministic LOC/churn helpers + queries. TDD. → `feat(shared)`

## Open decisions for sign-off

1. **Patch storage**: confirm patch-based (recommended) vs snapshot-based.
2. **Caps**: per-patch 64 KB, per-commit total, `MAX_COMMIT_DETAILS` 500 — confirm.
3. **Backfill**: apply detail-fetch to existing commits on next `forceReindex`,
   or only forward from now? (Backfill = up to 500 API calls/repo.)
4. **Ticket IDs**: parse Jira/Linear IDs from commit messages into a column now,
   or defer? (Cheap regex; useful for the design's "associated ticket" goal.)
```
