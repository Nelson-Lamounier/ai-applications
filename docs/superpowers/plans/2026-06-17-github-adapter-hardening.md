# GitHub Adapter Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `GitHubAdapter` fail safely on renamed/moved/missing repos so a bad GitHub response becomes a typed, actionable error and a clean `repo_sync_state.status='error'` — never an uncaught `"batch is not iterable"` crash.

**Architecture:** Add two typed error classes in `@bedrock/shared`. Harden `GitHubAdapter.get` to follow 3xx redirects (GitHub 301s a renamed repo to `/repositories/{id}`) and throw `RepoNotFoundError` on 404. Add array/shape guards to `listFiles`/`listCommits`. Add a `resolveById` primitive (used by later rename phases). Teach the ingestion worker's `friendlyIngestionError` to map the new errors to a clear user message. PR 1 of the GitHub-repo-rename design — no schema changes.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Jest (`@jest/globals`), Node `https`. Yarn 4 workspaces (`@bedrock/shared`, `@bedrock/ingestion`).

**Spec:** `tucaken-app/docs/superpowers/specs/2026-06-17-github-repo-rename-handling-design.md` (Section 3).

---

## File structure

- **Create** `applications/shared/src/ingestion/implementations/github-errors.ts` — the two typed error classes. One responsibility: error types.
- **Create** `applications/shared/src/ingestion/implementations/github-errors.test.ts` — error class tests.
- **Modify** `applications/shared/src/index.ts:221` — export the new errors from the package barrel.
- **Modify** `applications/shared/src/ingestion/implementations/GitHubAdapter.ts` — redirect handling + 404 + shape guards + `resolveById`.
- **Modify** `applications/shared/src/ingestion/implementations/GitHubAdapter.test.ts` — shape-guard + resolveById tests (route-map seam).
- **Create** `applications/shared/src/ingestion/implementations/GitHubAdapter.http.test.ts` — redirect/404 tests via an `https` module mock (the route-map seam cannot reach inside `get`).
- **Create** `applications/ingestion/src/friendly-error.ts` — extract `friendlyIngestionError` (pure, testable; `run-ingestion.ts` runs `main()` on import so it cannot be imported in a test).
- **Create** `applications/ingestion/src/friendly-error.test.ts` — mapping tests.
- **Modify** `applications/ingestion/src/run-ingestion.ts:207-215,556` — remove the local `friendlyIngestionError`, import from `./friendly-error.js`.

---

## Task 1: Typed error classes

**Files:**
- Create: `applications/shared/src/ingestion/implementations/github-errors.ts`
- Test: `applications/shared/src/ingestion/implementations/github-errors.test.ts`
- Modify: `applications/shared/src/index.ts:221`

- [ ] **Step 1: Write the failing test**

Create `applications/shared/src/ingestion/implementations/github-errors.test.ts`:

```ts
/** @format */
import { describe, it, expect } from '@jest/globals';
import { RepoNotFoundError, GitHubResponseShapeError } from './github-errors.js';

describe('RepoNotFoundError', () => {
  it('is an Error with a stable name and the resource in the message', () => {
    const err = new RepoNotFoundError('/repos/o/r');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RepoNotFoundError);
    expect(err.name).toBe('RepoNotFoundError');
    expect(err.resource).toBe('/repos/o/r');
    expect(err.message).toContain('/repos/o/r');
  });
});

describe('GitHubResponseShapeError', () => {
  it('is an Error naming the endpoint and detail', () => {
    const err = new GitHubResponseShapeError('/repos/o/r/commits', 'expected an array');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GitHubResponseShapeError);
    expect(err.name).toBe('GitHubResponseShapeError');
    expect(err.endpoint).toBe('/repos/o/r/commits');
    expect(err.message).toContain('expected an array');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @bedrock/shared test github-errors`
Expected: FAIL — cannot find module `./github-errors.js`.

- [ ] **Step 3: Write minimal implementation**

Create `applications/shared/src/ingestion/implementations/github-errors.ts`:

