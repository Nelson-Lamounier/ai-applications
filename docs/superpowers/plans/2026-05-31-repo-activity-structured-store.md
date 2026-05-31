# Repo Activity Structured Store — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist structured commits + PRs during ingestion so case-study generation reads them from the DB instead of re-fetching from the GitHub REST API.

**Architecture:** Ingestion fetches commits/PRs once, writes them to two new structured tables (`repo_commits`, `repo_pull_requests`) AND derives the existing weekly prose chunks from the same fetched commits. Case-study generation reads commits/PRs from those tables and drops all GitHub access (no `GITHUB_TOKEN`). Redis exact-cache is enabled for the jobs.

**Tech Stack:** TypeScript (Node 22), `pg` (node-postgres), Jest (ESM), Postgres + RLS, Hono (admin-api), Helm/ArgoCD (kubernetes-bootstrap).

**Spec:** `docs/superpowers/specs/2026-05-31-repo-activity-structured-store-design.md`

**Branching:** 3 PRs, each off `origin/develop` (ai-applications) or `origin/main` (kubernetes-bootstrap). PR2 depends on PR1's tables + on the in-flight PR #101 (`packContext` + `CASE_STUDY_MAX_TOKENS=32768`). Land #101 and PR1 before PR2.

---

## File Structure

**PR 1 — ai-applications (`feat/repo-activity-ingestion`, off develop):**
- Create: `applications/platform-rds-bootstrap/migrations/045_repo_commits_pulls.sql` — the two tables.
- Create: `applications/shared/src/rds/implementations/RdsRepoActivityStore.ts` — structured upserts.
- Create: `applications/shared/src/rds/implementations/RdsRepoActivityStore.test.ts`.
- Modify: `applications/shared/src/ingestion/orchestrator/RepoIngestionOrchestrator.ts` — persist commits/PRs.
- Modify: `applications/shared/src/ingestion/orchestrator/RepoIngestionOrchestrator.test.ts` (if exists; else create).
- Modify: `applications/ingestion/src/run-ingestion.ts` — construct + inject the store + repositoryId.

