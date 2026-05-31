# Incremental Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resync fetches + embeds only changed files, detected by a commit-SHA watermark (cheap gate) + per-file git blob-SHA diff (refine), costing zero extra GitHub API calls for the per-file decision.

**Architecture:** A new per-user `repo_file_state` table stores each file's git blob SHA; `repo_sync_state` gains `last_synced_commit_sha`. The adapter surfaces the blob SHA (already in the tree listing) + HEAD commit SHA. The orchestrator compares HEAD-vs-watermark then blob-vs-stored to pick files to fetch; force-reindex clears state so the same code path does a full ingest.

**Tech Stack:** TypeScript (Node 22), `pg`, Jest (ESM), Postgres + RLS, GitHub REST API.

**Spec:** `docs/superpowers/specs/2026-05-31-incremental-ingestion-design.md`

**Branch:** `feat/incremental-ingestion` off `origin/develop`.

---

## CRITICAL correctness constraint (read before Task 4)

`IngestionPipeline.ingestChunks` (line ~244) derives `currentFilePaths` from the
`rawChunks` it receives and calls `pruneDeletedFiles(userId, repo, currentFilePaths)`
— it deletes any DB chunk whose file_path is NOT in that set. Today that's safe
because every included file is always fetched → present in rawChunks.

Under incremental ingest we pass only *changed* files' chunks → unchanged files
would be absent from `currentFilePaths` → **wrongly pruned**. Fix: `ingestChunks`
gains an optional `knownFilePaths?: string[]` param. When provided, prune uses THAT
(the full current tree's included paths) instead of deriving from rawChunks. The
orchestrator passes the full included set. This is the single most important detail.

---

## File Structure

- Create: `applications/platform-rds-bootstrap/migrations/048_repo_file_state.sql`
- Create: `applications/shared/src/rds/implementations/RdsRepoFileStateRepository.ts` (+ `.test.ts`)
- Modify: `applications/shared/src/rds/implementations/RdsSyncStateRepository.ts` (+ test) — watermark accessors
- Modify: `applications/shared/src/rds/interfaces/ISyncStateRepository.ts` — watermark signatures
- Modify: `applications/shared/src/ingestion/interfaces/IRepoAdapter.ts` — `RepoFile.blobSha` + `getHeadCommitSha`
- Modify: `applications/shared/src/ingestion/implementations/GitHubAdapter.ts` (+ test) — populate blobSha, add getHeadCommitSha
- Modify: `applications/shared/src/rds/pipeline/IngestionPipeline.ts` (+ test) — `knownFilePaths` prune param
- Modify: `applications/shared/src/ingestion/orchestrator/RepoIngestionOrchestrator.ts` (+ test) — two-tier flow + force clears state
- Modify: `applications/ingestion/src/run-ingestion.ts` — wire the file-state repo

---

## Task 1: Migration 048 — repo_file_state + watermark

**Files:**
- Create: `applications/platform-rds-bootstrap/migrations/048_repo_file_state.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 048_repo_file_state.sql
--
-- Per-file git blob-SHA state for incremental resync. listFiles already returns
-- the blob SHA per file (git tree API); persisting it lets resync fetch only
-- files whose blob SHA changed, instead of re-fetching every file. The
-- last_synced_commit_sha watermark on repo_sync_state is the cheap "anything
-- changed at all" gate. Per-user RLS (this is the user's repo tree). Idempotent.

BEGIN;

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

COMMIT;
```

- [ ] **Step 2: Commit**

```bash
git add applications/platform-rds-bootstrap/migrations/048_repo_file_state.sql
git commit -m "feat(rds-bootstrap): repo_file_state + last_synced_commit_sha (048)"
```

---

## Task 2: RdsRepoFileStateRepository

**Files:**
- Create: `applications/shared/src/rds/implementations/RdsRepoFileStateRepository.ts`
- Test: `applications/shared/src/rds/implementations/RdsRepoFileStateRepository.test.ts`

Follows the RLS-in-transaction pattern of `RepositoryProfileEmbeddingsRepository`
(`BEGIN` → `SELECT set_config('app.current_user_id', $1, true)` → query → `COMMIT`,
`ROLLBACK` in catch, `release` in finally). READ that file first.

- [ ] **Step 1: Write the failing test**

Create `RdsRepoFileStateRepository.test.ts`. Fake pool whose `connect()` returns a
client recording `{sql, params}` and returning configurable rows:

```ts
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { RdsRepoFileStateRepository } from './RdsRepoFileStateRepository.js';

function fakePool(getRows: unknown[] = []) {
    const queries: { sql: string; params: unknown[] }[] = [];
    const client = {
        query: jest.fn(async (sql: string, params?: unknown[]) => {
            queries.push({ sql, params: params ?? [] });
            if (/SELECT .*FROM repo_file_state/.test(sql)) return { rows: getRows };
            return { rows: [] };
        }),
        release: jest.fn(),
    };
    return { pool: { connect: jest.fn(async () => client) }, client, queries };
}

const USER = '11111111-1111-1111-1111-111111111111';

describe('RdsRepoFileStateRepository', () => {
    it('getFileState returns a path→blob_sha Map scoped by user+repo', async () => {
        const h = fakePool([
            { file_path: 'a.ts', blob_sha: 'sha_a' },
            { file_path: 'b.ts', blob_sha: 'sha_b' },
        ]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const repo = new RdsRepoFileStateRepository(h.pool as any);
        const map = await repo.getFileState(USER, 'o/r');
        expect(map.get('a.ts')).toBe('sha_a');
        expect(map.get('b.ts')).toBe('sha_b');
        expect(map.size).toBe(2);
        const sel = h.queries.find(q => /FROM repo_file_state/.test(q.sql))!;
        expect(sel.sql).toMatch(/user_id = \$1 AND repo_full_name = \$2/);
    });

    it('getFileState returns an empty Map when no rows', async () => {
        const h = fakePool([]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const repo = new RdsRepoFileStateRepository(h.pool as any);
        expect((await repo.getFileState(USER, 'o/r')).size).toBe(0);
    });

    it('upsertFileState replaces the repo state to exactly the given files (delete-all + insert in one tx)', async () => {
        const h = fakePool();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const repo = new RdsRepoFileStateRepository(h.pool as any);
        await repo.upsertFileState(USER, 'o/r', [
            { path: 'a.ts', blobSha: 'sha_a', sizeBytes: 10 },
            { path: 'b.ts', blobSha: 'sha_b', sizeBytes: 20 },
        ]);
        const sqls = h.queries.map(q => q.sql);
        expect(sqls.some(s => /set_config\('app.current_user_id'/.test(s))).toBe(true);
        expect(sqls.some(s => /DELETE FROM repo_file_state/.test(s))).toBe(true);
        expect(sqls.some(s => /INSERT INTO repo_file_state/.test(s))).toBe(true);
        expect(sqls).toContain('COMMIT');
    });

    it('upsertFileState with [] just clears the repo state', async () => {
        const h = fakePool();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const repo = new RdsRepoFileStateRepository(h.pool as any);
        await repo.upsertFileState(USER, 'o/r', []);
        const sqls = h.queries.map(q => q.sql);
        expect(sqls.some(s => /DELETE FROM repo_file_state/.test(s))).toBe(true);
        expect(sqls.some(s => /INSERT INTO repo_file_state/.test(s))).toBe(false);
        expect(sqls).toContain('COMMIT');
    });

    it('deleteFileState removes all rows for the repo', async () => {
        const h = fakePool();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const repo = new RdsRepoFileStateRepository(h.pool as any);
        await repo.deleteFileState(USER, 'o/r');
        expect(h.queries.some(q => /DELETE FROM repo_file_state/.test(q.sql))).toBe(true);
    });

    it('rolls back when a query throws', async () => {
        const h = fakePool();
        h.client.query.mockImplementation(async (sql: string) => {
            if (/INSERT INTO repo_file_state/.test(sql)) throw new Error('boom');
            return { rows: [] };
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const repo = new RdsRepoFileStateRepository(h.pool as any);
        await expect(repo.upsertFileState(USER, 'o/r', [{ path: 'a', blobSha: 's', sizeBytes: 1 }]))
            .rejects.toThrow('boom');
        expect(h.queries.map(q => q.sql)).toContain('ROLLBACK');
    });
});
```

- [ ] **Step 2: Run — verify FAIL** (`cd applications/shared && npx jest src/rds/implementations/RdsRepoFileStateRepository.test.ts`) → module not found.

- [ ] **Step 3: Implement**

Create `RdsRepoFileStateRepository.ts`:

```ts
/** @format */
import type { Pool } from 'pg';

export interface RepoFileEntry {
    readonly path:      string;
    readonly blobSha:   string;
    readonly sizeBytes: number;
}

/**
 * Per-file git blob-SHA state for incremental resync. `upsertFileState`
 * replaces the repo's stored state to EXACTLY the given files (delete-all +
 * insert in one transaction), so after it runs the table mirrors the current
 * tree — stale paths are gone. Pruning of deleted-file *chunks* is handled
 * separately by the ingestion pipeline.
 */
export class RdsRepoFileStateRepository {
    constructor(private readonly pool: Pool) {}

    async getFileState(userId: string, repoFullName: string): Promise<Map<string, string>> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
            const { rows } = await client.query<{ file_path: string; blob_sha: string }>(
                `SELECT file_path, blob_sha FROM repo_file_state
                  WHERE user_id = $1 AND repo_full_name = $2`,
                [userId, repoFullName],
            );
            await client.query('COMMIT');
            return new Map(rows.map(r => [r.file_path, r.blob_sha]));
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async upsertFileState(userId: string, repoFullName: string, files: readonly RepoFileEntry[]): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
            await client.query(
                `DELETE FROM repo_file_state WHERE user_id = $1 AND repo_full_name = $2`,
                [userId, repoFullName],
            );
            if (files.length > 0) {
                const placeholders = files.map((_, i) => {
                    const b = i * 5;
                    return `($${b + 1}::uuid, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::int)`;
                }).join(', ');
                const values: unknown[] = [];
                for (const f of files) values.push(userId, repoFullName, f.path, f.blobSha, f.sizeBytes);
                await client.query(
                    `INSERT INTO repo_file_state
                        (user_id, repo_full_name, file_path, blob_sha, size_bytes)
                     VALUES ${placeholders}`,
                    values,
                );
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async deleteFileState(userId: string, repoFullName: string): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
            await client.query(
                `DELETE FROM repo_file_state WHERE user_id = $1 AND repo_full_name = $2`,
                [userId, repoFullName],
            );
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }
}
```

> Note: a very large repo (>~10k included files) makes one big INSERT; that's
> acceptable (matches the existing embeddings batch-insert style). If a future
> repo blows past Postgres's 65535-param limit, chunk the insert — out of scope now.

- [ ] **Step 4: Run — verify PASS** (6 tests).
- [ ] **Step 5: `npx tsc --noEmit`** → 0.
- [ ] **Step 6: Commit**

```bash
git add applications/shared/src/rds/implementations/RdsRepoFileStateRepository.ts applications/shared/src/rds/implementations/RdsRepoFileStateRepository.test.ts
git commit -m "feat(shared): RdsRepoFileStateRepository — per-file blob-SHA state"
```

---

## Task 3: Sync-state watermark accessors

**Files:**
- Modify: `applications/shared/src/rds/interfaces/ISyncStateRepository.ts`
- Modify: `applications/shared/src/rds/implementations/RdsSyncStateRepository.ts`
- Test: `applications/shared/src/rds/implementations/RdsSyncStateRepository.test.ts`

- [ ] **Step 1: Add interface signatures** to `ISyncStateRepository`:

```ts
    getLastSyncedCommitSha(userId: string, repoFullName: string): Promise<string | null>;
    setLastSyncedCommitSha(userId: string, repoFullName: string, sha: string): Promise<void>;
```

- [ ] **Step 2: Write failing tests** (extend the existing test file; mirror its mock harness — read it first):

```ts
describe('last_synced_commit_sha watermark', () => {
    it('getLastSyncedCommitSha returns the stored sha (or null)', async () => {
        // harness: mock pool.query to return [{ last_synced_commit_sha: 'abc' }]
        // assert the method returns 'abc' and the SELECT is scoped by user_id+repo_full_name
    });
    it('setLastSyncedCommitSha issues an UPDATE setting last_synced_commit_sha', async () => {
        // assert UPDATE repo_sync_state SET last_synced_commit_sha = $3 WHERE user_id=$1 AND repo_full_name=$2
    });
});
```
Implement these two tests concretely using the SAME fake-pool style already in
`RdsSyncStateRepository.test.ts` (it has a `saveArchetypeSignals` block to copy).

- [ ] **Step 3: Run — verify FAIL** (methods missing).

- [ ] **Step 4: Implement** in `RdsSyncStateRepository` (match `markPhase`'s plain
`this.pool.query` style — no explicit txn, relies on the pool RLS GUC, exactly like
the sibling methods):

```ts
    async getLastSyncedCommitSha(userId: string, repoFullName: string): Promise<string | null> {
        const { rows } = await this.pool.query<{ last_synced_commit_sha: string | null }>(
            `SELECT last_synced_commit_sha FROM repo_sync_state
              WHERE user_id = $1 AND repo_full_name = $2`,
            [userId, repoFullName],
        );
        return rows[0]?.last_synced_commit_sha ?? null;
    }

    async setLastSyncedCommitSha(userId: string, repoFullName: string, sha: string): Promise<void> {
        await this.pool.query(
            `UPDATE repo_sync_state SET last_synced_commit_sha = $3
              WHERE user_id = $1 AND repo_full_name = $2`,
            [userId, repoFullName, sha],
        );
    }
```

If a `FakeSyncState` test-double implementing `ISyncStateRepository` exists elsewhere
(e.g. `IngestionPipeline.test.ts`), add no-op impls of the two new methods so tsc passes.

- [ ] **Step 5: Run tests + `npx tsc --noEmit`** → green/0.
- [ ] **Step 6: Commit**

```bash
git add applications/shared/src/rds/interfaces/ISyncStateRepository.ts applications/shared/src/rds/implementations/RdsSyncStateRepository.ts applications/shared/src/rds/implementations/RdsSyncStateRepository.test.ts applications/shared/src/rds/pipeline/IngestionPipeline.test.ts
git commit -m "feat(shared): last_synced_commit_sha watermark accessors"
```

---

## Task 4: Adapter — blobSha on RepoFile + getHeadCommitSha

**Files:**
- Modify: `applications/shared/src/ingestion/interfaces/IRepoAdapter.ts`
- Modify: `applications/shared/src/ingestion/implementations/GitHubAdapter.ts`
- Test: `applications/shared/src/ingestion/implementations/GitHubAdapter.test.ts` (extend; create if absent)

- [ ] **Step 1: Update the interface**

In `IRepoAdapter.ts`, add to `RepoFile`:
```ts
    /** Git blob SHA from the tree listing — the per-file change key for incremental resync. */
    readonly blobSha: string;
```
Add to `IRepoAdapter`:
```ts
    /** HEAD commit SHA of the default branch — the cheap "anything changed" gate. */
    getHeadCommitSha(repoFullName: string): Promise<string>;
```

- [ ] **Step 2: Write failing tests** — extend `GitHubAdapter.test.ts` (read it for the `get` mock pattern; if no test file, create one mocking the private `get` via a thin subclass or by intercepting fetch). Two tests:
  - `listFiles` maps `item.sha` → `blobSha` on every returned file (recursive path): given a mocked tree response with `{path,type:'blob',size,sha}`, assert returned files include `blobSha`.
  - `getHeadCommitSha` returns the commit sha from `GET /repos/{repo}/commits/{branch}`.

```ts
// sketch — adapt to the file's existing mock of `this.get`
it('listFiles surfaces the git blob sha', async () => {
    // mock get(): repoInfo {default_branch:'main'}, then tree {truncated:false, tree:[{path:'a.ts',type:'blob',size:5,sha:'blob_a',url:''}]}
    const files = await adapter.listFiles('o/r');
    expect(files[0]).toMatchObject({ path: 'a.ts', sizeBytes: 5, blobSha: 'blob_a' });
});
it('getHeadCommitSha returns the default-branch HEAD sha', async () => {
    // mock get(): repoInfo {default_branch:'main'}, then commits/main → {sha:'head123'}
    expect(await adapter.getHeadCommitSha('o/r')).toBe('head123');
});
```

- [ ] **Step 3: Run — verify FAIL.**

- [ ] **Step 4: Implement** in `GitHubAdapter.ts`:

Recursive path `.map`:
```ts
                .map(item => ({
                    path:      item.path,
                    sizeBytes: item.size ?? 0,
                    blobSha:   item.sha,
                }));
```
`traverseTree` blob push:
```ts
                files.push({ path: fullPath, sizeBytes: item.size ?? 0, blobSha: item.sha });
```
Add the method (reuse the default-branch resolution already used by `listFiles`):
```ts
    async getHeadCommitSha(repoFullName: string): Promise<string> {
        const repoInfo = await this.get<{ default_branch: string }>(`/repos/${repoFullName}`);
        const commit = await this.get<{ sha: string }>(
            `/repos/${repoFullName}/commits/${repoInfo.default_branch}`,
        );
        return commit.sha;
    }
```

> Any other `IRepoAdapter` implementations or test doubles must add `blobSha` +
> `getHeadCommitSha`. Grep `implements IRepoAdapter` and fix each (likely just test mocks).

- [ ] **Step 5: Run tests + `npx tsc --noEmit`** → green/0.
- [ ] **Step 6: Commit**

```bash
git add applications/shared/src/ingestion/interfaces/IRepoAdapter.ts applications/shared/src/ingestion/implementations/GitHubAdapter.ts applications/shared/src/ingestion/implementations/GitHubAdapter.test.ts
git commit -m "feat(ingestion): surface git blob SHA + getHeadCommitSha"
```

---

## Task 5: IngestionPipeline — knownFilePaths prune param

**Files:**
- Modify: `applications/shared/src/rds/pipeline/IngestionPipeline.ts`
- Test: `applications/shared/src/rds/pipeline/IngestionPipeline.test.ts`

- [ ] **Step 1: Write failing test** — extend the existing pipeline test:

```ts
it('prunes against knownFilePaths when provided, not the rawChunks subset', async () => {
    // vectorStore.pruneDeletedFiles is a jest.fn; checkContentHashes returns all-unchanged
    // call ingestChunks(user, repo, [chunk for 'changed.ts'], { knownFilePaths: ['changed.ts','unchanged.ts'] })
    // assert pruneDeletedFiles was called with ['changed.ts','unchanged.ts'] (NOT just ['changed.ts'])
});
it('falls back to rawChunks-derived paths when knownFilePaths omitted (back-compat)', async () => {
    // call ingestChunks(user, repo, [chunk for 'a.ts']) with no opts
    // assert pruneDeletedFiles called with ['a.ts']
});
```

- [ ] **Step 2: Run — verify FAIL** (the new arg isn't honored).

- [ ] **Step 3: Implement** — add an optional opts param to `ingestChunks`:

```ts
    async ingestChunks(
        userId: string,
        repoFullName: string,
        rawChunks: RawChunk[],
        opts?: { knownFilePaths?: string[] },
    ): Promise<IngestionReport> {
```
At BOTH prune sites (lines ~244 and ~258), replace the derived set with:
```ts
        const currentFilePaths = opts?.knownFilePaths
            ?? [...new Set(rawChunks.map(c => c.filePath))];
```
(Define it once before first use; reuse for the second occurrence. Ensure both the
prune call and the report's `currentFilePaths.length` use the same variable.)

- [ ] **Step 4: Run tests + `npx tsc --noEmit`** → green/0. Run the full pipeline test file to confirm no regression in existing prune behavior.
- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/rds/pipeline/IngestionPipeline.ts applications/shared/src/rds/pipeline/IngestionPipeline.test.ts
git commit -m "feat(ingestion): ingestChunks prunes against knownFilePaths (incremental-safe)"
```

---

## Task 6: Orchestrator two-tier flow + force clears state + wiring

**Files:**
- Modify: `applications/shared/src/ingestion/orchestrator/RepoIngestionOrchestrator.ts`
- Test: `applications/shared/src/ingestion/orchestrator/RepoIngestionOrchestrator.test.ts`
- Modify: `applications/ingestion/src/run-ingestion.ts`

- [ ] **Step 1: Add the file-state dependency to OrchestratorOptions**

Mirror the existing optional `activityStore`/`syncStateSignalSink` options. Add a
structural interface + option:
```ts
export interface RepoFileStateStore {
    getFileState(userId: string, repoFullName: string): Promise<Map<string, string>>;
    upsertFileState(userId: string, repoFullName: string, files: readonly { path: string; blobSha: string; sizeBytes: number }[]): Promise<void>;
    deleteFileState(userId: string, repoFullName: string): Promise<void>;
}
// in OrchestratorOptions:
    readonly fileStateStore?: RepoFileStateStore;
```
Plus a structural type for the watermark (reuse the sync-state repo, which the
orchestrator may not currently hold — pass the two methods via a small interface):
```ts
export interface CommitWatermarkStore {
    getLastSyncedCommitSha(userId: string, repoFullName: string): Promise<string | null>;
    setLastSyncedCommitSha(userId: string, repoFullName: string, sha: string): Promise<void>;
}
// in OrchestratorOptions:
    readonly watermarkStore?: CommitWatermarkStore;
```
Private fields + constructor assignment (default null), like the existing options.

- [ ] **Step 2: Write failing tests** — extend the orchestrator test (it already mocks adapter/pipeline/fileFilter; read it). Use a mock adapter whose `listFiles` returns files WITH `blobSha`, `getHeadCommitSha` returns a sha, mock `fileStateStore` + `watermarkStore`, and a `pipeline.ingestChunks` jest.fn capturing its opts.

```ts
const FILES = [
    { path: 'a.ts', sizeBytes: 1, blobSha: 'sha_a' },
    { path: 'b.ts', sizeBytes: 1, blobSha: 'sha_b' },
];
// adapter.listFiles → FILES; adapter.getHeadCommitSha → 'head2'; fileFilter.filterWithSize → ['a.ts','b.ts']

it('first sync (empty state) fetches all files + persists state + watermark', async () => {
    // fileStateStore.getFileState → empty Map; watermark.getLastSyncedCommitSha → null
    // after ingestRepo: fetchFile called for a.ts AND b.ts; upsertFileState called with both;
    // setLastSyncedCommitSha called with 'head2'
});
it('Tier-1: HEAD unchanged + state present → zero fetches', async () => {
    // watermark.get → 'head2' (== adapter head); state has a.ts/b.ts
    // after ingestRepo: adapter.fetchFile NOT called; pipeline.ingestChunks called with [] chunks
    //   but knownFilePaths = ['a.ts','b.ts'] (prune non-destructive); signals still derived
});
it('Tier-2: one file changed → only that file fetched', async () => {
    // watermark.get → 'head1' (differs); state = {a.ts:'sha_a', b.ts:'OLD'} → b.ts changed
    // after ingestRepo: fetchFile called for b.ts only; ingestChunks knownFilePaths = ['a.ts','b.ts']
});
it('deleted file: present in state, absent from tree → not in knownFilePaths', async () => {
    // state has a.ts,b.ts,gone.ts ; tree FILES = a.ts,b.ts
    // ingestChunks knownFilePaths = ['a.ts','b.ts'] (gone.ts excluded → pipeline prunes it)
});
it('no fileStateStore wired → fetches all (degradable)', async () => {
    // construct orchestrator without fileStateStore/watermarkStore
    // ingestRepo fetches all files (today's behavior)
});
it('forceReindex clears file state + watermark then full-ingests', async () => {
    // forceReindex: deleteFileState called; setLastSyncedCommitSha NOT relied on as gate;
    // all files fetched
});
```

- [ ] **Step 3: Run — verify FAIL.**

- [ ] **Step 4: Implement the two-tier flow** in `ingestRepo`, replacing the
current "filter → fetchAndChunkFiles(allIncluded)" section. Keep
`persistArchetypeSignals(allFiles)` exactly where it is (every sync). Pseudation →
concrete:

```ts
    const allFiles = await this.repoAdapter.listFiles(repoFullName);   // now has blobSha
    await this.persistArchetypeSignals(userId, repoFullName, allFiles);

    const includedPaths = this.fileFilter.filterWithSize(allFiles);     // string[]
    const includedSet = new Set(includedPaths);
    const includedFiles = allFiles.filter(f => includedSet.has(f.path)); // {path,sizeBytes,blobSha}[]

    // ── decide which to fetch ──
    let pathsToFetch: string[] = includedPaths;          // default: all (first sync / no store)
    let tier1Skip = false;
    if (this.fileStateStore && this.watermarkStore) {
        const headSha   = await this.repoAdapter.getHeadCommitSha(repoFullName);
        const lastSha   = await this.watermarkStore.getLastSyncedCommitSha(userId, repoFullName);
        const priorState = await this.fileStateStore.getFileState(userId, repoFullName);

        if (lastSha && lastSha === headSha && priorState.size > 0) {
            pathsToFetch = [];                            // Tier 1: nothing changed
            tier1Skip = true;
        } else {
            pathsToFetch = includedFiles
                .filter(f => priorState.get(f.path) !== f.blobSha)   // new or changed
                .map(f => f.path);
        }
        // persist new state + watermark AFTER a successful run (below)
        this._pendingState = { includedFiles, headSha };  // or thread locally — see note
    }

    const rawChunks = await this.fetchAndChunkFiles(repoFullName, pathsToFetch, onFileProgress);
    // ... commit chunks + pulls as today ...
    // hand to pipeline with the FULL included set so prune is non-destructive:
    const report = await this.ingestionPipeline.ingestChunks(
        userId, repoFullName, rawChunks, { knownFilePaths: includedPaths },
    );

    if (this.fileStateStore && this.watermarkStore) {
        await this.fileStateStore.upsertFileState(userId, repoFullName,
            includedFiles.map(f => ({ path: f.path, blobSha: f.blobSha, sizeBytes: f.sizeBytes })));
        await this.watermarkStore.setLastSyncedCommitSha(userId, repoFullName, headSha);
    }
    console.info(`[RepoIngestionOrchestrator] ${repoFullName}: incremental ` +
        `total=${includedPaths.length} fetched=${pathsToFetch.length} tier1Skip=${tier1Skip}`);
    return report;
```

> Implementer notes:
> - Do NOT use an instance field for `headSha` (concurrency). Keep `headSha`/`includedFiles`
>   as locals in `ingestRepo` scope (the snippet's `this._pendingState` is illustrative only —
>   thread them as locals). 
> - `fetchAndChunkFiles` already accepts a `string[]` of paths — passing `pathsToFetch` (possibly
>   `[]`) is fine; an empty list yields `[]` chunks.
> - Commit-chunks (`fetchAndChunkCommits`) + pulls stay unconditional, as today.
> - `ingestChunks` now takes the opts param from Task 5.

- [ ] **Step 5: forceReindex** — at its top, clear state so the normal path full-ingests:
```ts
    async forceReindex(userId: string, repoFullName: string): Promise<IngestionReport> {
        if (this.fileStateStore) await this.fileStateStore.deleteFileState(userId, repoFullName);
        if (this.watermarkStore) await this.watermarkStore.setLastSyncedCommitSha(userId, repoFullName, '');
        // ... existing forceReindex body, which already lists all + fetches all ...
    }
```
(forceReindex already fetches all + calls `ingestionPipeline.forceReindex`; leave that. Just ensure it ALSO refreshes file state + watermark at the end if the stores are wired — mirror ingestRepo's tail.)

- [ ] **Step 6: Run — verify PASS** (6 orchestrator tests).

- [ ] **Step 7: Wire in run-ingestion.ts** — construct + pass the stores:
```ts
import { RdsRepoFileStateRepository } from '@bedrock/shared';   // match sibling import style
...
const fileStateStore = new RdsRepoFileStateRepository(pgPool);
const orchestrator = new RepoIngestionOrchestrator(
    repoAdapter, fileFilter, chunkerReg, pipeline,
    { /* existing: activityStore, repositoryId, syncStateSignalSink */,
      fileStateStore, watermarkStore: syncState },
);
```
(`syncState` is the existing `RdsSyncStateRepository`, which now has the watermark
methods → structurally satisfies `CommitWatermarkStore`. Export `RdsRepoFileStateRepository`
from the shared barrels, like `RdsRepoActivityStore` was.)

- [ ] **Step 8: tsc both workspaces + full shared suite**

```bash
cd applications/shared && npx tsc --noEmit && npx jest
cd ../ingestion && npx tsc --noEmit   # may need: (cd ../shared && npx tsc) first to refresh dist
```
All green / exit 0.

- [ ] **Step 9: Commit + open PR**

```bash
git add applications/shared/src/ingestion/orchestrator/RepoIngestionOrchestrator.ts applications/shared/src/ingestion/orchestrator/RepoIngestionOrchestrator.test.ts applications/shared/src/index.ts applications/shared/src/rds/index.ts applications/ingestion/src/run-ingestion.ts
git commit -m "feat(ingestion): incremental resync via blob-SHA diff + commit watermark"
git push -u origin feat/incremental-ingestion
gh pr create --base develop --title "feat(ingestion): incremental resync (blob-SHA + commit watermark)" --body "Implements docs/superpowers/specs/2026-05-31-incremental-ingestion-design.md"
```

---

## Self-review notes (addressed)

- **Prune trap** (the spec's CRITICAL point): Task 5 adds `knownFilePaths`; Task 6
  passes the full `includedPaths` so unchanged files are never pruned. Covered by a
  dedicated test in both Task 5 and Task 6.
- **Degradable**: orchestrator behaves as today when `fileStateStore`/`watermarkStore`
  absent (Task 6 test). 
- **Force-reindex**: clears state → full ingest via the same path (Task 6 test).
- **Signals every sync**: `persistArchetypeSignals(allFiles)` left in place, before the
  fetch decision.
- **Concurrency**: `headSha`/`includedFiles` are locals, not instance fields.