```ts
/**
 * @format
 * Typed errors for the GitHub REST layer. Callers branch on these (instanceof)
 * to turn an HTTP failure into a clear, actionable status instead of crashing
 * on an unexpected response shape.
 */

/** A GitHub repo endpoint returned 404 — renamed away, deleted, or access revoked. */
export class RepoNotFoundError extends Error {
  readonly resource: string;
  constructor(resource: string) {
    super(`GitHub resource not found: ${resource} (repo renamed, deleted, or access revoked)`);
    this.name = 'RepoNotFoundError';
    this.resource = resource;
    // Preserve instanceof across transpile targets that down-level class extends.
    Object.setPrototypeOf(this, RepoNotFoundError.prototype);
  }
}

/** A GitHub response did not match the expected array/object shape (e.g. a redirect body where a list/tree was expected). */
export class GitHubResponseShapeError extends Error {
  readonly endpoint: string;
  constructor(endpoint: string, detail: string) {
    super(`GitHub API ${endpoint} returned an unexpected shape: ${detail}`);
    this.name = 'GitHubResponseShapeError';
    this.endpoint = endpoint;
    Object.setPrototypeOf(this, GitHubResponseShapeError.prototype);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace @bedrock/shared test github-errors`
Expected: PASS (2 tests).

- [ ] **Step 5: Export from the package barrel**

In `applications/shared/src/index.ts`, immediately after line 222 (`export type { GitHubRepoMeta } ...`), add:

```ts
export { RepoNotFoundError, GitHubResponseShapeError } from './ingestion/implementations/github-errors.js';
```

- [ ] **Step 6: Typecheck + commit**

Run: `yarn workspace @bedrock/shared typecheck`
Expected: exit 0.

```bash
git add applications/shared/src/ingestion/implementations/github-errors.ts \
        applications/shared/src/ingestion/implementations/github-errors.test.ts \
        applications/shared/src/index.ts
git commit -m "feat(shared): typed GitHub errors (RepoNotFoundError, GitHubResponseShapeError)"
```

---

## Task 2: Shape guard in `listFiles`