**PR 2 — ai-applications (`feat/case-study-read-db`, off develop, after #101 + PR1):**
- Modify: `applications/shared/src/projects/case-study-loader.ts` — DB reads, drop loaders.
- Modify: `applications/shared/src/projects/case-study-loader.test.ts` (if exists; else create).
- Modify: `applications/shared/src/projects/case-study-orchestrator.ts` — `computeInputHash` PR addition.
- Modify: `applications/shared/src/projects/case-study-orchestrator.test.ts` (if exists; else create the hash test).
- Modify: `applications/job-strategist/src/run-case-study.ts` — drop adapter/loaders.
- Modify: `applications/job-strategist/src/env-case-study.ts` — drop `GITHUB_TOKEN`.

**PR 3 — tucaken-app + kubernetes-bootstrap (`feat/case-study-cache-token`):**
- Modify: `tucaken-app/admin-api/src/routes/projects.ts` (or wherever `dispatchCaseStudyJob` builds env) — drop `GITHUB_TOKEN` from case-study Job env.
- Modify: kubernetes-bootstrap job-strategist Job spec / values — add `REDIS_CACHE_*` env.

---

## PR 1 — Ingestion writes structured commits + PRs

### Task 1: Migration 045 — repo_commits + repo_pull_requests

**Files:**
- Create: `applications/platform-rds-bootstrap/migrations/045_repo_commits_pulls.sql`

- [ ] **Step 1: Write the migration**

Create `applications/platform-rds-bootstrap/migrations/045_repo_commits_pulls.sql`:

```sql
-- 045_repo_commits_pulls.sql
--
-- Structured per-commit and per-PR storage so case-study generation can read
-- commit/PR evidence from the DB instead of re-fetching from GitHub. Ingestion
-- (and sync/resync) is the single GitHub scan; these tables are the source of
-- truth, and the existing weekly commit prose-chunks in document_embeddings are
-- derived from the same fetch.
--
-- Idempotent: IF NOT EXISTS everywhere; the bootstrap runner re-applies every
-- .sql on each boot. UNIQUE keys make resync an upsert (no dupes).

BEGIN;

CREATE TABLE IF NOT EXISTS repo_commits (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repository_id  UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    repo_full_name TEXT NOT NULL,
    sha            TEXT NOT NULL,
    author_name    TEXT NOT NULL,
    author_login   TEXT,
    authored_at    TIMESTAMPTZ NOT NULL,
    message        TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (repository_id, sha)
);

CREATE INDEX IF NOT EXISTS idx_repo_commits_lookup
    ON repo_commits (user_id, repo_full_name, authored_at DESC);

ALTER TABLE repo_commits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_repo_commits ON repo_commits;
CREATE POLICY rls_repo_commits ON repo_commits
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON repo_commits TO tucaken_app;

CREATE TABLE IF NOT EXISTS repo_pull_requests (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repository_id  UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    repo_full_name TEXT NOT NULL,
    number         INTEGER NOT NULL,
    title          TEXT NOT NULL,
    body           TEXT,
    state          TEXT NOT NULL
                   CHECK (state IN ('open', 'closed', 'merged')),
    author_login   TEXT,
    created_at_gh  TIMESTAMPTZ NOT NULL,
    merged_at      TIMESTAMPTZ,
    html_url       TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (repository_id, number)
);

CREATE INDEX IF NOT EXISTS idx_repo_pulls_lookup
    ON repo_pull_requests (user_id, repo_full_name, merged_at DESC NULLS LAST);

ALTER TABLE repo_pull_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_repo_pull_requests ON repo_pull_requests;
CREATE POLICY rls_repo_pull_requests ON repo_pull_requests
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON repo_pull_requests TO tucaken_app;

COMMIT;
```

- [ ] **Step 2: Verify it parses against a local/dev Postgres (idempotent re-run)**

If a local Postgres is available, apply twice and confirm no error on the second run:
```
psql "$PGURL" -v ON_ERROR_STOP=1 -f applications/platform-rds-bootstrap/migrations/045_repo_commits_pulls.sql
psql "$PGURL" -v ON_ERROR_STOP=1 -f applications/platform-rds-bootstrap/migrations/045_repo_commits_pulls.sql
```
Expected: `BEGIN … COMMIT` twice, no errors (the `DROP POLICY IF EXISTS` + `IF NOT EXISTS` guards make re-run a no-op). If no local PG, rely on the migration E2E test in Step 3.

- [ ] **Step 3: Run the existing migration E2E test if present**

Run: `npx tsx scripts/test-projects-migration.ts` (only if `PGHOST`/`PGUSER`/`PGPASSWORD` are set for a throwaway DB). If not runnable locally, note it and rely on the bootstrap Job at deploy time. Do NOT block the task on unavailable infra.

- [ ] **Step 4: Commit**

```bash
git add applications/platform-rds-bootstrap/migrations/045_repo_commits_pulls.sql
git commit -m "feat(rds-bootstrap): add repo_commits + repo_pull_requests (045)"
```

---

### Task 2: RdsRepoActivityStore — structured upserts

**Files:**
- Create: `applications/shared/src/rds/implementations/RdsRepoActivityStore.ts`
- Test: `applications/shared/src/rds/implementations/RdsRepoActivityStore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `applications/shared/src/rds/implementations/RdsRepoActivityStore.test.ts`. Mirrors the pg-mock pattern used across `applications/shared` (a fake pool whose `connect()` returns a client that records queries):

```ts
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { RdsRepoActivityStore } from './RdsRepoActivityStore.js';
import type { RepoCommit, RepoPullRequest } from '../../ingestion/interfaces/IRepoAdapter.js';

interface RecordedQuery { sql: string; params: unknown[] }

function fakePoolWithClient() {
    const queries: RecordedQuery[] = [];
    const client = {
        query: jest.fn<(sql: string, params?: unknown[]) => Promise<{ rowCount: number }>>(
            async (sql: string, params?: unknown[]) => {
                queries.push({ sql, params: params ?? [] });
                return { rowCount: 1 };
            },
        ),
        release: jest.fn(),
    };
    const pool = { connect: jest.fn(async () => client) };
    return { pool, client, queries };
}

const USER = '11111111-1111-1111-1111-111111111111';
const REPO_ID = '22222222-2222-2222-2222-222222222222';

function commit(sha: string): RepoCommit {
    return { sha, authorName: 'Dev', authorLogin: 'dev', authoredAt: '2026-05-31T00:00:00Z', message: 'msg ' + sha };
}
function pull(n: number): RepoPullRequest {
    return { number: n, title: 'PR ' + n, body: 'body', createdAt: '2026-05-30T00:00:00Z', mergedAt: '2026-05-31T00:00:00Z', state: 'merged', authorLogin: 'dev', htmlUrl: 'https://x/' + n };
}

describe('RdsRepoActivityStore', () => {
    let h: ReturnType<typeof fakePoolWithClient>;
    beforeEach(() => { h = fakePoolWithClient(); });

    it('upsertCommits sets RLS, inserts with ON CONFLICT, commits the tx', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = new RdsRepoActivityStore(h.pool as any);
        const n = await store.upsertCommits(USER, REPO_ID, 'o/a', [commit('a'.repeat(40)), commit('b'.repeat(40))]);
        expect(n).toBe(2);
        const sqls = h.queries.map(q => q.sql);
        expect(sqls.some(s => /set_config\('app.current_user_id'/.test(s))).toBe(true);
        expect(sqls.some(s => /INSERT INTO repo_commits/.test(s) && /ON CONFLICT \(repository_id, sha\) DO UPDATE/.test(s))).toBe(true);
        expect(sqls).toContain('COMMIT');
    });

    it('upsertCommits is a no-op for an empty array (no connect)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = new RdsRepoActivityStore(h.pool as any);
        const n = await store.upsertCommits(USER, REPO_ID, 'o/a', []);
        expect(n).toBe(0);
        expect(h.pool.connect).not.toHaveBeenCalled();
    });

    it('upsertPullRequests inserts with ON CONFLICT (repository_id, number)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = new RdsRepoActivityStore(h.pool as any);
        const n = await store.upsertPullRequests(USER, REPO_ID, 'o/a', [pull(1), pull(2)]);
        expect(n).toBe(2);
        const sqls = h.queries.map(q => q.sql);
        expect(sqls.some(s => /INSERT INTO repo_pull_requests/.test(s) && /ON CONFLICT \(repository_id, number\) DO UPDATE/.test(s))).toBe(true);
    });

    it('rolls back when the insert throws', async () => {
        h.client.query.mockImplementation(async (sql: string) => {
            if (/INSERT INTO repo_commits/.test(sql)) throw new Error('boom');
            return { rowCount: 0 };
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = new RdsRepoActivityStore(h.pool as any);
        await expect(store.upsertCommits(USER, REPO_ID, 'o/a', [commit('c'.repeat(40))])).rejects.toThrow('boom');
        expect(h.queries.map(q => q.sql)).toContain('ROLLBACK');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd applications/shared && npx jest src/rds/implementations/RdsRepoActivityStore.test.ts`
Expected: FAIL — `Cannot find module './RdsRepoActivityStore.js'`.

- [ ] **Step 3: Implement RdsRepoActivityStore**

Create `applications/shared/src/rds/implementations/RdsRepoActivityStore.ts`. Follows the exact RLS-in-transaction + batched-`VALUES` upsert pattern from `RepositoryProfileEmbeddingsRepository.ts`:

```ts
/**
 * @format
 * RdsRepoActivityStore — structured persistence of commits + pull requests.
 *
 * Written during ingestion / sync / resync. These rows are the source of
 * truth case-study generation reads (it no longer re-fetches from GitHub).
 * Upserts on the migration 045 unique keys so resync refreshes mutable
 * fields (message / state / merged_at) without creating duplicates.
 */
import type { Pool } from 'pg';

import type { RepoCommit, RepoPullRequest } from '../../ingestion/interfaces/IRepoAdapter.js';

export class RdsRepoActivityStore {
    constructor(private readonly pool: Pool) {}

    /** Upsert commits for one repo. Returns the number of rows sent. */
    async upsertCommits(
        userId: string,
        repositoryId: string,
        repoFullName: string,
        commits: readonly RepoCommit[],
    ): Promise<number> {
        if (commits.length === 0) return 0;

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);

            // 8 columns per row.
            const placeholders = commits.map((_, i) => {
                const b = i * 8;
                return `($${b + 1}::uuid, $${b + 2}::uuid, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}::timestamptz, $${b + 8})`;
            }).join(', ');

            const values: unknown[] = [];
            for (const c of commits) {
                values.push(userId, repositoryId, repoFullName, c.sha, c.authorName, c.authorLogin ?? null, c.authoredAt, c.message);
            }

            await client.query(
                `INSERT INTO repo_commits
                    (user_id, repository_id, repo_full_name, sha, author_name, author_login, authored_at, message)
                 VALUES ${placeholders}
                 ON CONFLICT (repository_id, sha) DO UPDATE
                     SET author_name = EXCLUDED.author_name,
                         author_login = EXCLUDED.author_login,
                         authored_at = EXCLUDED.authored_at,
                         message = EXCLUDED.message`,
                values,
            );

            await client.query('COMMIT');
            return commits.length;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    /** Upsert pull requests for one repo. Returns the number of rows sent. */
    async upsertPullRequests(
        userId: string,
        repositoryId: string,
        repoFullName: string,
        pulls: readonly RepoPullRequest[],
    ): Promise<number> {
        if (pulls.length === 0) return 0;

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);

            const placeholders = pulls.map((_, i) => {
                const b = i * 10;
                return `($${b + 1}::uuid, $${b + 2}::uuid, $${b + 3}, $${b + 4}::int, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}::timestamptz, $${b + 10}::timestamptz)`;
            }).join(', ');

            // 11th + 12th columns (html_url, and merged_at handled above) — see column list.
            // Columns: user_id, repository_id, repo_full_name, number, title, body, state, author_login, created_at_gh, merged_at, html_url
            // That is 11 columns, so adjust placeholder group to 11.
            const placeholders11 = pulls.map((_, i) => {
                const b = i * 11;
                return `($${b + 1}::uuid, $${b + 2}::uuid, $${b + 3}, $${b + 4}::int, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}::timestamptz, $${b + 10}::timestamptz, $${b + 11})`;
            }).join(', ');

            const values: unknown[] = [];
            for (const p of pulls) {
                values.push(userId, repositoryId, repoFullName, p.number, p.title, p.body ?? null, p.state, p.authorLogin ?? null, p.createdAt, p.mergedAt ?? null, p.htmlUrl);
            }

            await client.query(
                `INSERT INTO repo_pull_requests
                    (user_id, repository_id, repo_full_name, number, title, body, state, author_login, created_at_gh, merged_at, html_url)
                 VALUES ${placeholders11}
                 ON CONFLICT (repository_id, number) DO UPDATE
                     SET title = EXCLUDED.title,
                         body = EXCLUDED.body,
                         state = EXCLUDED.state,
                         author_login = EXCLUDED.author_login,
                         created_at_gh = EXCLUDED.created_at_gh,
                         merged_at = EXCLUDED.merged_at,
                         html_url = EXCLUDED.html_url`,
                values,
            );

            await client.query('COMMIT');
            return pulls.length;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }
}
```

> Implementer note: the commit insert uses 8 columns — delete the stray `cols`
> constant and the unused `placeholders` variant in the PR block; keep only
> `placeholders11` for PRs and the 8-placeholder group for commits. The block
> above shows both the wrong-then-right form for clarity; ship only the correct
> 8-col (commits) and 11-col (pulls) versions. Verify column count == placeholder
> count before running.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd applications/shared && npx jest src/rds/implementations/RdsRepoActivityStore.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `cd applications/shared && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add applications/shared/src/rds/implementations/RdsRepoActivityStore.ts applications/shared/src/rds/implementations/RdsRepoActivityStore.test.ts
git commit -m "feat(shared): RdsRepoActivityStore — structured commit/PR upserts"
```

---

### Task 3: Orchestrator persists commits + PRs

**Files:**
- Modify: `applications/shared/src/ingestion/orchestrator/RepoIngestionOrchestrator.ts`
- Test: `applications/shared/src/ingestion/orchestrator/RepoIngestionOrchestrator.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create/extend `applications/shared/src/ingestion/orchestrator/RepoIngestionOrchestrator.test.ts`. Inject mock adapter + a mock activity store + mock pipeline; assert the store is called with fetched commits/PRs and that chunks are still produced.

```ts
import { describe, it, expect, jest } from '@jest/globals';
import { RepoIngestionOrchestrator } from './RepoIngestionOrchestrator.js';
import type { RepoCommit, RepoPullRequest } from '../interfaces/IRepoAdapter.js';

function mockAdapter(opts: { commits: RepoCommit[]; pulls: RepoPullRequest[] }) {
    return {
        listFiles: jest.fn(async () => [] as { path: string; sizeBytes: number }[]),
        fetchFile: jest.fn(async () => ''),
        listCommits: jest.fn(async () => opts.commits),
        listPullRequests: jest.fn(async () => opts.pulls),
    };
}

const STORE = () => ({
    upsertCommits: jest.fn(async () => 0),
    upsertPullRequests: jest.fn(async () => 0),
});

const PIPELINE = () => ({
    ingestChunks: jest.fn(async () => ({ embedded: 0, skipped: 0, pruned: 0 })),
});

const FILTER = { filterWithSize: () => [] as string[] };
const CHUNKERS = {} as never;

const commit = (sha: string): RepoCommit => ({ sha, authorName: 'D', authoredAt: '2026-05-31T00:00:00Z', message: 'm' });
const pull = (n: number): RepoPullRequest => ({ number: n, title: 't', body: null, createdAt: '2026-05-30T00:00:00Z', mergedAt: null, state: 'open', authorLogin: null, htmlUrl: 'https://x/' + n });

describe('RepoIngestionOrchestrator activity persistence', () => {
    it('persists fetched commits + PRs via the activity store when provided', async () => {
        const adapter = mockAdapter({ commits: [commit('a'.repeat(40))], pulls: [pull(1)] });
        const store = STORE();
        const pipeline = PIPELINE();
        const orch = new RepoIngestionOrchestrator(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            adapter as any, FILTER as any, CHUNKERS, pipeline as any,
            { activityStore: store as any, repositoryId: 'repo-uuid' },
        );
        await orch.ingestRepo('user-uuid', 'o/a');
        expect(store.upsertCommits).toHaveBeenCalledWith('user-uuid', 'repo-uuid', 'o/a', [commit('a'.repeat(40))]);
        expect(store.upsertPullRequests).toHaveBeenCalledWith('user-uuid', 'repo-uuid', 'o/a', [pull(1)]);
        expect(adapter.listPullRequests).toHaveBeenCalled();
    });

    it('skips activity persistence (no throw) when no store is provided', async () => {
        const adapter = mockAdapter({ commits: [commit('b'.repeat(40))], pulls: [] });
        const pipeline = PIPELINE();
        const orch = new RepoIngestionOrchestrator(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            adapter as any, FILTER as any, CHUNKERS, pipeline as any,
        );
        await expect(orch.ingestRepo('user-uuid', 'o/a')).resolves.toBeDefined();
    });

    it('continues when listPullRequests throws (best-effort)', async () => {
        const adapter = mockAdapter({ commits: [commit('c'.repeat(40))], pulls: [] });
        adapter.listPullRequests = jest.fn(async () => { throw new Error('no pr scope'); });
        const store = STORE();
        const pipeline = PIPELINE();
        const orch = new RepoIngestionOrchestrator(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            adapter as any, FILTER as any, CHUNKERS, pipeline as any,
            { activityStore: store as any, repositoryId: 'repo-uuid' },
        );
        await expect(orch.ingestRepo('user-uuid', 'o/a')).resolves.toBeDefined();
        expect(store.upsertCommits).toHaveBeenCalled(); // commits still persisted
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd applications/shared && npx jest src/ingestion/orchestrator/RepoIngestionOrchestrator.test.ts`
Expected: FAIL — `activityStore`/`repositoryId` options not accepted, or `listPullRequests` never called.

- [ ] **Step 3: Add the store interface + options to the orchestrator**

In `RepoIngestionOrchestrator.ts`, add an interface near the top (after imports):

```ts
/** Structured commit/PR persistence — RdsRepoActivityStore in production. */
export interface RepoActivityStore {
    upsertCommits(userId: string, repositoryId: string, repoFullName: string, commits: readonly RepoCommit[]): Promise<number>;
    upsertPullRequests(userId: string, repositoryId: string, repoFullName: string, pulls: readonly RepoPullRequest[]): Promise<number>;
}
```

Add `RepoCommit, RepoPullRequest` to the existing `IRepoAdapter` type import. Extend `OrchestratorOptions`:

```ts
    /** When provided (with repositoryId), structured commits + PRs are persisted. */
    readonly activityStore?: RepoActivityStore;
    /** repositories.id for the repo being ingested — required to persist activity. */
    readonly repositoryId?: string;
    /** Hard cap on PRs pulled per ingestion. Default 100. */
    readonly maxPullRequests?: number;
```

Add private fields + constructor assignment:

```ts
    private readonly activityStore:   RepoActivityStore | null;
    private readonly repositoryId:    string | null;
    private readonly maxPullRequests: number;
```
```ts
        this.activityStore   = options.activityStore ?? null;
        this.repositoryId    = options.repositoryId ?? null;
        this.maxPullRequests = options.maxPullRequests ?? 100;
```

- [ ] **Step 4: Persist commits in fetchAndChunkCommits + add PR fetch/persist**

Replace `fetchAndChunkCommits` so it persists the structured commits before deriving chunks:

```ts
    private async fetchAndChunkCommits(userId: string, repoFullName: string): Promise<RawChunk[]> {
        if (!this.commitChunker) return [];
        try {
            const commits = await this.repoAdapter.listCommits(
                repoFullName,
                { maxCommits: this.maxCommits },
            );
            // Persist structured commits (source of truth) before deriving the
            // weekly prose chunks from the same in-memory fetch.
            if (this.activityStore && this.repositoryId) {
                await this.activityStore.upsertCommits(userId, this.repositoryId, repoFullName, commits);
            }
            const chunks = this.commitChunker.chunkWeekly(commits);
            console.info(
                `[RepoIngestionOrchestrator] ${repoFullName}: ` +
                `${commits.length} commits → ${chunks.length} commit-history chunks`,
            );
            return chunks;
        } catch (err) {
            console.error(
                `[RepoIngestionOrchestrator] commit history unavailable for ${repoFullName}:`,
                err,
            );
            return [];
        }
    }

    /**
     * Fetch + persist pull requests. Best-effort: PR scope may be absent on a
     * freshly-connected installation, so a failure logs and returns without
     * aborting ingestion. No chunks — PRs are read structured by case-study.
     */
    private async fetchAndPersistPulls(userId: string, repoFullName: string): Promise<void> {
        if (!this.activityStore || !this.repositoryId) return;
        if (typeof this.repoAdapter.listPullRequests !== 'function') return;
        try {
            const pulls = await this.repoAdapter.listPullRequests(
                repoFullName,
                { maxPullRequests: this.maxPullRequests },
            );
            await this.activityStore.upsertPullRequests(userId, this.repositoryId, repoFullName, pulls);
            console.info(
                `[RepoIngestionOrchestrator] ${repoFullName}: persisted ${pulls.length} pull requests`,
            );
        } catch (err) {
            console.warn(
                `[RepoIngestionOrchestrator] pull-request ingestion skipped for ${repoFullName}:`,
                err,
            );
        }
    }
```

Update the two `fetchAndChunkCommits()` call sites to pass `userId, repoFullName`:
- In `ingestRepo` (Step 3.5): `const commitChunks = await this.fetchAndChunkCommits(userId, repoFullName);` then immediately after: `await this.fetchAndPersistPulls(userId, repoFullName);`
- In `forceReindex`: `rawChunks.push(...await this.fetchAndChunkCommits(userId, repoFullName));` then `await this.fetchAndPersistPulls(userId, repoFullName);`

> Implementer note: `forceReindex(userId, repoFullName)` already has `userId` in
> scope. Confirm both call sites compile.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd applications/shared && npx jest src/ingestion/orchestrator/RepoIngestionOrchestrator.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck + full shared suite (regression)**

Run: `cd applications/shared && npx tsc --noEmit && npx jest`
Expected: tsc exit 0; all suites pass.

- [ ] **Step 7: Commit**

```bash
git add applications/shared/src/ingestion/orchestrator/RepoIngestionOrchestrator.ts applications/shared/src/ingestion/orchestrator/RepoIngestionOrchestrator.test.ts
git commit -m "feat(ingestion): persist structured commits + PRs during ingestion"
```

---

### Task 4: Wire the store into run-ingestion

**Files:**
- Modify: `applications/ingestion/src/run-ingestion.ts`

- [ ] **Step 1: Resolve repositoryId + construct the store, inject into orchestrator**

In `run-ingestion.ts`, near where `repoAdapter` / `pipeline` / `orchestrator` are built (around lines 219-245), add:

```ts
import { RdsRepoActivityStore } from '@bedrock/shared'; // or the relative path the file already uses for shared impls
```

> Implementer note: check how this file imports other shared RDS classes
> (`RdsVectorStore`, `RdsSyncStateRepository`) and follow that exact import
> style/path for `RdsRepoActivityStore`.

Resolve the repository UUID (the orchestrator needs it). Add a helper before orchestrator construction:

```ts
async function resolveRepositoryId(pool: Pool, userId: string, repoFullName: string): Promise<string | null> {
    const r = await pool.query<{ id: string }>(
        `SELECT id FROM repositories WHERE user_id = $1::uuid AND full_name = $2`,
        [userId, repoFullName],
    );
    return r.rows[0]?.id ?? null;
}
```

Then:

```ts
    const repositoryId = await resolveRepositoryId(pgPool, env.userId, env.repoFullName);
    const activityStore = new RdsRepoActivityStore(pgPool);
    const orchestrator = new RepoIngestionOrchestrator(
        repoAdapter, fileFilter, chunkerReg, pipeline,
        { activityStore, repositoryId: repositoryId ?? undefined },
    );
```

(If `repositoryId` is null the orchestrator simply skips persistence — but in
practice the `repositories` row always exists before ingestion runs, created by
admin-api. Log a warning if null.)

- [ ] **Step 2: Typecheck the ingestion app**

Run: `cd applications/ingestion && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add applications/ingestion/src/run-ingestion.ts
git commit -m "feat(ingestion): wire RdsRepoActivityStore into run-ingestion"
```

- [ ] **Step 4: Open PR 1**

```bash
git push -u origin feat/repo-activity-ingestion
gh pr create --base develop --title "feat(ingestion): persist structured commits + PRs (single GitHub scan)" --body "Implements PR1 of docs/superpowers/specs/2026-05-31-repo-activity-structured-store-design.md: migration 045 (repo_commits + repo_pull_requests), RdsRepoActivityStore, orchestrator persists commits+PRs and derives prose chunks from the same fetch. No consumer change yet."
```

---

## PR 2 — Case-study reads the DB, drops GitHub

> Branch `feat/case-study-read-db` off develop AFTER PR1 and PR #101 are merged (so `repo_commits`/`repo_pull_requests` exist and `packContext` is present).

### Task 5: Loader reads commits + PRs from the DB

**Files:**
- Modify: `applications/shared/src/projects/case-study-loader.ts`
- Test: `applications/shared/src/projects/case-study-loader.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create `applications/shared/src/projects/case-study-loader.test.ts`. Use a fake pool whose `query` returns canned rows keyed by which table the SQL hits:

```ts
import { describe, it, expect, jest } from '@jest/globals';
import { loadCaseStudyContext } from './case-study-loader.js';

function poolReturning(rowsBySql: Array<{ match: RegExp; rows: unknown[] }>) {
    return {
        query: jest.fn(async (sql: string) => {
            const hit = rowsBySql.find(r => r.match.test(sql));
            return { rows: hit ? hit.rows : [] };
        }),
    };
}

const PROJECT = 'proj-uuid';

it('loads commits + pulls from repo_commits / repo_pull_requests (no GitHub loader args)', async () => {
    const pool = poolReturning([
        { match: /FROM projects/, rows: [{ id: PROJECT, user_id: 'u', name: 'P', tagline: null, pitch: null, user_overrides: {} }] },
        { match: /FROM project_components/, rows: [{ id: 'c', name: 'Backend', kind: 'backend' }] },
        { match: /FROM project_repositories/, rows: [{ id: 'r', full_name: 'o/a', primary_language: 'TS', topics: [], tech_stack: [], default_branch: 'main' }] },
        { match: /FROM document_embeddings/, rows: [] },
        { match: /FROM repo_commits/, rows: [{ repo_full_name: 'o/a', sha: 'a'.repeat(40), author_name: 'D', authored_at: '2026-05-31T00:00:00Z', message: 'm' }] },
        { match: /FROM repo_pull_requests/, rows: [{ repo_full_name: 'o/a', number: 1, title: 't', body: null, state: 'merged', merged_at: '2026-05-31T00:00:00Z', created_at_gh: '2026-05-30T00:00:00Z', html_url: 'https://x/1' }] },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await loadCaseStudyContext(pool as any, PROJECT);
    expect(out.context.commits).toHaveLength(1);
    expect(out.context.commits[0]!.sha).toBe('a'.repeat(40));
    expect(out.context.pulls).toHaveLength(1);
    expect(out.context.pulls[0]!.number).toBe(1);
});

it('returns empty commits/pulls when the tables have no rows (graceful, no throw)', async () => {
    const pool = poolReturning([
        { match: /FROM projects/, rows: [{ id: PROJECT, user_id: 'u', name: 'P', tagline: null, pitch: null, user_overrides: {} }] },
        { match: /FROM project_components/, rows: [] },
        { match: /FROM project_repositories/, rows: [{ id: 'r', full_name: 'o/a', primary_language: null, topics: [], tech_stack: [], default_branch: 'main' }] },
        { match: /FROM document_embeddings/, rows: [] },
        { match: /FROM repo_commits/, rows: [] },
        { match: /FROM repo_pull_requests/, rows: [] },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await loadCaseStudyContext(pool as any, PROJECT);
    expect(out.context.commits).toEqual([]);
    expect(out.context.pulls).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd applications/shared && npx jest src/projects/case-study-loader.test.ts`
Expected: FAIL — `loadCaseStudyContext` still requires a `commitLoader` arg / signature mismatch.

- [ ] **Step 3: Rewrite the loader to read from the DB**

In `case-study-loader.ts`:
1. Remove the `CommitLoader` + `PullRequestLoader` interfaces and the `commitLoader` / `pullRequestLoader` params. New signature:
   ```ts
   export async function loadCaseStudyContext(
       pool: Pool,
       projectId: string,
   ): Promise<LoadCaseStudyContextResult> {
   ```
2. Replace the commit-fetch loop with a single query (after `repos` is resolved):
   ```ts
   const repoNames = repos.map((r) => r.full_name);
   const commitRows = (await pool.query<{ repo_full_name: string; sha: string; author_name: string; authored_at: Date; message: string }>(
       `SELECT repo_full_name, sha, author_name, authored_at, message
          FROM repo_commits
         WHERE user_id = $1 AND repo_full_name = ANY($2::text[])
         ORDER BY authored_at DESC`,
       [p.user_id, repoNames],
   )).rows;
   const commits = commitRows.map((r) => ({
       repoFullName: r.repo_full_name,
       sha:          r.sha,
       authoredAt:   (r.authored_at instanceof Date ? r.authored_at.toISOString() : String(r.authored_at)),
       authorName:   r.author_name,
       message:      r.message,
   }));
   ```
3. Replace the PR-fetch block with:
   ```ts
   const pullRows = (await pool.query<{ repo_full_name: string; number: number; title: string; body: string | null; state: string; merged_at: Date | null; html_url: string }>(
       `SELECT repo_full_name, number, title, body, state, merged_at, html_url
          FROM repo_pull_requests
         WHERE user_id = $1 AND repo_full_name = ANY($2::text[])
         ORDER BY merged_at DESC NULLS LAST`,
       [p.user_id, repoNames],
   )).rows;
   const pulls = pullRows.map((r) => ({
       repoFullName: r.repo_full_name,
       number:       r.number,
       title:        r.title,
       body:         r.body,
       state:        r.state as 'open' | 'closed' | 'merged',
       mergedAt:     r.merged_at ? (r.merged_at instanceof Date ? r.merged_at.toISOString() : String(r.merged_at)) : null,
       htmlUrl:      r.html_url,
   }));
   ```
4. Update the file header comment (lines 14-16) to state commits/PRs are read from `repo_commits` / `repo_pull_requests`, not GitHub.
5. Keep the `packContext` call from PR #101 unchanged.

> Implementer note: the existing `CaseStudyContext.commits`/`pulls` element
> shapes must be matched exactly — `pulls` includes `state` and `mergedAt` but
> the prompt schema (`case-study-agent.ts` SOURCE_SIGNAL_SCHEMA) only emits
> `number/title/htmlUrl/mergedAt`; the loader still carries the full shape into
> the context. Do not change `case-study-types.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd applications/shared && npx jest src/projects/case-study-loader.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/projects/case-study-loader.ts applications/shared/src/projects/case-study-loader.test.ts
git commit -m "feat(case-study): read commits + PRs from RDS, not GitHub"
```

---

### Task 6: computeInputHash includes PR identity

**Files:**
- Modify: `applications/shared/src/projects/case-study-orchestrator.ts`
- Test: `applications/shared/src/projects/case-study-orchestrator.test.ts` (create if absent — export `computeInputHash` for testing if it isn't already)

- [ ] **Step 1: Write the failing test**

If `computeInputHash` is not exported, export it. Create `applications/shared/src/projects/case-study-orchestrator.test.ts`:

```ts
import { describe, it, expect } from '@jest/globals';
import { computeInputHash } from './case-study-orchestrator.js';
import type { LoadCaseStudyContextResult } from './case-study-loader.js';

function ctx(overrides: Partial<LoadCaseStudyContextResult['context']> = {}): LoadCaseStudyContextResult {
    return {
        userId: 'u',
        context: {
            projectId: 'p', projectName: 'P', tagline: null, pitch: null, userOverrides: {},
            components: [], repositories: [{ id: 'r', fullName: 'o/a', primaryLanguage: 'TS', topics: [], techStack: [], defaultBranch: 'main' }],
            commits: [{ repoFullName: 'o/a', sha: 'a'.repeat(40), authoredAt: '2026-05-31T00:00:00Z', authorName: 'D', message: 'm' }],
            pulls: [], kbChunks: [],
            ...overrides,
        },
    };
}

it('is deterministic for identical input', () => {
    expect(computeInputHash(ctx())).toBe(computeInputHash(ctx()));
});

it('changes when a PR is added (PR identity is hashed)', () => {
    const a = computeInputHash(ctx({ pulls: [] }));
    const b = computeInputHash(ctx({ pulls: [{ repoFullName: 'o/a', number: 1, title: 't', body: null, state: 'merged', mergedAt: '2026-05-31T00:00:00Z', htmlUrl: 'https://x/1' }] }));
    expect(a).not.toBe(b);
});

it('changes when a PR state changes', () => {
    const open = computeInputHash(ctx({ pulls: [{ repoFullName: 'o/a', number: 1, title: 't', body: null, state: 'open', mergedAt: null, htmlUrl: 'https://x/1' }] }));
    const merged = computeInputHash(ctx({ pulls: [{ repoFullName: 'o/a', number: 1, title: 't', body: null, state: 'merged', mergedAt: '2026-05-31T00:00:00Z', htmlUrl: 'https://x/1' }] }));
    expect(open).not.toBe(merged);
});

it('changes when a commit SHA changes', () => {
    const a = computeInputHash(ctx());
    const b = computeInputHash(ctx({ commits: [{ repoFullName: 'o/a', sha: 'b'.repeat(40), authoredAt: '2026-05-31T00:00:00Z', authorName: 'D', message: 'm' }] }));
    expect(a).not.toBe(b);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd applications/shared && npx jest src/projects/case-study-orchestrator.test.ts`
Expected: FAIL — either `computeInputHash` not exported, or the "PR added" / "PR state" tests fail (PRs not in the hash yet).

- [ ] **Step 3: Add PR identity to computeInputHash**

In `case-study-orchestrator.ts`, ensure `computeInputHash` is `export function`, and after the existing commit-SHA loop add:

```ts
    for (const pr of c.pulls) {
        h.update(`pr:${pr.number}:${pr.state}:${pr.mergedAt ?? ''}`);
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd applications/shared && npx jest src/projects/case-study-orchestrator.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/projects/case-study-orchestrator.ts applications/shared/src/projects/case-study-orchestrator.test.ts
git commit -m "feat(case-study): hash PR identity into the cache key"
```

---

### Task 7: run-case-study drops GitHub; env drops GITHUB_TOKEN

**Files:**
- Modify: `applications/job-strategist/src/run-case-study.ts`
- Modify: `applications/job-strategist/src/env-case-study.ts`

- [ ] **Step 1: Remove the GitHub loaders + token from the entrypoint**

In `run-case-study.ts`:
- Delete `buildAdapter`, `buildCommitLoader`, `buildPullRequestLoader` and their imports (`GitHubAdapter`, etc.).
- Update the `loadCaseStudyContext` call to the new 2-arg signature (it's called inside `runCaseStudyOrchestration`, so the orchestrator's call site is what changes — see Step 2).
- Remove `githubToken` usage.

- [ ] **Step 2: Update orchestrator input to drop the loaders**

In `case-study-orchestrator.ts`, `runCaseStudyOrchestration` currently calls `loadCaseStudyContext(pool, input.projectId, input.commitLoader, input.pullRequestLoader)`. Change to `loadCaseStudyContext(pool, input.projectId)` and remove `commitLoader`/`pullRequestLoader` from `RunCaseStudyInput`.

> Implementer note: `run-case-study.ts` builds `RunCaseStudyInput`. Remove the
> `commitLoader` / `pullRequestLoader` fields there too. Grep the repo for
> `commitLoader` / `pullRequestLoader` and remove every reference.

- [ ] **Step 3: Drop GITHUB_TOKEN from env-case-study**

In `env-case-study.ts`, remove the `githubToken: required('GITHUB_TOKEN')` line and the `githubToken` field from `CaseStudyEnv`.

- [ ] **Step 4: Typecheck both workspaces + run shared suite**

Run: `cd applications/shared && npx tsc --noEmit && npx jest`
Run: `cd applications/job-strategist && npx tsc --noEmit`
Expected: tsc exit 0 both; shared suite green. (If any test references the removed loaders, update it.)

- [ ] **Step 5: Commit + open PR 2**

```bash
git add applications/job-strategist/src/run-case-study.ts applications/job-strategist/src/env-case-study.ts applications/shared/src/projects/case-study-orchestrator.ts
git commit -m "feat(case-study): drop GitHub access + GITHUB_TOKEN from generation"
git push -u origin feat/case-study-read-db
gh pr create --base develop --title "feat(case-study): read commits/PRs from RDS, drop GitHub" --body "Implements PR2 of the repo-activity spec. Depends on PR1 (tables) + #101 (packContext). Case-study now reads repo_commits/repo_pull_requests; no GitHub call, no GITHUB_TOKEN. computeInputHash includes PR identity."
```

---

## PR 3 — Cache + token wiring (tucaken-app + kubernetes-bootstrap)

### Task 8: admin-api stops injecting GITHUB_TOKEN into case-study Job

**Files:**
- Modify: `tucaken-app/admin-api/src/routes/projects.ts` (the `dispatchCaseStudyJob` env builder)

- [ ] **Step 1: Locate + remove the token env**

Grep: `cd /Users/nelsonlamounier/Desktop/portfolio/tucaken-app && grep -n "GITHUB_TOKEN" admin-api/src/routes/projects.ts`. In the case-study Job env array, remove the `{ name: 'GITHUB_TOKEN', value: … }` entry and any now-unused token generation for that dispatch path.

> Implementer note: do NOT touch the ingestion or tech-extract dispatch — they
> still need GITHUB_TOKEN. Only the case-study dispatch loses it.

- [ ] **Step 2: Typecheck**

Run: `cd /Users/nelsonlamounier/Desktop/portfolio/tucaken-app/admin-api && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add admin-api/src/routes/projects.ts
git commit -m "feat(admin-api): stop passing GITHUB_TOKEN to case-study Job"
```

### Task 9: kubernetes-bootstrap — enable Redis for job-strategist jobs

**Files:**
- Modify: the kubernetes-bootstrap chart that defines the job-strategist / case-study Job env (locate via grep).

- [ ] **Step 1: Locate the Job env + the redis-cache secret**

```
cd /Users/nelsonlamounier/Desktop/portfolio/kubernetes-bootstrap
grep -rn "job-strategist\|case-study\|REDIS_CACHE" charts/
kubectl get secret -n <ns> | grep redis-cache
```

- [ ] **Step 2: Add REDIS_CACHE_* env to the Job spec**

Add (values + template) so the case-study + clustering Jobs receive:
```yaml
- name: REDIS_CACHE_HOST
  value: "redis-cache-master.redis-cache.svc.cluster.local"
- name: REDIS_CACHE_PORT
  value: "6379"
- name: REDIS_CACHE_TLS
  value: "false"
- name: REDIS_CACHE_PASSWORD
  valueFrom:
    secretKeyRef:
      name: <redis-cache-secret>
      key: <password-key>
```

> Implementer note: match the exact secret name/key from Step 1. If admin-api
> builds the Job env imperatively (not Helm), the env goes in admin-api's
> k8s-job-builder instead — determine which during Step 1 and adapt.

- [ ] **Step 3: Commit + PR (kubernetes-bootstrap)**

```bash
git add charts/
git commit -m "feat(job-strategist): enable Redis exact-cache for case-study + clustering jobs"
git push -u origin feat/case-study-cache-token
gh pr create --base main --title "feat: enable Redis cache for job-strategist jobs + drop case-study GITHUB_TOKEN" --body "PR3 of the repo-activity spec."
```

---

## Rollout (after all 3 merge)

- [ ] Bootstrap applies migration 045 (or run the on-demand Job from the earlier work).
- [ ] Resync `cdk-monitoring` + `ai-applications` via the dev UI → populates `repo_commits` + `repo_pull_requests`.
- [ ] Regenerate the multi_repo case study → verify: content lands, `case_study_status=complete`, job logs show NO GitHub calls, and a second regenerate is a Redis cache hit (no Sonnet invocation in logs).
