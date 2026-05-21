# Internal GitHub App Revoke Endpoint Implementation Plan (PR-2c of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pure `revokeInstallation` HTTP client in `@bedrock/shared/github` and a `POST /internal/revoke-github` route in public-api that admin-api calls when a user soft-deletes. The route looks up the GitHub `oauth_connections` row, signs a GitHub App JWT, calls `DELETE /app/installations/{id}`, and `markRevoked()`s the row.

**Architecture:** Bearer-token auth via timing-safe compare against a new `internalApiToken` field added to the existing GitHub App Secrets Manager JSON. Thin orchestration in the route — every concern (HTTP, JWT signing, DB, secrets) is a pure helper. Synchronous: handler does the GitHub call inline; admin-api retries on 5xx.

**Tech Stack:** TypeScript, Node 22, `node:crypto` (`timingSafeEqual`, `AbortController`), `fetch`, Hono on Node, AWS SDK v3 (`@aws-sdk/client-secrets-manager`), Jest.

**Spec:** [docs/superpowers/specs/2026-05-21-internal-github-app-revoke-design.md](../specs/2026-05-21-internal-github-app-revoke-design.md)

**Branch base:** `oauth-github-webhook` (PR-2b). Once PR-2b merges to `develop`, rebase this branch onto `develop`.

---

## File Structure

**Create:**
- `applications/shared/src/github/revokeInstallation.ts` — pure HTTP client
- `applications/shared/src/github/revokeInstallation.test.ts`
- `api/public-api/src/routes/internal-revoke-github.ts` — Hono route
- `api/public-api/__tests__/routes/internal-revoke-github.test.ts`

**Modify:**
- `applications/shared/src/github/index.ts` — export `revokeInstallation` + types
- `applications/shared/src/index.ts` — re-export from github barrel
- `api/public-api/src/lib/githubAppSecrets.ts` — add `internalApiToken` field + validation
- `api/public-api/__tests__/lib/githubAppSecrets.test.ts` — fixture + new missing-field test
- `api/public-api/src/index.ts` — mount the new route

---

## Task 1: `revokeInstallation` — failing test

**Files:**
- Create: `applications/shared/src/github/revokeInstallation.test.ts`

- [ ] **Step 1: Write the failing test file**

```ts
// applications/shared/src/github/revokeInstallation.test.ts
import { describe, it, expect, jest } from '@jest/globals';
import { revokeInstallation } from './revokeInstallation.js';

function fakeFetch(response: { status: number; bodyText?: string }) {
    return jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
        return new Response(response.bodyText ?? '', { status: response.status }) as Response;
    });
}

describe('revokeInstallation', () => {
    it('204 → { ok: true, status: 204, alreadyDeleted: false } and uses the right URL + headers', async () => {
        const f = fakeFetch({ status: 204 });
        const res = await revokeInstallation({
            installationId: 'inst-42',
            jwt:            'jwt.payload.sig',
            fetch:          f as unknown as typeof globalThis.fetch,
        });
        expect(res).toEqual({ ok: true, status: 204, alreadyDeleted: false });

        expect(f).toHaveBeenCalledTimes(1);
        const [url, init] = f.mock.calls[0]!;
        expect(String(url)).toBe('https://api.github.com/app/installations/inst-42');
        expect((init as RequestInit).method).toBe('DELETE');
        const headers = (init as RequestInit).headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer jwt.payload.sig');
        expect(headers['Accept']).toBe('application/vnd.github+json');
        expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
        expect(headers['User-Agent']).toBe('ai-applications/oauth-revoke');
    });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications/.claude/worktrees/oauth-soft-delete-revoke && yarn workspace @bedrock/shared run test src/github/revokeInstallation.test.ts`
Expected: FAIL — `Cannot find module './revokeInstallation.js'`.

- [ ] **Step 3: Commit**

```bash
git add applications/shared/src/github/revokeInstallation.test.ts
git commit -m "test(github): failing happy-path for revokeInstallation"
```

NO Co-Authored-By trailer (memory: `feedback_no_coauthored.md`).

---

## Task 2: `revokeInstallation` — implementation

**Files:**
- Create: `applications/shared/src/github/revokeInstallation.ts`

- [ ] **Step 1: Write the implementation**

