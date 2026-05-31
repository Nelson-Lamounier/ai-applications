# Incremental Ingestion — Design

> **Date:** 2026-05-31
> **Status:** Approved (brainstorming) → ready for implementation plan
> **Scope:** ai-applications, 1 PR. Makes file fetch+embed on resync incremental.

## Problem

Resync of an already-synced repo re-fetches **every** file's content from GitHub,
even when nothing changed. Embedding is already incremental (the
`IngestionPipeline` skips chunks whose SHA-256(content) is unchanged — observed
`embedded=0 skipped=2846` on a no-op resync), but the **fetch tier above it is
not**: `RepoIngestionOrchestrator.fetchAndChunkFiles` fetches all included files
unconditionally.

Root cause: `GitHubAdapter.listFiles` reads the git tree (which returns a per-file
**blob SHA**, `item.sha`) but **discards it** — `RepoFile` is only `{path, sizeBytes}`.
Without a persisted per-file change key, the system can't tell which files changed
pre-fetch, so it fetches all and dedups at the embedding layer. This wastes GitHub
API bandwidth + fetch latency on every resync.

## Goal

Resync fetches + embeds only **changed** files. Detect change with two tiers that
cost **zero extra GitHub API calls** for the per-file decision (the blob SHA is
already in the tree listing).

## Non-goals (YAGNI)

- Gating profile extraction / archetype-signal derivation / retrieval probe on
  "changes detected" — those still run every sync (they're cheaper than full file
  fetch, and signals must reflect the current full tree).
- ETag / `If-None-Match` conditional HTTP.
- The `since` param on `listCommits`.
- Backfill — the first post-deploy sync seeds the state.

---

## Architecture — two-tier change detection

```
RESYNC (RepoIngestionOrchestrator.ingestRepo):
  1. headSha   = adapter.getHeadCommitSha(repo)              # 1 API call
  2. allFiles  = adapter.listFiles(repo)                     # 1 API call; now carries blobSha
  3. (archetype signals derived from allFiles — unchanged, every sync)
  4. lastSha    = syncState.getLastSyncedCommitSha(user, repo)
  5. priorState = fileStateRepo.getFileState(user, repo)     # Map<path, blobSha>

  ── TIER 1 (cheap gate) ──
  if lastSha && lastSha === headSha && priorState.size > 0:
      filesToFetch = []                 # HEAD unchanged → nothing to fetch
  else:
      ── TIER 2 (per-file refine) ──
      included     = fileFilter.filterWithSize(allFiles)
      filesToFetch = included.filter(f => priorState.get(f.path) !== f.blobSha)
      #   new file        → not in priorState → fetched
      #   modified file   → blobSha differs   → fetched
      #   unchanged file  → blobSha equal     → skipped
      #   (priorState empty → everything fetched = full ingest)

  6. fetch + chunk ONLY filesToFetch → ingestionPipeline.ingestChunks
     (content-hash embedding skip still applies as the 2nd safety net)
  7. pruneDeletedFiles(user, repo, <FULL included path set>)   # existing; see note
  8. fileStateRepo.upsertFileState(user, repo, included)       # refresh to current tree
  9. syncState.setLastSyncedCommitSha(user, repo, headSha)
```

**Unified full-ingest path (no branching):** `forceReindex` and first-sync both
end up fetching everything via the *same* code — `forceReindex` deletes the
watermark + `repo_file_state` up front, so step 5 returns an empty map, the Tier-1
gate falls through, and Tier-2 fetches all. First sync has no state → identical.

**CRITICAL correctness point:** `pruneDeletedFiles` is called with the **full
included path set** (every file currently in the tree that passes the filter),
NOT the `filesToFetch` subset. Otherwise unchanged-but-present files would be
pruned as "deleted." This is the one easy-to-get-wrong spot.

### Edge cases

| Case | Handling |
|------|----------|
| First sync | no state → all fetched |
| Modified file | blob SHA differs → fetched |
| Deleted file | in `priorState`, not in tree → `pruneDeletedFiles` removes chunks; absent from new state |
| Renamed file | git tree = delete old + add new → old pruned, new fetched |
| Force-push / rebase | Tier-1 HEAD differs → falls to Tier-2 blob diff (correct regardless of history) |
| Tree truncated (>~100k files) | the manual-traversal fallback must populate `blobSha`; if a path can't get one, treat it as changed (fetch) for safety |
| force-reindex | deletes state + watermark → full re-fetch |

---

## Components

### 1. Migration `048_repo_file_state.sql`

