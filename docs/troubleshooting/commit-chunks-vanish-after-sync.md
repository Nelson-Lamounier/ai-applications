---
title: Commit-history chunks vanish after every repo sync
type: troubleshooting
tags: [rag, pgvector, ingestion, embeddings, cost, postgres]
sources:
  - applications/shared/src/rds/implementations/RdsVectorStore.ts
  - applications/shared/src/ingestion/orchestrator/RepoIngestionOrchestrator.ts
  - applications/shared/src/ingestion/implementations/CommitChunker.ts
created: 2026-07-10
updated: 2026-07-10
---

## Symptom

Temporal retrieval ("what was I working on in May?") returns nothing.
`document_embeddings` contains zero rows under the synthetic `_commits/`
path prefix and no `history` fileClass lane — across the entire corpus —
while `repo_commits` holds the full structured commit history (1,214 rows
for one repo alone, verified on dev RDS 2026-07-09). Ingestion logs show
commit chunks being produced and embedded on every sync, yet none persist.

## Root cause

An embed-and-delete loop between the chunker and the prune phase:

1. The orchestrator appends `CommitChunker` weekly chunks — synthetic paths
   like `_commits/2026-W27.commit_history` — to the raw-chunk batch
   ([RepoIngestionOrchestrator.ts](../../applications/shared/src/ingestion/orchestrator/RepoIngestionOrchestrator.ts)).
2. The chunks are embedded on Titan and upserted into `document_embeddings`.
3. The prune phase then deletes every stored row whose `file_path` is not in
   the `knownFilePaths` whitelist — which was built **from the repository
   file tree only**, and synthetic commit paths are never in a file tree.
   Every commit chunk was deleted seconds after being embedded.
4. On the next sync the content-hash check classified those chunks as
   *missing*, so the whole lane was re-embedded — and deleted again.

The trigger was an otherwise-correct change: the incremental-sync fix that
passed the full included path set as the prune whitelist (so unchanged,
not-refetched files survive pruning) silently orphaned every path that does
not come from the tree.

## How to diagnose

```sql
-- Commit chunks present? (expect > 0 per synced repo after the fix)
SELECT repo_full_name, count(*) FROM document_embeddings
WHERE file_path LIKE '\_commits/%' GROUP BY 1;

-- Structured commits exist even when chunks are missing:
SELECT count(*) FROM repo_commits WHERE repo_full_name = '<owner/repo>';

-- Churn signature: an incremental sync of a quiet repo re-embedding far
-- more chunks than files changed (the delta is the commit lane).
SELECT agent, count(*) FROM prompt_invocations
WHERE pipeline = 'repo-sync' AND invoked_at > now() - interval '1 day'
GROUP BY 1;
```

## How to fix

Fixed in PR #458 (merge `aab8ccd`, 2026-07-10) at both levels:

1. `RdsVectorStore.pruneDeletedFiles` hard-excludes the commit lane from
   tree-based pruning — `AND NOT starts_with(file_path, $3)` with the
   `COMMIT_HISTORY_PATH_PREFIX` constant
   ([RdsVectorStore.ts](../../applications/shared/src/rds/implementations/RdsVectorStore.ts#L765-L780)).
   The lane is append-only under tree pruning; `forceReindex` and the
   empty-whitelist branch still clear it with the rest of the repo.
2. The orchestrator adds the run's commit-chunk paths to `knownFilePaths`
   so the whitelist is honest for any `IVectorStore` implementation
   ([RepoIngestionOrchestrator.ts](../../applications/shared/src/ingestion/orchestrator/RepoIngestionOrchestrator.ts#L263-L265)).
   The store-level guard also covers the commit-fetch-failure case, where
   the run produces zero commit chunks and the whitelist alone would wipe
   the stored lane.

Expect one final re-embed of the lane on each repo's first post-fix sync
(the rows are genuinely missing), then hash-stable skips.

## How to prevent

- **Synthetic-path lanes need their own lifecycle, never tree lifecycle.**
  Any chunk whose `file_path` is not a repository file (commit history,
  and any future synthetic lane) must be excluded from tree-derived
  deletion and given an explicit owner for its cleanup. The exported
  `COMMIT_HISTORY_PATH_PREFIX`
  ([CommitChunker.ts](../../applications/shared/src/ingestion/implementations/CommitChunker.ts#L38))
  is the single source of truth both sides now share.
- Tests lock the contract: prune SQL parameters, the empty-whitelist branch,
  and the `knownFilePaths` passthrough
  ([RdsVectorStore.test.ts](../../applications/shared/src/rds/implementations/RdsVectorStore.test.ts)).
- The failure was invisible because every layer succeeded individually —
  a per-lane pruned-rows metric would have surfaced "commit lane: N deleted"
  on every sync. Cost governance in fail-open pipelines has to ride on
  usage attribution, not on errors.

<!--
Evidence trail (auto-generated):
- Source: applications/shared/src/rds/implementations/RdsVectorStore.ts (read on 2026-07-10, at aab8ccd)
- Source: applications/shared/src/ingestion/orchestrator/RepoIngestionOrchestrator.ts (read on 2026-07-10)
- Live: dev RDS query — 0 rows LIKE '\_commits/%' corpus-wide vs 1,214 repo_commits rows for kubernetes-bootstrap (2026-07-09, via SSM tunnel + rds-relay)
- Live: prompt_invocations — 83 titan-embed calls on a quiet 3,545-chunk incremental sync (2026-07-08 run, read 2026-07-09)
- Commit: PR #458 (72ebb68 fix, aab8ccd merge)
-->