```ts
// applications/shared/src/github/revokeInstallation.ts
/**
 * @format
 * Calls GitHub's `DELETE /app/installations/{id}` to revoke a GitHub App
 * installation.
 *
 * Pure HTTP client. The caller signs the App JWT (see signGitHubAppJwt)
 * and passes it in. The helper returns a discriminated union so the caller
 * decides whether 404 is a success or a real failure — for our revoke flow,
 * 404 means "already gone" which is a success.
 *
 * Reusable by any path that needs to revoke an installation (PR-3 ingestion
 * could too).
 */

export interface RevokeInstallationOpts {
    installationId: string;
    jwt:            string;
    /** Test seam — defaults to globalThis.fetch. */
    fetch?:         typeof globalThis.fetch;
    /** Test seam — defaults to 'https://api.github.com'. */
    githubBaseUrl?: string;
    /** Abort the request after this many ms; default 10_000. */
    timeoutMs?:     number;
}

export type RevokeInstallationResult =
    | { ok: true;  status: 204 | 404; alreadyDeleted: boolean }
    | { ok: false; status: number;    body: string };

export async function revokeInstallation(opts: RevokeInstallationOpts): Promise<RevokeInstallationResult> {
    const base = opts.githubBaseUrl ?? 'https://api.github.com';
    const url  = `${base}/app/installations/${encodeURIComponent(opts.installationId)}`;
    const f    = opts.fetch ?? globalThis.fetch;

    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
    try {
        const res = await f(url, {
            method:  'DELETE',
            headers: {
                'Accept':              'application/vnd.github+json',
                'Authorization':       `Bearer ${opts.jwt}`,
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent':          'ai-applications/oauth-revoke',
            },
            signal: ctrl.signal,
        });

        if (res.status === 204) return { ok: true, status: 204, alreadyDeleted: false };
        if (res.status === 404) return { ok: true, status: 404, alreadyDeleted: true  };

        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, body: body.slice(0, 500) };
    } finally {
        clearTimeout(t);
    }
}
```

- [ ] **Step 2: Run the test, verify PASS**

Run: `yarn workspace @bedrock/shared run test src/github/revokeInstallation.test.ts`
Expected: 1 PASS.

- [ ] **Step 3: Typecheck**

Run: `yarn workspace @bedrock/shared run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add applications/shared/src/github/revokeInstallation.ts
git commit -m "feat(github): revokeInstallation — DELETE /app/installations/{id} client"
```

---

## Task 3: `revokeInstallation` — additional coverage

**Files:**
- Modify: `applications/shared/src/github/revokeInstallation.test.ts`

- [ ] **Step 1: Append the remaining 6 tests inside the existing `describe`**

Append before the closing `});` of the existing `describe('revokeInstallation', …)`:

```ts
    it('404 → { ok: true, status: 404, alreadyDeleted: true }', async () => {
        const f = fakeFetch({ status: 404, bodyText: 'Not Found' });
        const res = await revokeInstallation({
            installationId: 'gone',
            jwt:            'x',
            fetch:          f as unknown as typeof globalThis.fetch,
        });
        expect(res).toEqual({ ok: true, status: 404, alreadyDeleted: true });
    });

    it('403 → { ok: false, status: 403, body: <truncated text> }', async () => {
        const f = fakeFetch({ status: 403, bodyText: 'Forbidden because reasons' });
        const res = await revokeInstallation({
            installationId: 'x',
            jwt:            'x',
            fetch:          f as unknown as typeof globalThis.fetch,
        });
        expect(res).toEqual({ ok: false, status: 403, body: 'Forbidden because reasons' });
    });

    it('500 → { ok: false, status: 500, body }', async () => {
        const f = fakeFetch({ status: 500, bodyText: 'boom' });
        const res = await revokeInstallation({
            installationId: 'x',
            jwt:            'x',
            fetch:          f as unknown as typeof globalThis.fetch,
        });
        expect(res).toEqual({ ok: false, status: 500, body: 'boom' });
    });

    it('truncates long error bodies to 500 chars', async () => {
        const big = 'x'.repeat(2000);
        const f = fakeFetch({ status: 502, bodyText: big });
        const res = await revokeInstallation({
            installationId: 'x',
            jwt:            'x',
            fetch:          f as unknown as typeof globalThis.fetch,
        });
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.body.length).toBe(500);
            expect(res.body).toBe('x'.repeat(500));
        }
    });

    it('honors a custom githubBaseUrl', async () => {
        const f = fakeFetch({ status: 204 });
        await revokeInstallation({
            installationId: 'inst-1',
            jwt:            'x',
            fetch:          f as unknown as typeof globalThis.fetch,
            githubBaseUrl:  'https://github.test',
        });
        const [url] = f.mock.calls[0]!;
        expect(String(url)).toBe('https://github.test/app/installations/inst-1');
    });

    it('aborts on timeout', async () => {
        // A fetch that never resolves, but respects AbortSignal.
        const slowFetch = jest.fn((_url: string | URL | Request, init?: RequestInit) => {
            return new Promise<Response>((_, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    const err = new Error('aborted') as Error & { name: string };
                    err.name = 'AbortError';
                    reject(err);
                });
            });
        });

        await expect(revokeInstallation({
            installationId: 'x',
            jwt:            'x',
            fetch:          slowFetch as unknown as typeof globalThis.fetch,
            timeoutMs:      50,
        })).rejects.toMatchObject({ name: 'AbortError' });
    });
```