```sql
CREATE TABLE IF NOT EXISTS repo_file_state (
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repo_full_name TEXT NOT NULL,
    file_path      TEXT NOT NULL,
    blob_sha       TEXT NOT NULL,
    size_bytes     INTEGER NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, repo_full_name, file_path)
);
CREATE INDEX IF NOT EXISTS idx_repo_file_state_repo
    ON repo_file_state (user_id, repo_full_name);

ALTER TABLE repo_file_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_repo_file_state ON repo_file_state;
CREATE POLICY rls_repo_file_state ON repo_file_state
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON repo_file_state TO tucaken_app;

ALTER TABLE repo_sync_state
    ADD COLUMN IF NOT EXISTS last_synced_commit_sha TEXT;
```
Per-user RLS (this is the user's repo tree), unlike the global ontology tables.
Idempotent.

### 2. `RdsRepoFileStateRepository`

`applications/shared/src/rds/implementations/RdsRepoFileStateRepository.ts`:
```
getFileState(userId, repoFullName): Promise<Map<string, string>>   // path → blob_sha
upsertFileState(userId, repoFullName, files: {path, blobSha, sizeBytes}[]): Promise<void>  // batch upsert
deleteFileState(userId, repoFullName): Promise<void>               // force-reindex clears
```
RLS-in-transaction pattern (mirror `RepositoryProfileEmbeddingsRepository` /
`RdsSyncStateRepository`). `upsertFileState` does NOT delete missing rows — pruning
of deleted files is handled by overwriting state to the current tree (step 8 writes
the full `included` set; stale paths are cleaned by a `DELETE ... WHERE file_path
NOT IN (...)` inside the same call, OR the simplest correct form: delete-all-then-insert
for that repo within one transaction. Implementation chooses; the contract is "after
upsertFileState, the table reflects exactly the current tree").

### 3. Sync-state watermark accessors

Extend `RdsSyncStateRepository` (+ `ISyncStateRepository`):
```
getLastSyncedCommitSha(userId, repoFullName): Promise<string | null>
setLastSyncedCommitSha(userId, repoFullName, sha): Promise<void>
```
Plain UPDATE/SELECT, same pool pattern as the existing methods.

### 4. Adapter — surface blob SHA + HEAD commit

`IRepoAdapter` / `GitHubAdapter`:
- `RepoFile` gains `readonly blobSha: string`. `listFiles` already reads `item.sha`
  from the tree response — stop discarding it in the `.map`. The truncated-tree
  manual-traversal fallback must also populate `blobSha` (the per-directory tree
  entries carry `sha`); if a path genuinely lacks one, set `blobSha=''` so Tier-2
  treats it as changed (safe).
- New `getHeadCommitSha(repoFullName): Promise<string>` — `GET /repos/{repo}/commits/{default_branch}` → `sha`. (The adapter already resolves `default_branch` for the tree call; reuse it.)

### 5. Orchestrator + run-ingestion

`RepoIngestionOrchestrator`:
- Inject optional `fileStateRepo` + the watermark accessors (structural interfaces,
  like the existing `activityStore` / `syncStateSignalSink` options — decoupled).
- `ingestRepo`: implement the two-tier flow above. When `fileStateRepo` is absent
  (not wired), behave exactly as today (fetch all) — degradable.
- `forceReindex`: `deleteFileState` + clear watermark before the normal flow.
- `run-ingestion.ts`: construct `RdsRepoFileStateRepository(pgPool)` and pass it
  (alongside the existing `activityStore` / `syncStateSignalSink`).

---

## Observability

Extend the existing completion log with `{ filesTotal, changed, skipped, pruned,
tier1Skip }` so a resync's incrementality is visible (mirrors the current
`embedded/skipped/pruned` line). A no-op resync should log `tier1Skip:true,
changed:0`.

## Testing (TDD)

- **048**: idempotent; table + RLS + grant + index; `last_synced_commit_sha` col.
- **RdsRepoFileStateRepository**: get→Map; upsert reflects current tree (incl. removing
  stale paths); delete clears; RLS-scoped (pg-mock).
- **Sync-state watermark**: get/set round-trip.
- **Adapter**: `listFiles` populates `blobSha` (recursive + truncated paths);
  `getHeadCommitSha` returns sha.
- **Orchestrator** (mock adapter + store):
  - first sync (empty state) → all fetched
  - Tier-1: HEAD == last + state present → zero fetches; signals still derived; prune non-destructive
  - Tier-2: one file's blobSha changed → only that fetched; unchanged skipped
  - deleted file → pruned + dropped from state
  - force-reindex → state cleared → all fetched
  - **prune called with the full included set, not the fetched subset**
  - no `fileStateRepo` wired → fetches all (degradable)
- Full `@bedrock/shared` suite green.

## Sequencing (1 PR, ordered commits)

1. Migration 048 (table + column + RLS).
2. `RdsRepoFileStateRepository` + sync-state watermark accessors (pure, tested).
3. Adapter: `blobSha` on `RepoFile` + `getHeadCommitSha` (+ truncated path).
4. Orchestrator two-tier flow + force-reindex clears state + `run-ingestion` wiring.

## Rollout

Bootstrap applies 048 → the next sync of each repo does a **full** ingest (no state
yet) that **seeds** `repo_file_state` + `last_synced_commit_sha` → **subsequent**
resyncs are incremental. No backfill. Verify via the log: a 2nd resync of an
unchanged repo shows `tier1Skip:true, changed:0, skipped:<all>`.