**Files:**
- Modify: `applications/shared/src/ingestion/implementations/GitHubAdapter.ts:152-171`
- Test: `applications/shared/src/ingestion/implementations/GitHubAdapter.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `applications/shared/src/ingestion/implementations/GitHubAdapter.test.ts` (the file already defines `routedAdapter` and imports `describe/it/expect`). Add an import at the top, after the existing `GitHubAdapter` import:

```ts
import { GitHubResponseShapeError } from './github-errors.js';
```

Then add:

```ts
describe('GitHubAdapter.listFiles shape guard', () => {
  it('throws GitHubResponseShapeError when the tree response has no tree array', async () => {
    // A renamed repo 301-redirects; if the body leaks through it looks like
    // { message, url } — no `tree`. Must not crash on `.tree.filter`.
    const adapter = routedAdapter({
      '/repos/o/r': { default_branch: 'main' },
      '/repos/o/r/git/trees/main?recursive=1': { message: 'Moved Permanently', url: 'https://api.github.com/repositories/42' },
    });

    await expect(adapter.listFiles('o/r')).rejects.toBeInstanceOf(GitHubResponseShapeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @bedrock/shared test GitHubAdapter`
Expected: FAIL — currently throws `TypeError: Cannot read properties of undefined (reading 'filter')`, not `GitHubResponseShapeError`.

- [ ] **Step 3: Add the guard**

In `applications/shared/src/ingestion/implementations/GitHubAdapter.ts`, add the import near the top (after the `IRepoAdapter` import block, around line 36):

```ts
import { RepoNotFoundError, GitHubResponseShapeError } from './github-errors.js';
```

Then in `listFiles`, immediately after the `const tree = await this.get<GitHubTreeResponse>(...)` call (currently line 159-161) and before `if (!tree.truncated)`:

```ts
        if (!tree || !Array.isArray(tree.tree)) {
            throw new GitHubResponseShapeError(
                `/repos/${repoFullName}/git/trees`,
                'response had no tree array (repo may be renamed, moved, or empty)',
            );
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace @bedrock/shared test GitHubAdapter`
Expected: PASS (existing listFiles/getHeadCommitSha tests + the new guard test).

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/ingestion/implementations/GitHubAdapter.ts \
        applications/shared/src/ingestion/implementations/GitHubAdapter.test.ts
git commit -m "fix(shared): guard listFiles against non-tree GitHub responses"
```

---

## Task 3: Shape guard in `listCommits`

**Files:**
- Modify: `applications/shared/src/ingestion/implementations/GitHubAdapter.ts:311-315`
- Test: `applications/shared/src/ingestion/implementations/GitHubAdapter.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `GitHubAdapter.test.ts`:

```ts
describe('GitHubAdapter.listCommits shape guard', () => {
  it('throws GitHubResponseShapeError when the commits response is not an array', async () => {
    const adapter = routedAdapter({
      '/repos/o/r': { default_branch: 'main' },
      '/repos/o/r/commits?sha=main&per_page=100&page=1': { message: 'Moved Permanently', url: 'https://api.github.com/repositories/42' },
    });

    await expect(adapter.listCommits('o/r')).rejects.toBeInstanceOf(GitHubResponseShapeError);
  });

  it('still lists commits for a valid array response', async () => {
    const adapter = routedAdapter({
      '/repos/o/r': { default_branch: 'main' },
      '/repos/o/r/commits?sha=main&per_page=100&page=1': [
        { sha: 'c1', author: { login: 'me' }, commit: { message: 'init', author: { name: 'Me', date: '2026-01-01T00:00:00Z' } } },
      ],
    });

    const commits = await adapter.listCommits('o/r');
    expect(commits[0]).toMatchObject({ sha: 'c1', authorLogin: 'me', message: 'init' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @bedrock/shared test GitHubAdapter`
Expected: FAIL on the first new case — currently throws `TypeError: batch is not iterable`, not `GitHubResponseShapeError`.

- [ ] **Step 3: Add the guard**

In `listCommits`, replace the existing `if (batch.length === 0) break;` (line 315) with:

```ts
            if (!Array.isArray(batch)) {
                throw new GitHubResponseShapeError(
                    `/repos/${repoFullName}/commits`,
                    'expected an array of commits (repo may be renamed or moved)',
                );
            }
            if (batch.length === 0) break;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace @bedrock/shared test GitHubAdapter`
Expected: PASS (both new cases + existing).

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/ingestion/implementations/GitHubAdapter.ts \
        applications/shared/src/ingestion/implementations/GitHubAdapter.test.ts
git commit -m "fix(shared): guard listCommits against non-array GitHub responses"
```

---

## Task 4: `resolveById` primitive

**Files:**
- Modify: `applications/shared/src/ingestion/implementations/GitHubAdapter.ts` (add method after `getRepoMeta`, ~line 426)
- Test: `applications/shared/src/ingestion/implementations/GitHubAdapter.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `GitHubAdapter.test.ts`:

```ts
describe('GitHubAdapter.resolveById', () => {
  it('resolves a repo by immutable GitHub id to its current full_name', async () => {
    const adapter = routedAdapter({
      '/repositories/42': { id: 42, full_name: 'o/renamed', default_branch: 'main' },
    });

    await expect(adapter.resolveById(42)).resolves.toEqual({
      id: 42, fullName: 'o/renamed', defaultBranch: 'main',
    });
  });

  it('throws GitHubResponseShapeError when full_name is missing', async () => {
    const adapter = routedAdapter({ '/repositories/42': { id: 42 } });
    await expect(adapter.resolveById(42)).rejects.toBeInstanceOf(GitHubResponseShapeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @bedrock/shared test GitHubAdapter`
Expected: FAIL — `adapter.resolveById is not a function`.

- [ ] **Step 3: Implement the method**

In `GitHubAdapter.ts`, add after `getRepoMeta` (after line 426, before the `// Private` section):

```ts
    // =========================================================================
    // GitHubAdapter.resolveById — current identity from the immutable repo id
    // =========================================================================

    /**
     * Resolve a repo by its immutable GitHub numeric id. `GET /repositories/{id}`
     * always returns the *current* full_name even after a rename/transfer, so this
     * is the rename-proof way to discover where a connected repo now lives.
     */
    async resolveById(githubRepoId: number): Promise<{ id: number; fullName: string; defaultBranch: string }> {
        const data = await this.get<{ id: number; full_name: string; default_branch: string }>(
            `/repositories/${githubRepoId}`,
        );
        if (!data || typeof data.full_name !== 'string') {
            throw new GitHubResponseShapeError(
                `/repositories/${githubRepoId}`,
                'response had no full_name',
            );
        }
        return { id: data.id, fullName: data.full_name, defaultBranch: data.default_branch };
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace @bedrock/shared test GitHubAdapter`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/ingestion/implementations/GitHubAdapter.ts \
        applications/shared/src/ingestion/implementations/GitHubAdapter.test.ts
git commit -m "feat(shared): add GitHubAdapter.resolveById for rename-proof identity"
```

---

## Task 5: Redirect following + 404 in `get` (the crash fix)

This is the HTTP layer. The route-map seam cannot reach inside `get`, so this task mocks the `https` module. `get` is refactored to `getWithHops(path, hops)` so redirects are bounded.

**Files:**
- Modify: `applications/shared/src/ingestion/implementations/GitHubAdapter.ts:432-471`
- Test: `applications/shared/src/ingestion/implementations/GitHubAdapter.http.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `applications/shared/src/ingestion/implementations/GitHubAdapter.http.test.ts`:

```ts
/**
 * @format
 * GitHubAdapter HTTP layer — redirect following + 404 mapping.
 * The route-map seam (GitHubAdapter.test.ts) replaces `get` wholesale and so
 * cannot exercise the redirect/404 logic that lives *inside* `get`. Here we mock
 * the `https` module to drive that logic directly.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { EventEmitter } from 'node:events';

// Each queued entry is the response for the next https.request call, in order.
type FakeResponse = { statusCode: number; headers: Record<string, string>; body: string };
const responseQueue: FakeResponse[] = [];
const requestedPaths: string[] = [];

jest.mock('https', () => ({
  __esModule: true,
  default: {
    request: (options: { path: string }, cb: (res: EventEmitter & { statusCode: number; headers: Record<string, string> }) => void) => {
      requestedPaths.push(options.path);
      const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string> };
      const next = responseQueue.shift() ?? { statusCode: 500, headers: {}, body: '' };
      res.statusCode = next.statusCode;
      res.headers = next.headers;
      const req = new EventEmitter() as EventEmitter & { end: () => void };
      req.end = () => {
        // Emit asynchronously, like the real socket.
        setImmediate(() => {
          cb(res);
          res.emit('data', Buffer.from(next.body));
          res.emit('end');
        });
      };
      return req;
    },
  },
}));

// Import AFTER the mock is registered.
const { GitHubAdapter } = await import('./GitHubAdapter.js');
const { RepoNotFoundError, GitHubResponseShapeError } = await import('./github-errors.js');

// `get` is private; reach it through the same cast the route-map test uses.
function callGet(path: string): Promise<unknown> {
  const adapter = new GitHubAdapter('test-token');
  return (adapter as unknown as { get<T>(p: string): Promise<T> }).get(path);
}

beforeEach(() => {
  responseQueue.length = 0;
  requestedPaths.length = 0;
});

describe('GitHubAdapter.get redirect + 404 handling', () => {
  it('follows a 301 to the canonical /repositories/{id} and returns its body', async () => {
    responseQueue.push({ statusCode: 301, headers: { location: 'https://api.github.com/repositories/42' }, body: '{"message":"Moved Permanently"}' });
    responseQueue.push({ statusCode: 200, headers: {}, body: '{"id":42,"full_name":"o/renamed"}' });

    await expect(callGet('/repos/o/old')).resolves.toEqual({ id: 42, full_name: 'o/renamed' });
    expect(requestedPaths).toEqual(['/repos/o/old', '/repositories/42']);
  });

  it('throws RepoNotFoundError on a true 404', async () => {
    responseQueue.push({ statusCode: 404, headers: {}, body: '{"message":"Not Found"}' });
    await expect(callGet('/repos/o/missing')).rejects.toBeInstanceOf(RepoNotFoundError);
  });

  it('stops after the redirect cap and throws GitHubResponseShapeError', async () => {
    for (let i = 0; i < 5; i++) {
      responseQueue.push({ statusCode: 301, headers: { location: `https://api.github.com/loop/${i}` }, body: '{}' });
    }
    await expect(callGet('/repos/o/loop')).rejects.toBeInstanceOf(GitHubResponseShapeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @bedrock/shared test GitHubAdapter.http`
Expected: FAIL — current `get` resolves the 301 body (no redirect follow), so the first case returns `{message:...}` and the 404 case throws a generic `Error`, not the typed ones.

- [ ] **Step 3: Implement redirect + 404 handling**

In `GitHubAdapter.ts`, just above the class (after the `SKIP_DIRS` const, ~line 113) add:

```ts
/** Max redirect hops `get` will follow before giving up (GitHub renames 301 once). */
const MAX_REDIRECTS = 3;

/** Reduce a redirect Location (absolute api.github.com URL or relative path) to a request path. */
function redirectPath(location: string): string | null {
    try {
        const u = new URL(location);
        if (u.hostname !== 'api.github.com') return null; // never follow off-host
        return u.pathname + u.search;
    } catch {
        return location.startsWith('/') ? location : `/${location}`;
    }
}
```

Then replace the entire `private get<T>(path: string)` method (lines 432-471) with:

```ts
    private get<T>(path: string): Promise<T> {
        return this.getWithHops<T>(path, 0);
    }

    private getWithHops<T>(path: string, hops: number): Promise<T> {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: this.apiBase,
                path,
                method:   'GET',
                headers:  {
                    'Authorization': `Bearer ${this.token}`,
                    'User-Agent':    'portfolio-ingestion/1.0',
                    'Accept':        'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            };

            const req = https.request(options, res => {
                const chunks: Buffer[] = [];

                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    const status = res.statusCode ?? 0;
                    const body = Buffer.concat(chunks).toString('utf-8');

                    // GitHub 301s a renamed/moved repo to /repositories/{id}.
                    if (status >= 300 && status < 400) {
                        const location = res.headers.location;
                        const nextPath = location ? redirectPath(location) : null;
                        if (nextPath && hops < MAX_REDIRECTS) {
                            resolve(this.getWithHops<T>(nextPath, hops + 1));
                            return;
                        }
                        reject(new GitHubResponseShapeError(
                            path,
                            `redirect (${status}) not followed (no usable Location or hop cap reached)`,
                        ));
                        return;
                    }

                    if (status === 404) {
                        reject(new RepoNotFoundError(path));
                        return;
                    }

                    if (status >= 400) {
                        reject(new Error(`GitHub API ${path} returned ${status}: ${body}`));
                        return;
                    }

                    try {
                        resolve(JSON.parse(body) as T);
                    } catch {
                        reject(new Error(`GitHub API ${path}: invalid JSON response`));
                    }
                });
            });

            req.on('error', reject);
            req.end();
        });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace @bedrock/shared test GitHubAdapter.http`
Expected: PASS (3 cases).

- [ ] **Step 5: Run the whole adapter suite + typecheck**

Run: `yarn workspace @bedrock/shared test GitHubAdapter && yarn workspace @bedrock/shared typecheck`
Expected: PASS, exit 0 (route-map tests still pass — they replace `get` and are unaffected).

- [ ] **Step 6: Commit**

```bash
git add applications/shared/src/ingestion/implementations/GitHubAdapter.ts \
        applications/shared/src/ingestion/implementations/GitHubAdapter.http.test.ts
git commit -m "fix(shared): follow GitHub redirects, throw RepoNotFoundError on 404"
```

---

## Task 6: Map typed errors to a friendly ingestion status

`friendlyIngestionError` lives in `run-ingestion.ts`, which runs `main()` on import (line ~597) and so cannot be imported by a test. Extract it to a pure module, extend it, and re-import.

**Files:**
- Create: `applications/ingestion/src/friendly-error.ts`
- Create: `applications/ingestion/src/friendly-error.test.ts`
- Modify: `applications/ingestion/src/run-ingestion.ts:207-215` (remove local def), `:556` (call stays; import added)

- [ ] **Step 1: Write the failing test**

Create `applications/ingestion/src/friendly-error.test.ts`:

```ts
/** @format */
import { describe, it, expect } from '@jest/globals';
import { RepoNotFoundError, GitHubResponseShapeError } from '@bedrock/shared';
import { friendlyIngestionError } from './friendly-error.js';

describe('friendlyIngestionError', () => {
  it('explains a renamed/missing repo for RepoNotFoundError', () => {
    const msg = friendlyIngestionError(new RepoNotFoundError('/repos/o/r'));
    expect(msg.toLowerCase()).toContain('renamed');
  });

  it('gives a retry message for an unexpected GitHub response shape', () => {
    const msg = friendlyIngestionError(new GitHubResponseShapeError('/repos/o/r/commits', 'x'));
    expect(msg.toLowerCase()).toContain('try again');
  });

  it('falls back to a generic message for unknown errors', () => {
    expect(friendlyIngestionError(new Error('boom'))).toContain("didn't finish");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @bedrock/ingestion test friendly-error`
Expected: FAIL — cannot find module `./friendly-error.js`.

- [ ] **Step 3: Create the pure module**

First, find the `ProfileExtractionError` import in `run-ingestion.ts` (used by the existing helper):

Run: `grep -n "ProfileExtractionError" applications/ingestion/src/run-ingestion.ts`
Note the import source (it is imported near the top of `run-ingestion.ts`). Use that same source path in the new module's import below.

Create `applications/ingestion/src/friendly-error.ts`:

```ts
/**
 * @format
 * Maps an ingestion failure to a short, user-facing status message persisted to
 * repo_sync_state. Pure + import-safe (run-ingestion.ts runs main() on import,
 * so this lives separately to stay testable).
 */
import { RepoNotFoundError, GitHubResponseShapeError } from '@bedrock/shared';
import { ProfileExtractionError } from './agents/ProfileExtractor.js'; // adjust to the path grep reported

export function friendlyIngestionError(err: unknown): string {
  if (err instanceof RepoNotFoundError) {
    return "This repository couldn't be found on GitHub — it may have been renamed, deleted, or access revoked. Reconnect it and try again.";
  }
  if (err instanceof GitHubResponseShapeError) {
    return "GitHub returned an unexpected response for this repository. Please try again in a few minutes.";
  }
  if (err instanceof ProfileExtractionError) {
    if (err.code === 'bedrock_error') {
      return "We couldn't analyze this repository right now. Please try again in a few minutes.";
    }
    return "We couldn't build a profile for this repository. Please try again.";
  }
  return "Indexing didn't finish for this repository. Please try again.";
}
```

NOTE: set the `ProfileExtractionError` import path to exactly what the Step-3 grep reported (it is already imported in `run-ingestion.ts`; reuse that specifier).

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace @bedrock/ingestion test friendly-error`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire run-ingestion to the extracted module**

In `applications/ingestion/src/run-ingestion.ts`:
1. Delete the local `friendlyIngestionError` function (lines 207-215).
2. Add to the import block near the top:

```ts
import { friendlyIngestionError } from './friendly-error.js';
```

3. If `ProfileExtractionError` is now unused in `run-ingestion.ts` after the deletion, remove its import (run `yarn workspace @bedrock/ingestion typecheck` — it will flag an unused import as an error under this repo's config; if so, delete that import line). The call site at line ~556 (`const friendly = friendlyIngestionError(err);`) is unchanged.

- [ ] **Step 6: Typecheck + commit**

Run: `yarn workspace @bedrock/ingestion typecheck`
Expected: exit 0.

```bash
git add applications/ingestion/src/friendly-error.ts \
        applications/ingestion/src/friendly-error.test.ts \
        applications/ingestion/src/run-ingestion.ts
git commit -m "feat(ingestion): friendly status for renamed/missing repos"
```

---

## Task 7: Full verification

- [ ] **Step 1: Run both workspaces' suites + typecheck**

Run:
```bash
yarn workspace @bedrock/shared typecheck && yarn workspace @bedrock/shared test
yarn workspace @bedrock/ingestion typecheck && yarn workspace @bedrock/ingestion test
```
Expected: all PASS (shared adds github-errors + http + 2 adapter guard tests + resolveById; ingestion adds friendly-error).

- [ ] **Step 2: Lint the changed files**

Run:
```bash
yarn eslint applications/shared/src/ingestion/implementations/github-errors.ts \
            applications/shared/src/ingestion/implementations/GitHubAdapter.ts \
            applications/ingestion/src/friendly-error.ts \
            applications/ingestion/src/run-ingestion.ts
```
Expected: 0 errors.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin <branch>
gh pr create --base develop --title "fix(ingestion): harden GitHubAdapter against renamed/missing repos" \
  --body "PR 1 of GitHub repo rename handling (spec Section 3). Follows GitHub redirects, throws RepoNotFoundError on 404, guards listFiles/listCommits shapes, adds resolveById, and maps the typed errors to a clear repo_sync_state status. No schema changes."
```

---

## Self-review notes

- **Spec coverage (Section 3):** redirect handling (Task 5), `RepoNotFoundError` on 404 (Task 5), shape guards (Tasks 2-3), `resolveById` (Task 4), graceful `repo_sync_state.status='error'` via `friendlyIngestionError` (Task 6). All covered.
- **Type consistency:** `RepoNotFoundError(resource)` / `GitHubResponseShapeError(endpoint, detail)` used identically across Tasks 1-6. `resolveById` returns `{ id, fullName, defaultBranch }` in Task 4 and is not re-shaped elsewhere in this PR.
- **No schema changes** — re-key migrations are PR 2+ (later phases).
- **Adjust-to-reality hooks:** Task 6 Step 3/5 explicitly grep for the real `ProfileExtractionError` import path rather than hard-coding a possibly-wrong specifier.