- [ ] **Step 2: Run the file**

Run: `yarn workspace @bedrock/shared run test src/github/revokeInstallation.test.ts`
Expected: 7 PASS.

- [ ] **Step 3: Commit**

```bash
git add applications/shared/src/github/revokeInstallation.test.ts
git commit -m "test(github): 404, 4xx/5xx, body truncation, base URL, timeout"
```

---

## Task 4: Shared barrel — export `revokeInstallation`

**Files:**
- Modify: `applications/shared/src/github/index.ts`
- Modify: `applications/shared/src/index.ts`

- [ ] **Step 1: Open the github barrel**

Run: `cat applications/shared/src/github/index.ts` to confirm the current content (PR-2b shipped exports for `signGitHubAppJwt`, `GitHubAppJwtError`, `verifyWebhookSignature`).

- [ ] **Step 2: Append to `applications/shared/src/github/index.ts`**

After the existing `export` lines, append:

```ts
export { revokeInstallation } from './revokeInstallation.js';
export type { RevokeInstallationOpts, RevokeInstallationResult } from './revokeInstallation.js';
```

- [ ] **Step 3: Append to `applications/shared/src/index.ts`**

Locate the existing GitHub re-export block from PR-2b (it should read something like
`export { signGitHubAppJwt, GitHubAppJwtError, verifyWebhookSignature } from './github/index.js';`).
Extend it (or add a sibling line) so the file now contains:

```ts
export { signGitHubAppJwt, GitHubAppJwtError, verifyWebhookSignature, revokeInstallation } from './github/index.js';
export type { AppJwtOptions, RevokeInstallationOpts, RevokeInstallationResult } from './github/index.js';
```

If the existing line is already a single `export {…}`, just add the names; if it's a `export type {…}`, add the types. Keep the styling consistent with the surrounding code.

- [ ] **Step 4: Rebuild shared dist**

Run: `yarn workspace @bedrock/shared run build`
Expected: exit 0; `applications/shared/dist/` refreshed (memory: `worktree-yarn-shared-dist.md` — consumers need `dist/` to see the new exports).

- [ ] **Step 5: Typecheck**

Run: `yarn workspace @bedrock/shared run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add applications/shared/src/github/index.ts applications/shared/src/index.ts
git commit -m "feat(shared): export github/revokeInstallation"
```

---

## Task 5: Secrets schema — add `internalApiToken`

**Files:**
- Modify: `api/public-api/src/lib/githubAppSecrets.ts`
- Modify: `api/public-api/__tests__/lib/githubAppSecrets.test.ts`

- [ ] **Step 1: Inspect current shape**

Run: `cat api/public-api/src/lib/githubAppSecrets.ts | head -80`
Locate the `GitHubAppSecrets` interface and the `parseAndValidate` function. Both come from PR-2b.

- [ ] **Step 2: Add the field to the `GitHubAppSecrets` interface**

In `githubAppSecrets.ts`, change:

```ts
export interface GitHubAppSecrets {
    readonly appId:          string;
    readonly privateKeyPem:  string;
    readonly webhookSecret:  string;
}
```

To:

```ts
export interface GitHubAppSecrets {
    readonly appId:            string;
    readonly privateKeyPem:    string;
    readonly webhookSecret:    string;
    readonly internalApiToken: string;
}
```

- [ ] **Step 3: Extend `parseAndValidate`**

Inside `parseAndValidate`, after the existing `webhookSecret` validation block, add:

```ts
const internalApiToken = typeof o['internalApiToken'] === 'string' && (o['internalApiToken'] as string).length > 0
    ? o['internalApiToken'] as string
    : undefined;
```

Then change the existing missing-fields check from:

```ts
if (!appId || !privateKeyPem || !webhookSecret) {
    throw new Error(`[github-app] Secret ${arn} missing one of: appId, privateKeyPem, webhookSecret`);
}
return Object.freeze({ appId, privateKeyPem, webhookSecret });
```

To:

```ts
if (!appId || !privateKeyPem || !webhookSecret || !internalApiToken) {
    throw new Error(`[github-app] Secret ${arn} missing one of: appId, privateKeyPem, webhookSecret, internalApiToken`);
}
return Object.freeze({ appId, privateKeyPem, webhookSecret, internalApiToken });
```

- [ ] **Step 4: Update the test fixture**

In `api/public-api/__tests__/lib/githubAppSecrets.test.ts`, find the `VALID_JSON` constant. It currently looks like:

```ts
const VALID_JSON = JSON.stringify({
    appId:          '123',
    privateKeyPem:  '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----',
    webhookSecret:  'whsec_test',
});
```

Replace with:

```ts
const VALID_JSON = JSON.stringify({
    appId:            '123',
    privateKeyPem:    '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----',
    webhookSecret:    'whsec_test',
    internalApiToken: 'internal_test_token',
});
```

- [ ] **Step 5: Extend the happy-path assertion**

Find the test `it('parses a valid JSON secret into a frozen { appId, privateKeyPem, webhookSecret }', …)`. After the existing `expect(out.webhookSecret).toBe('whsec_test')` assertion, add:

```ts
        expect(out.internalApiToken).toBe('internal_test_token');
```

Update the test name to: `it('parses a valid JSON secret into a frozen { appId, privateKeyPem, webhookSecret, internalApiToken }', …)`.

- [ ] **Step 6: Add a new "missing internalApiToken" test**

Append inside the existing `describe('getGitHubAppSecrets', …)`:

```ts
    it('throws when internalApiToken is missing', async () => {
        smMock.on(GetSecretValueCommand).resolves({
            SecretString: JSON.stringify({
                appId:         '1',
                privateKeyPem: 'x',
                webhookSecret: 'y',
                // internalApiToken intentionally omitted
            }),
        });
        await expect(getGitHubAppSecrets(stubConfig())).rejects.toThrow(/internalApiToken/);
    });
```

- [ ] **Step 7: Update the existing "missing one of" test if it pins to the old message**

Find the existing test that asserts the "missing one of" error (it currently uses `/missing one of/`). If it's a permissive regex like that, no change needed. If it pins to the literal string `"missing one of: appId, privateKeyPem, webhookSecret"`, change to the permissive `/missing one of/`.

- [ ] **Step 8: Run the suite**

Run: `yarn workspace @repo/public-api run test __tests__/lib/githubAppSecrets.test.ts`
Expected: 9 PASS (PR-2b's 8 plus the new "missing internalApiToken" test).

- [ ] **Step 9: Typecheck**

Run: `yarn workspace @repo/public-api run typecheck`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add api/public-api/src/lib/githubAppSecrets.ts api/public-api/__tests__/lib/githubAppSecrets.test.ts
git commit -m "feat(public-api): GitHubAppSecrets gains internalApiToken"
```

---

## Task 6: Internal revoke route — failing happy-path test

**Files:**
- Create: `api/public-api/__tests__/routes/internal-revoke-github.test.ts`

- [ ] **Step 1: Inspect Hono test pattern from PR-2b**

Run: `head -120 api/public-api/__tests__/routes/github-webhook.test.ts` to confirm:
- Use of `jest.spyOn` for `getGitHubAppSecrets`, `getOAuthConnectionsRepo`.
- Pattern for `app.request()` invocation via the imported Hono sub-app.
- `__resetGitHubAppSecretsCacheForTests` + `__resetOAuthSingletonsForTests` usage in `beforeEach`.
- The 5-method mock for the OAuth repo (it has to satisfy the `IOAuthConnectionsRepository` interface).

- [ ] **Step 2: Write the failing test file**

```ts
// api/public-api/__tests__/routes/internal-revoke-github.test.ts
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

import internalRevoke from '../../src/routes/internal-revoke-github.js';
import { __resetGitHubAppSecretsCacheForTests } from '../../src/lib/githubAppSecrets.js';
import { __resetOAuthSingletonsForTests } from '../../src/lib/oauth.js';
import * as ghSecrets from '../../src/lib/githubAppSecrets.js';
import * as oauthLib from '../../src/lib/oauth.js';
import * as sharedLib from '@bedrock/shared';

const INTERNAL_TOKEN = 'internal_test_token';

const SECRETS_FIXTURE = {
    appId:            '123',
    privateKeyPem:    '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
    webhookSecret:    'whsec_test',
    internalApiToken: INTERNAL_TOKEN,
};

function makeRepoMock(overrides: Partial<{
    getByUserAndProvider: (userId: string, provider: string) => Promise<unknown>;
    markRevoked:          (id: string, at: Date) => Promise<void>;
}> = {}): {
    getByUserAndProvider: jest.Mock;
    markRevoked:          jest.Mock;
} {
    const getByUserAndProvider = jest.fn(async (..._args: unknown[]) => ({
        id: 'row-1', installationId: 'inst-42',
    }));
    const markRevoked = jest.fn(async (..._args: unknown[]) => undefined);

    jest.spyOn(oauthLib, 'getOAuthConnectionsRepo').mockReturnValue({
        getByUserAndProvider: (overrides.getByUserAndProvider ?? getByUserAndProvider) as unknown as never,
        markRevoked:          (overrides.markRevoked          ?? markRevoked) as unknown as never,
        markSuspended:        jest.fn() as unknown as never,
        upsert:               jest.fn() as unknown as never,
        getByInstallationId:  jest.fn() as unknown as never,
    });
    return { getByUserAndProvider, markRevoked };
}

beforeEach(() => {
    __resetGitHubAppSecretsCacheForTests();
    __resetOAuthSingletonsForTests();
    jest.restoreAllMocks();

    process.env['PG_HOST']                  = 'localhost';
    process.env['PG_DATABASE']              = 'db';
    process.env['PG_USER']                  = 'u';
    process.env['PG_PASSWORD']              = 'p';
    process.env['OAUTH_TOKEN_KMS_KEY_ARN']  = 'arn:aws:kms:eu-west-1:0:key/abc';
    process.env['GITHUB_APP_SECRET_ARN']    = 'arn:aws:secretsmanager:eu-west-1:0:secret/gh-app';

    jest.spyOn(ghSecrets, 'getGitHubAppSecrets').mockResolvedValue(SECRETS_FIXTURE);
    jest.spyOn(sharedLib, 'revokeInstallation').mockResolvedValue({
        ok: true, status: 204, alreadyDeleted: false,
    });
});

async function call(body: object, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
    const res = await internalRevoke.request('/internal/revoke-github', {
        method:  'POST',
        body:    JSON.stringify(body),
        headers: {
            'content-type':  'application/json',
            'authorization': `Bearer ${INTERNAL_TOKEN}`,
            ...headers,
        },
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

describe('POST /internal/revoke-github', () => {
    it('happy path: GitHub 204 → 200 ok, markRevoked called, JWT shape verified', async () => {
        const repo = makeRepoMock();
        const out = await call({ userId: 'user-uuid-1', reason: 'user_soft_delete' });

        expect(out.status).toBe(200);
        expect(out.json).toMatchObject({ status: 'ok', alreadyDeleted: false });
        expect(repo.markRevoked).toHaveBeenCalledTimes(1);
        expect(repo.markRevoked.mock.calls[0]![0]).toBe('row-1');

        // revokeInstallation called once with the right installationId + a real JWT.
        const calls = (sharedLib.revokeInstallation as jest.Mock).mock.calls;
        expect(calls).toHaveLength(1);
        const passed = calls[0]![0] as { installationId: string; jwt: string };
        expect(passed.installationId).toBe('inst-42');
        const parts = passed.jwt.split('.');
        expect(parts).toHaveLength(3);
        const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
        expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    });
});
```

- [ ] **Step 3: Run, verify FAIL**

Run: `yarn workspace @repo/public-api run test __tests__/routes/internal-revoke-github.test.ts`
Expected: FAIL — `Cannot find module '../../src/routes/internal-revoke-github.js'`.

- [ ] **Step 4: Commit**

```bash
git add api/public-api/__tests__/routes/internal-revoke-github.test.ts
git commit -m "test(public-api): failing happy-path test for internal-revoke-github"
```

---

## Task 7: Internal revoke route — implementation

**Files:**
- Create: `api/public-api/src/routes/internal-revoke-github.ts`

- [ ] **Step 1: Write the route**

```ts
// api/public-api/src/routes/internal-revoke-github.ts
/**
 * @file internal-revoke-github.ts
 * @description POST /internal/revoke-github
 *
 * Called by tucaken-app's admin-api when a user soft-deletes their account.
 * Looks up the user's GitHub oauth_connections row, signs a GitHub App JWT,
 * calls DELETE /app/installations/{id}, and marks the row revoked.
 *
 * Auth: shared Bearer token. The token lives alongside the App private key
 * inside a single Secrets Manager JSON secret — see getGitHubAppSecrets().
 *
 * Status-code contract: see
 * docs/superpowers/specs/2026-05-21-internal-github-app-revoke-design.md.
 */

import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { signGitHubAppJwt, revokeInstallation, log } from '@bedrock/shared';
import { loadConfig } from '../lib/config.js';
import { getGitHubAppSecrets } from '../lib/githubAppSecrets.js';
import { getOAuthConnectionsRepo } from '../lib/oauth.js';

const internalRevoke = new Hono();

function verifyBearer(authHeader: string | undefined, expected: string): boolean {
    if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
    const supplied = Buffer.from(authHeader.slice('Bearer '.length), 'utf8');
    const wanted   = Buffer.from(expected, 'utf8');
    if (supplied.length !== wanted.length) return false;
    return timingSafeEqual(supplied, wanted);
}

internalRevoke.post('/internal/revoke-github', async (c) => {
    const cfg     = loadConfig();
    const secrets = await getGitHubAppSecrets(cfg);

    if (!verifyBearer(c.req.header('authorization'), secrets.internalApiToken)) {
        log('WARN', 'internal.revoke_github.unauthorized', { ip: c.req.header('x-forwarded-for') });
        return c.json({ error: 'unauthorized' }, 401);
    }

    let body: { userId?: string; reason?: string };
    try {
        body = await c.req.json();
    } catch {
        log('WARN', 'internal.revoke_github.bad_json', {});
        return c.json({ error: 'bad json' }, 400);
    }

    const userId = typeof body.userId === 'string' && body.userId.length > 0 ? body.userId : undefined;
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : undefined;
    if (!userId) {
        log('WARN', 'internal.revoke_github.missing_userId', {});
        return c.json({ error: 'missing userId' }, 400);
    }

    const repo = getOAuthConnectionsRepo(cfg);
    const row  = await repo.getByUserAndProvider(userId, 'github');
    if (!row) {
        log('INFO', 'internal.revoke_github.no_match', { userId, reason });
        return c.json({ status: 'no_match' }, 200);
    }

    if (!row.installationId) {
        await repo.markRevoked(row.id, new Date());
        log('INFO', 'internal.revoke_github.no_installation', {
            userId, reason, oauthConnectionId: row.id,
        });
        return c.json({ status: 'no_installation' }, 200);
    }

    const jwt = signGitHubAppJwt({
        appId:         secrets.appId,
        privateKeyPem: secrets.privateKeyPem,
    });
    const result = await revokeInstallation({ installationId: row.installationId, jwt });

    if (!result.ok) {
        log('ERROR', 'internal.revoke_github.github_error', {
            userId, reason, oauthConnectionId: row.id,
            installationId: row.installationId,
            githubStatus:   result.status,
            githubBody:     result.body,
        });
        return c.json({ error: 'github error', status: result.status }, 500);
    }

    await repo.markRevoked(row.id, new Date());

    log('INFO', 'internal.revoke_github.processed', {
        userId, reason, oauthConnectionId: row.id,
        installationId: row.installationId,
        alreadyDeleted: result.alreadyDeleted,
    });
    return c.json({ status: 'ok', alreadyDeleted: result.alreadyDeleted }, 200);
});

export default internalRevoke;
```

- [ ] **Step 2: Run the happy-path test**

Run: `yarn workspace @repo/public-api run test __tests__/routes/internal-revoke-github.test.ts`
Expected: 1 PASS.

- [ ] **Step 3: Typecheck**

Run: `yarn workspace @repo/public-api run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add api/public-api/src/routes/internal-revoke-github.ts
git commit -m "feat(public-api): POST /internal/revoke-github"
```

---

## Task 8: Internal revoke route — remaining 11 test cases

**Files:**
- Modify: `api/public-api/__tests__/routes/internal-revoke-github.test.ts`

- [ ] **Step 1: Append the remaining tests**

Append inside the existing `describe('POST /internal/revoke-github', …)`:

```ts
    it('GitHub 404 → 200 ok with alreadyDeleted=true; markRevoked still called', async () => {
        const repo = makeRepoMock();
        (sharedLib.revokeInstallation as jest.Mock).mockResolvedValue({
            ok: true, status: 404, alreadyDeleted: true,
        });
        const out = await call({ userId: 'user-uuid-1' });
        expect(out.status).toBe(200);
        expect(out.json).toMatchObject({ status: 'ok', alreadyDeleted: true });
        expect(repo.markRevoked).toHaveBeenCalledTimes(1);
    });

    it('no oauth_connections row → 200 no_match; no revoke, no mark', async () => {
        const repo = makeRepoMock({ getByUserAndProvider: async () => null });
        const out = await call({ userId: 'unknown' });
        expect(out.status).toBe(200);
        expect(out.json).toMatchObject({ status: 'no_match' });
        expect(repo.markRevoked).not.toHaveBeenCalled();
        expect(sharedLib.revokeInstallation).not.toHaveBeenCalled();
    });

    it('row with null installationId → 200 no_installation; markRevoked called; revokeInstallation NOT called', async () => {
        const repo = makeRepoMock({
            getByUserAndProvider: async () => ({ id: 'row-2', installationId: null }),
        });
        const out = await call({ userId: 'user-uuid-2' });
        expect(out.status).toBe(200);
        expect(out.json).toMatchObject({ status: 'no_installation' });
        expect(repo.markRevoked).toHaveBeenCalledTimes(1);
        expect(sharedLib.revokeInstallation).not.toHaveBeenCalled();
    });

    it('GitHub 5xx → 500; markRevoked NOT called', async () => {
        const repo = makeRepoMock();
        (sharedLib.revokeInstallation as jest.Mock).mockResolvedValue({
            ok: false, status: 502, body: 'bad gateway',
        });
        const out = await call({ userId: 'user-uuid-1' });
        expect(out.status).toBe(500);
        expect(repo.markRevoked).not.toHaveBeenCalled();
    });

    it('GitHub 403 → 500; markRevoked NOT called', async () => {
        const repo = makeRepoMock();
        (sharedLib.revokeInstallation as jest.Mock).mockResolvedValue({
            ok: false, status: 403, body: 'forbidden',
        });
        const out = await call({ userId: 'user-uuid-1' });
        expect(out.status).toBe(500);
        expect(repo.markRevoked).not.toHaveBeenCalled();
    });

    it('missing Authorization header → 401; no DB lookup attempted', async () => {
        const repo = makeRepoMock();
        const res = await internalRevoke.request('/internal/revoke-github', {
            method: 'POST',
            body: JSON.stringify({ userId: 'x' }),
            headers: { 'content-type': 'application/json' },
        });
        expect(res.status).toBe(401);
        expect(repo.getByUserAndProvider).not.toHaveBeenCalled();
    });

    it('wrong Bearer token → 401', async () => {
        const repo = makeRepoMock();
        const out = await call({ userId: 'x' }, { authorization: 'Bearer wrong-token-xyz' });
        expect(out.status).toBe(401);
        expect(repo.getByUserAndProvider).not.toHaveBeenCalled();
    });

    it('same-length but different Bearer token → 401 (timing-safe path)', async () => {
        const repo = makeRepoMock();
        const sameLen = 'A'.repeat(INTERNAL_TOKEN.length);
        const out = await call({ userId: 'x' }, { authorization: `Bearer ${sameLen}` });
        expect(out.status).toBe(401);
        expect(repo.getByUserAndProvider).not.toHaveBeenCalled();
    });

    it('body not JSON → 400', async () => {
        makeRepoMock();
        const res = await internalRevoke.request('/internal/revoke-github', {
            method: 'POST',
            body: 'not-json',
            headers: {
                'content-type':  'application/json',
                'authorization': `Bearer ${INTERNAL_TOKEN}`,
            },
        });
        expect(res.status).toBe(400);
    });

    it('body missing userId → 400', async () => {
        const repo = makeRepoMock();
        const out = await call({ reason: 'nope' } as unknown as { userId: string });
        expect(out.status).toBe(400);
        expect(repo.getByUserAndProvider).not.toHaveBeenCalled();
    });

    it('reason longer than 200 chars is truncated in the logged payload', async () => {
        makeRepoMock();
        // We can't easily intercept the structured log content without spying
        // on `log`. Spy on it and assert the truncated length.
        const logSpy = jest.spyOn(sharedLib, 'log').mockImplementation(() => undefined);
        try {
            const longReason = 'x'.repeat(500);
            const out = await call({ userId: 'user-uuid-1', reason: longReason });
            expect(out.status).toBe(200);

            const processedCall = logSpy.mock.calls.find(c => c[1] === 'internal.revoke_github.processed');
            expect(processedCall).toBeDefined();
            const payload = processedCall![2] as Record<string, unknown>;
            expect((payload['reason'] as string).length).toBe(200);
        } finally {
            logSpy.mockRestore();
        }
    });
```

- [ ] **Step 2: Run the file**

Run: `yarn workspace @repo/public-api run test __tests__/routes/internal-revoke-github.test.ts`
Expected: 12 PASS.

- [ ] **Step 3: Commit**

```bash
git add api/public-api/__tests__/routes/internal-revoke-github.test.ts
git commit -m "test(public-api): coverage for all 12 internal-revoke-github branches"
```

---

## Task 9: Mount the route in `index.ts`

**Files:**
- Modify: `api/public-api/src/index.ts`

- [ ] **Step 1: Add the import**

In the existing imports block (alongside `import githubWebhook from './routes/github-webhook.js';`), add:

```ts
import internalRevoke from './routes/internal-revoke-github.js';
```

- [ ] **Step 2: Mount it**

In the routes-mount block (where `app.route('/', githubWebhook);` lives), append:

```ts
app.route('/', internalRevoke);
```

- [ ] **Step 3: Typecheck + build**

Run: `yarn workspace @repo/public-api run typecheck` — exit 0.
Run: `yarn workspace @repo/public-api run build` — exit 0 (catches import-path drift the unit tests cannot).

- [ ] **Step 4: Commit**

```bash
git add api/public-api/src/index.ts
git commit -m "feat(public-api): mount POST /internal/revoke-github"
```

---

## Task 10: Full verification + push + PR

**Files:** none changed — operational.

- [ ] **Step 1: Run every affected suite**

```
yarn workspace @bedrock/shared run test src/github/ src/crypto/ src/rds/
yarn workspace @repo/public-api run test __tests__/
```
Expected: shared green (PR-2b's tests + 7 new revokeInstallation tests); public-api green (PR-2b's tests + 1 new secrets test + 12 new internal-revoke tests).

- [ ] **Step 2: Typecheck both workspaces**

```
yarn workspace @bedrock/shared run typecheck
yarn workspace @repo/public-api run typecheck
```
Expected: both exit 0.

- [ ] **Step 3: Diff against base branch**

```
git log --oneline oauth-github-webhook..HEAD
```
Expected: roughly 9 commits matching Tasks 1–9.

If PR-2b has merged to `develop` by now, rebase first:
```
git fetch origin develop
git rebase origin/develop
```
Resolve any conflicts (unlikely given the file structure does not overlap with `develop` content), then re-run the test commands above.

- [ ] **Step 4: Push**

```
git push -u origin oauth-soft-delete-revoke
```

- [ ] **Step 5: Open PR**

Use the operator runbook from the spec as the PR body. If PR-2b is still open, base this PR on `oauth-github-webhook`; otherwise base on `develop`.

```
gh pr create \
  --base $(gh pr view 19 --json state --jq '.state' >/dev/null 2>&1 && echo oauth-github-webhook || echo develop) \
  --title "feat: internal GitHub App revoke endpoint (PR-2c of 3)" \
  --body-file - <<'EOF'
## Summary

`POST /internal/revoke-github` route in public-api that tucaken-app's
admin-api calls when a user soft-deletes their account. Looks up the
GitHub `oauth_connections` row, signs an App JWT (PR-2b helper), calls
`DELETE /app/installations/{id}` via a new `revokeInstallation` helper
in `@bedrock/shared`, then `markRevoked()`s the row.

### What ships

- `applications/shared/src/github/revokeInstallation.ts` — pure HTTP
  client. Discriminated union return so the caller decides whether 404
  is a success.
- `api/public-api/src/lib/githubAppSecrets.ts` — `GitHubAppSecrets` now
  has `internalApiToken: string`; `parseAndValidate` requires it.
- `api/public-api/src/routes/internal-revoke-github.ts` — Hono route
  mounted at `/internal/revoke-github`. Bearer-token auth via
  timing-safe compare.

### Operator runbook (CRITICAL ordering)

1. Add `internalApiToken` field to the existing GitHub App Secrets
   Manager JSON. Strong random ≥32 chars.
2. Wait ≥10 min OR force-roll the public-api pod with the **previous**
   image. This refreshes the secret cache before the new field becomes
   required.
3. Deploy this PR. New code now expects `internalApiToken` on first
   fetch.
4. In tucaken-app's admin-api: wire soft-delete to
   `POST https://<public-api host>/internal/revoke-github` with
   Bearer token + `{userId, reason: 'user_soft_delete'}`. Treat 404 as
   "endpoint not deployed yet → skip"; treat 5xx as retryable.
5. Smoke-test by soft-deleting a test user; expect
   `internal.revoke_github.processed` log line.

### Deferred

- PR-3: ingestion `GitHubAdapter` migration to installation tokens.
- Admin-api wiring (separate repo).
- EMF metric on unauthorized rate if abuse becomes interesting.

## Test Plan

- [x] `yarn workspace @bedrock/shared run test src/github/` — 7 new
      `revokeInstallation` tests, all green; PR-2b suite still green.
- [x] `yarn workspace @repo/public-api run test __tests__/` — 1 new
      secrets test + 12 new route tests, all green; PR-2b suite still
      green.
- [x] Typecheck across both workspaces — exit 0.
- [x] Build public-api — exit 0.
- [ ] Reviewer: confirm operator runbook ordering is followed before
      deploy (else live `/webhooks/github` from PR-2b will return 500
      until Secrets Manager is updated).

## Spec / Plan

- Design: `docs/superpowers/specs/2026-05-21-internal-github-app-revoke-design.md`
- Plan:   `docs/superpowers/plans/2026-05-21-internal-github-app-revoke.md`
- Builds on PR-1 (#17), PR-2a (#18), PR-2b (#19).
EOF
```

---

## Out of this plan (tracked elsewhere)

- Admin-api hookup in `tucaken-app` (separate repo).
- PR-3: ingestion `GitHubAdapter` migration to installation tokens.
- EMF metric on unauthorized rate.
- IRSA migration for public-api.
