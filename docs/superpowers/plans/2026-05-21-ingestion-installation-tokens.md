# Ingestion Installation Tokens Implementation Plan (PR-3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ingestion's static `GITHUB_TOKEN` PAT with per-user GitHub App installation tokens. Add `mintInstallationToken` + `createInstallationTokenProvider` in `@bedrock/shared`, refactor `GitHubAdapter` to accept a token provider, and rewire ingestion boot to look up the user's installation_id and mint refreshable tokens.

**Architecture:** Token provider is a `() => Promise<string>` closure that caches the installation token and refreshes when ≤5min to expiry. `GitHubAdapter` calls the provider per request; the cache absorbs cost. Boot looks up `installation_id` from `oauth_connections` (plain column — no envelope needed), fetches the App secret from Secrets Manager, signs a JWT, exchanges for the first token, and hands the provider to the adapter. Fail-fast if `installation_id` is null.

**Tech Stack:** TypeScript, Node 22, `node:crypto` (RSA-SHA256 sign, AbortController), `fetch`, AWS SDK v3 (`@aws-sdk/client-secrets-manager`), `pg`, Jest.

**Spec:** [docs/superpowers/specs/2026-05-21-ingestion-installation-tokens-design.md](../specs/2026-05-21-ingestion-installation-tokens-design.md)

**Branch base:** `oauth-soft-delete-revoke` (stacks PR-3 on top of PR-2c). Rebase onto `develop` once PR-2b/2c merge.

---

## File Structure

**Create:**
- `applications/shared/src/aws/githubAppSecrets.ts` — moved from public-api with a generic args shape
- `applications/shared/src/aws/githubAppSecrets.test.ts` — moved/relocated tests
- `applications/shared/src/github/mintInstallationToken.ts`
- `applications/shared/src/github/mintInstallationToken.test.ts`
- `applications/shared/src/github/installationTokenProvider.ts`
- `applications/shared/src/github/installationTokenProvider.test.ts`
- `applications/shared/src/ingestion/implementations/GitHubAdapter.test.ts`
- `api/public-api/src/lib/githubAppSecrets-wrapper.ts` — thin Config adapter

**Modify:**
- `applications/shared/src/github/index.ts` — re-export new helpers
- `applications/shared/src/index.ts` — re-export aws + new github symbols
- `applications/shared/src/ingestion/implementations/GitHubAdapter.ts` — constructor takes provider
- `applications/shared/src/rds/interfaces/IOAuthConnectionsRepository.ts` — new method
- `applications/shared/src/rds/implementations/RdsOAuthConnectionsRepository.ts` — implement; envelope becomes optional
- `applications/shared/src/rds/implementations/RdsOAuthConnectionsRepository.test.ts` — 2 new tests
- `api/public-api/src/routes/github-webhook.ts` — import path
- `api/public-api/src/routes/internal-revoke-github.ts` — import path
- `applications/ingestion/src/env.ts` — drop `GITHUB_TOKEN`, add `GITHUB_APP_SECRET_ARN` + `awsRegion`
- `applications/ingestion/src/run-ingestion.ts` — installation-token boot wiring
- `scripts/smoke-test-github-adapter.ts` — use `fromTokenString`

**Delete:**
- `api/public-api/src/lib/githubAppSecrets.ts`
- `api/public-api/__tests__/lib/githubAppSecrets.test.ts`

---

## Task 1: Move `getGitHubAppSecrets` to shared

**Files:**
- Create: `applications/shared/src/aws/githubAppSecrets.ts`
- Create: `applications/shared/src/aws/githubAppSecrets.test.ts`
- Delete: `api/public-api/src/lib/githubAppSecrets.ts`
- Delete: `api/public-api/__tests__/lib/githubAppSecrets.test.ts`
- Create: `api/public-api/src/lib/githubAppSecrets-wrapper.ts`
- Modify: `api/public-api/src/routes/github-webhook.ts`
- Modify: `api/public-api/src/routes/internal-revoke-github.ts`
- Modify: `applications/shared/src/index.ts`

- [ ] **Step 1: Verify the worktree branch**

```
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications/.claude/worktrees/ingestion-installation-tokens && git branch --show-current
```
Must report `ingestion-installation-tokens`.

- [ ] **Step 2: Create the shared module**

Write `applications/shared/src/aws/githubAppSecrets.ts`:

```ts
/**
 * @file githubAppSecrets.ts
 * @description Secrets Manager fetcher for the GitHub App JSON secret.
 *
 * Moved from api/public-api/src/lib/githubAppSecrets.ts so both
 * public-api and ingestion can consume the same fetcher. The cache is
 * keyed on `secretArn` — multiple callers with the same ARN share a
 * single entry; different ARNs each get their own.
 *
 * Validation happens inside the fetcher so misconfiguration surfaces
 * as a clear error rather than a downstream auth failure.
 */

import {
    GetSecretValueCommand,
    SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

export interface GitHubAppSecrets {
    readonly appId:            string;
    readonly privateKeyPem:    string;
    readonly webhookSecret:    string;
    readonly internalApiToken: string;
}

export interface GetGitHubAppSecretsOpts {
    secretArn: string;
    region?:   string;
    /** Test seam. */
    client?:   SecretsManagerClient;
    /** TTL in ms; default 10 min. */
    ttlMs?:    number;
    /** Test seam. */
    now?:      () => number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

interface Cached { value: GitHubAppSecrets; expiresAt: number }
const cache = new Map<string, Cached>();
let defaultClient: SecretsManagerClient | undefined;

export async function getGitHubAppSecrets(opts: GetGitHubAppSecretsOpts): Promise<GitHubAppSecrets> {
    const now = opts.now?.() ?? Date.now();
    const hit = cache.get(opts.secretArn);
    if (hit && now < hit.expiresAt) return hit.value;

    const client = opts.client ?? (defaultClient ??= new SecretsManagerClient({
        ...(opts.region ? { region: opts.region } : {}),
    }));

    const resp = await client.send(
        new GetSecretValueCommand({ SecretId: opts.secretArn }),
    );
    if (!resp.SecretString) {
        throw new Error(`[github-app] Secrets Manager secret has no value: ${opts.secretArn}`);
    }

    const parsed = parseAndValidate(resp.SecretString, opts.secretArn);
    cache.set(opts.secretArn, { value: parsed, expiresAt: now + (opts.ttlMs ?? DEFAULT_TTL_MS) });
    return parsed;
}

function parseAndValidate(raw: string, arn: string): GitHubAppSecrets {
    let json: unknown;
    try { json = JSON.parse(raw); }
    catch { throw new Error(`[github-app] Secret ${arn} is not valid JSON`); }

    if (typeof json !== 'object' || json === null) {
        throw new Error(`[github-app] Secret ${arn} must be a JSON object`);
    }
    const o = json as Record<string, unknown>;
    const appIdRaw         = o['appId'];
    const appId            = (typeof appIdRaw === 'string' || typeof appIdRaw === 'number') ? String(appIdRaw) : undefined;
    const privateKeyPem    = typeof o['privateKeyPem']    === 'string' && (o['privateKeyPem']    as string).length > 0 ? o['privateKeyPem']    as string : undefined;
    const webhookSecret    = typeof o['webhookSecret']    === 'string' && (o['webhookSecret']    as string).length > 0 ? o['webhookSecret']    as string : undefined;
    const internalApiToken = typeof o['internalApiToken'] === 'string' && (o['internalApiToken'] as string).length > 0 ? o['internalApiToken'] as string : undefined;
    if (!appId || !privateKeyPem || !webhookSecret || !internalApiToken) {
        throw new Error(`[github-app] Secret ${arn} missing one of: appId, privateKeyPem, webhookSecret, internalApiToken`);
    }
    return Object.freeze({ appId, privateKeyPem, webhookSecret, internalApiToken });
}

/** Test seam — clears the cache for all secretArns. */
export function __resetGitHubAppSecretsCacheForTests(): void {
    cache.clear();
    defaultClient = undefined;
}
```

- [ ] **Step 3: Create the relocated test file**

Write `applications/shared/src/aws/githubAppSecrets.test.ts`:

```ts
/**
 * @file githubAppSecrets.test.ts
 * @description Tests for the shared Secrets Manager fetcher. Mirrors the
 * PR-2b/2c test cases — moved out of api/public-api so both consumers
 * cover the same surface.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
    getGitHubAppSecrets,
    __resetGitHubAppSecretsCacheForTests,
} from './githubAppSecrets.js';

const smMock = mockClient(SecretsManagerClient);

const ARN = 'arn:aws:secretsmanager:eu-west-1:0:secret/gh-app';

const VALID_JSON = JSON.stringify({
    appId:            '123',
    privateKeyPem:    '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----',
    webhookSecret:    'whsec_test',
    internalApiToken: 'internal_test_token',
});

beforeEach(() => {
    smMock.reset();
    __resetGitHubAppSecretsCacheForTests();
});

describe('getGitHubAppSecrets', () => {
    it('parses a valid JSON secret into a frozen four-field object', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: VALID_JSON });
        const out = await getGitHubAppSecrets({ secretArn: ARN });
        expect(out.appId).toBe('123');
        expect(out.privateKeyPem).toContain('BEGIN RSA PRIVATE KEY');
        expect(out.webhookSecret).toBe('whsec_test');
        expect(out.internalApiToken).toBe('internal_test_token');
        expect(Object.isFrozen(out)).toBe(true);
    });

    it('serves the cached value on a second call within TTL (same secretArn)', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: VALID_JSON });
        await getGitHubAppSecrets({ secretArn: ARN });
        await getGitHubAppSecrets({ secretArn: ARN });
        expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
    });

    it('re-fetches after the TTL expires (uses injected now)', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: VALID_JSON });
        const t0 = 1_700_000_000_000;
        await getGitHubAppSecrets({ secretArn: ARN, now: () => t0 });
        await getGitHubAppSecrets({ secretArn: ARN, now: () => t0 + 11 * 60_000 });
        expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(2);
    });

    it('caches independently per secretArn', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: VALID_JSON });
        await getGitHubAppSecrets({ secretArn: ARN });
        await getGitHubAppSecrets({ secretArn: ARN + '-other' });
        expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(2);
    });

    it('throws when SecretString is missing', async () => {
        smMock.on(GetSecretValueCommand).resolves({});
        await expect(getGitHubAppSecrets({ secretArn: ARN })).rejects.toThrow(/has no value/);
    });

    it('throws on invalid JSON', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: 'not json' });
        await expect(getGitHubAppSecrets({ secretArn: ARN })).rejects.toThrow(/is not valid JSON/);
    });

    it('throws when a required field is missing', async () => {
        smMock.on(GetSecretValueCommand).resolves({
            SecretString: JSON.stringify({
                appId: '1', privateKeyPem: 'x', webhookSecret: 'y',
            }),
        });
        await expect(getGitHubAppSecrets({ secretArn: ARN })).rejects.toThrow(/internalApiToken/);
    });

    it('accepts appId as number and coerces to string', async () => {
        smMock.on(GetSecretValueCommand).resolves({
            SecretString: JSON.stringify({
                appId: 123, privateKeyPem: 'x', webhookSecret: 'y', internalApiToken: 'z',
            }),
        });
        const out = await getGitHubAppSecrets({ secretArn: ARN });
        expect(out.appId).toBe('123');
    });

    it('__resetGitHubAppSecretsCacheForTests forces a fresh fetch', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: VALID_JSON });
        await getGitHubAppSecrets({ secretArn: ARN });
        __resetGitHubAppSecretsCacheForTests();
        await getGitHubAppSecrets({ secretArn: ARN });
        expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(2);
    });
});
```

- [ ] **Step 4: Re-export from the package barrel**

Open `applications/shared/src/index.ts` and add a new section near the existing AWS-SDK exports. Append:

```ts
// ─── AWS — GitHub App Secrets ────────────────────────────────────────────────
export { getGitHubAppSecrets, __resetGitHubAppSecretsCacheForTests } from './aws/githubAppSecrets.js';
export type { GitHubAppSecrets, GetGitHubAppSecretsOpts } from './aws/githubAppSecrets.js';
```

- [ ] **Step 5: Create the public-api wrapper**

Write `api/public-api/src/lib/githubAppSecrets-wrapper.ts`:

```ts
/**
 * @file githubAppSecrets-wrapper.ts
 * @description Public-api Config adapter for the shared
 * getGitHubAppSecrets fetcher. Keeps the public-api route signature
 * ergonomic (one arg, a Config) while the implementation lives in
 * @bedrock/shared.
 */

import { getGitHubAppSecrets as getFromShared } from '@bedrock/shared';
import type { GitHubAppSecrets } from '@bedrock/shared';
import type { Config } from './config.js';

export async function getGitHubAppSecrets(config: Config): Promise<GitHubAppSecrets> {
    return getFromShared({
        secretArn: config.githubAppSecretArn,
        region:    config.awsRegion,
    });
}

export { __resetGitHubAppSecretsCacheForTests } from '@bedrock/shared';
```

- [ ] **Step 6: Update import paths in the two route files**

In `api/public-api/src/routes/github-webhook.ts` change:
```ts
import { getGitHubAppSecrets } from '../lib/githubAppSecrets.js';
```
To:
```ts
import { getGitHubAppSecrets } from '../lib/githubAppSecrets-wrapper.js';
```

Same change in `api/public-api/src/routes/internal-revoke-github.ts`.

- [ ] **Step 7: Update test import paths**

The test files at:
- `api/public-api/__tests__/routes/github-webhook.test.ts`
- `api/public-api/__tests__/routes/internal-revoke-github.test.ts`

import from `'../../src/lib/githubAppSecrets.js'` for the reset seam. Change each to:
```ts
import { __resetGitHubAppSecretsCacheForTests } from '../../src/lib/githubAppSecrets-wrapper.js';
```
And update any `import * as ghSecrets from '../../src/lib/githubAppSecrets.js'` to point at `'../../src/lib/githubAppSecrets-wrapper.js'`.

- [ ] **Step 8: Delete the old public-api files**

```bash
rm api/public-api/src/lib/githubAppSecrets.ts
rm api/public-api/__tests__/lib/githubAppSecrets.test.ts
```

- [ ] **Step 9: Run the affected suites**

```
yarn workspace @bedrock/shared run test src/aws/githubAppSecrets.test.ts
yarn workspace @repo/public-api run test __tests__/routes/
```
Expected: shared tests pass (9 tests); public-api route tests pass (PR-2b's 10 + PR-2c's 12 = 22).

- [ ] **Step 10: Rebuild shared dist**

```
yarn workspace @bedrock/shared run build
```
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add applications/shared/src/aws/ \
        applications/shared/src/index.ts \
        api/public-api/src/lib/githubAppSecrets-wrapper.ts \
        api/public-api/src/routes/github-webhook.ts \
        api/public-api/src/routes/internal-revoke-github.ts \
        api/public-api/__tests__/routes/
git rm api/public-api/src/lib/githubAppSecrets.ts \
       api/public-api/__tests__/lib/githubAppSecrets.test.ts
git commit -m "refactor(shared): move getGitHubAppSecrets out of public-api"
```

NO Co-Authored-By trailer (memory: `feedback_no_coauthored.md`).

---

## Task 2: `mintInstallationToken` — failing test

**Files:**
- Create: `applications/shared/src/github/mintInstallationToken.test.ts`

- [ ] **Step 1: Write the failing test file**

```ts
// applications/shared/src/github/mintInstallationToken.test.ts
import { describe, it, expect, jest } from '@jest/globals';
import { mintInstallationToken, MintInstallationTokenError } from './mintInstallationToken.js';

function fakeFetch(response: { status: number; body: object | string | null }) {
    return jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
        const body = response.body === null
            ? null
            : typeof response.body === 'string'
                ? response.body
                : JSON.stringify(response.body);
        return new Response(body, { status: response.status }) as Response;
    });
}

describe('mintInstallationToken', () => {
    it('201 → { token, expiresAt } and uses the right URL + headers', async () => {
        const f = fakeFetch({
            status: 201,
            body: { token: 'ghs_abc', expires_at: '2026-01-01T01:00:00Z' },
        });
        const out = await mintInstallationToken({
            installationId: 'inst-42',
            jwt:            'jwt.payload.sig',
            fetch:          f as unknown as typeof globalThis.fetch,
        });
        expect(out.token).toBe('ghs_abc');
        expect(out.expiresAt.toISOString()).toBe('2026-01-01T01:00:00.000Z');

        expect(f).toHaveBeenCalledTimes(1);
        const [url, init] = f.mock.calls[0]!;
        expect(String(url)).toBe('https://api.github.com/app/installations/inst-42/access_tokens');
        expect((init as RequestInit).method).toBe('POST');
        const headers = (init as RequestInit).headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer jwt.payload.sig');
        expect(headers['Accept']).toBe('application/vnd.github+json');
        expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
        expect(headers['User-Agent']).toBe('ai-applications/installation-token-mint');
    });
});
```

- [ ] **Step 2: Run, verify FAIL**

```
yarn workspace @bedrock/shared run test src/github/mintInstallationToken.test.ts
```
Expected: FAIL — `Cannot find module './mintInstallationToken.js'`.

- [ ] **Step 3: Commit**

```bash
git add applications/shared/src/github/mintInstallationToken.test.ts
git commit -m "test(github): failing happy-path for mintInstallationToken"
```

---

## Task 3: `mintInstallationToken` — implementation

**Files:**
- Create: `applications/shared/src/github/mintInstallationToken.ts`

- [ ] **Step 1: Write the implementation**

```ts
// applications/shared/src/github/mintInstallationToken.ts
/**
 * @format
 * Exchanges a GitHub App JWT for an installation access token.
 *
 * POST /app/installations/{installation_id}/access_tokens with the JWT in
 * Authorization. Returns the minted token plus its absolute expiry.
 *
 * Throws MintInstallationTokenError on any non-201 response — there is no
 * "soft success" case for this endpoint.
 */

export interface MintInstallationTokenOpts {
    installationId: string;
    jwt:            string;
    fetch?:         typeof globalThis.fetch;
    githubBaseUrl?: string;
    timeoutMs?:     number;
}

export interface InstallationToken {
    token:     string;
    expiresAt: Date;
}

export class MintInstallationTokenError extends Error {
    constructor(public readonly status: number, public readonly body: string) {
        super(`mintInstallationToken failed: HTTP ${status} ${body.slice(0, 200)}`);
        this.name = 'MintInstallationTokenError';
    }
}

export async function mintInstallationToken(opts: MintInstallationTokenOpts): Promise<InstallationToken> {
    const base = opts.githubBaseUrl ?? 'https://api.github.com';
    const url  = `${base}/app/installations/${encodeURIComponent(opts.installationId)}/access_tokens`;
    const f    = opts.fetch ?? globalThis.fetch;

    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
    try {
        const res = await f(url, {
            method:  'POST',
            headers: {
                'Accept':              'application/vnd.github+json',
                'Authorization':       `Bearer ${opts.jwt}`,
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent':          'ai-applications/installation-token-mint',
            },
            signal: ctrl.signal,
        });

        if (res.status === 201) {
            const json = await res.json() as { token?: unknown; expires_at?: unknown };
            if (typeof json.token !== 'string' || typeof json.expires_at !== 'string') {
                throw new MintInstallationTokenError(201, `unexpected response shape`);
            }
            return { token: json.token, expiresAt: new Date(json.expires_at) };
        }

        const body = await res.text().catch(() => '');
        throw new MintInstallationTokenError(res.status, body);
    } finally {
        clearTimeout(t);
    }
}
```

- [ ] **Step 2: Run the failing test**

```
yarn workspace @bedrock/shared run test src/github/mintInstallationToken.test.ts
```
Expected: 1 PASS.

- [ ] **Step 3: Typecheck**

```
yarn workspace @bedrock/shared run typecheck
```
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add applications/shared/src/github/mintInstallationToken.ts
git commit -m "feat(github): mintInstallationToken — POST /app/installations/{id}/access_tokens"
```

---

## Task 4: `mintInstallationToken` — error-path coverage

**Files:**
- Modify: `applications/shared/src/github/mintInstallationToken.test.ts`

- [ ] **Step 1: Append the remaining 4 cases**

Append inside the existing `describe`:

```ts
    it('403 → throws MintInstallationTokenError with status + body', async () => {
        const f = fakeFetch({ status: 403, body: 'forbidden' });
        await expect(mintInstallationToken({
            installationId: 'x', jwt: 'x',
            fetch: f as unknown as typeof globalThis.fetch,
        })).rejects.toMatchObject({ status: 403, body: 'forbidden' });
    });

    it('500 → throws with status 500', async () => {
        const f = fakeFetch({ status: 500, body: 'boom' });
        await expect(mintInstallationToken({
            installationId: 'x', jwt: 'x',
            fetch: f as unknown as typeof globalThis.fetch,
        })).rejects.toMatchObject({ status: 500 });
    });

    it('honors a custom githubBaseUrl', async () => {
        const f = fakeFetch({
            status: 201,
            body: { token: 't', expires_at: '2026-01-01T01:00:00Z' },
        });
        await mintInstallationToken({
            installationId: 'inst-1', jwt: 'x',
            fetch:          f as unknown as typeof globalThis.fetch,
            githubBaseUrl:  'https://github.test',
        });
        const [url] = f.mock.calls[0]!;
        expect(String(url)).toBe('https://github.test/app/installations/inst-1/access_tokens');
    });

    it('aborts on timeout', async () => {
        const slowFetch = jest.fn((_url: string | URL | Request, init?: RequestInit) => {
            return new Promise<Response>((_, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    const err = new Error('aborted') as Error & { name: string };
                    err.name = 'AbortError';
                    reject(err);
                });
            });
        });
        await expect(mintInstallationToken({
            installationId: 'x', jwt: 'x',
            fetch:          slowFetch as unknown as typeof globalThis.fetch,
            timeoutMs:      50,
        })).rejects.toMatchObject({ name: 'AbortError' });
    });
```

- [ ] **Step 2: Run**

```
yarn workspace @bedrock/shared run test src/github/mintInstallationToken.test.ts
```
Expected: 5 PASS.

- [ ] **Step 3: Commit**

```bash
git add applications/shared/src/github/mintInstallationToken.test.ts
git commit -m "test(github): error paths + base URL + timeout for mintInstallationToken"
```

---

## Task 5: `createInstallationTokenProvider` — failing test

**Files:**
- Create: `applications/shared/src/github/installationTokenProvider.test.ts`

- [ ] **Step 1: Write the failing test file**

```ts
// applications/shared/src/github/installationTokenProvider.test.ts
import { describe, it, expect, jest } from '@jest/globals';
import { createInstallationTokenProvider } from './installationTokenProvider.js';

function fakeMint(token: string, expiresAtMs: number) {
    return jest.fn(async () => ({ token, expiresAt: new Date(expiresAtMs) }));
}

function fakeSign(jwt = 'signed-jwt') {
    return jest.fn(() => jwt);
}

describe('createInstallationTokenProvider', () => {
    it('first call mints and caches; second call within window reuses', async () => {
        const t0 = 1_700_000_000_000;
        const mint = fakeMint('tok-1', t0 + 60 * 60_000);
        const sign = fakeSign();
        const get = createInstallationTokenProvider({
            appId:          '1',
            privateKeyPem:  'pem',
            installationId: 'inst-1',
            now:            () => t0,
            mint:           mint as unknown as typeof import('./mintInstallationToken.js').mintInstallationToken,
            sign:           sign as unknown as typeof import('./appJwt.js').signGitHubAppJwt,
        });

        expect(await get()).toBe('tok-1');
        expect(await get()).toBe('tok-1');
        expect(mint).toHaveBeenCalledTimes(1);
        expect(sign).toHaveBeenCalledTimes(1);
    });
});
```

- [ ] **Step 2: Run, verify FAIL**

```
yarn workspace @bedrock/shared run test src/github/installationTokenProvider.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Commit**

```bash
git add applications/shared/src/github/installationTokenProvider.test.ts
git commit -m "test(github): failing cache test for createInstallationTokenProvider"
```

---

## Task 6: `createInstallationTokenProvider` — implementation

**Files:**
- Create: `applications/shared/src/github/installationTokenProvider.ts`

- [ ] **Step 1: Write the implementation**

```ts
// applications/shared/src/github/installationTokenProvider.ts
/**
 * @format
 * Builds a token provider for GitHubAdapter: returns () => Promise<string>
 * that caches the installation token and refreshes it when remaining
 * lifetime drops below `refreshThresholdMs` (default 5 min). Concurrent
 * refreshes are coalesced via a single in-flight Promise.
 */

import { signGitHubAppJwt } from './appJwt.js';
import {
    mintInstallationToken,
    type InstallationToken,
} from './mintInstallationToken.js';

export interface InstallationTokenProviderOpts {
    appId:               string | number;
    privateKeyPem:       string;
    installationId:      string;
    /** Refresh when remaining lifetime drops below this many ms; default 5*60_000. */
    refreshThresholdMs?: number;
    /** Test seam. */
    now?:                () => number;
    /** Test seam. */
    mint?:               typeof mintInstallationToken;
    /** Test seam. */
    sign?:               typeof signGitHubAppJwt;
}

export type GitHubTokenProvider = () => Promise<string>;

const DEFAULT_REFRESH_THRESHOLD_MS = 5 * 60_000;

export function createInstallationTokenProvider(
    opts: InstallationTokenProviderOpts,
): GitHubTokenProvider {
    let cached:   { token: string; expiresAtMs: number } | undefined;
    let inFlight: Promise<InstallationToken> | undefined;

    return async function getToken(): Promise<string> {
        const now       = opts.now?.() ?? Date.now();
        const threshold = opts.refreshThresholdMs ?? DEFAULT_REFRESH_THRESHOLD_MS;

        if (cached && cached.expiresAtMs - now > threshold) {
            return cached.token;
        }

        if (!inFlight) {
            const sign = opts.sign ?? signGitHubAppJwt;
            const mint = opts.mint ?? mintInstallationToken;
            inFlight = (async () => {
                try {
                    const jwt = sign({ appId: opts.appId, privateKeyPem: opts.privateKeyPem });
                    const r   = await mint({ installationId: opts.installationId, jwt });
                    cached = { token: r.token, expiresAtMs: r.expiresAt.getTime() };
                    return r;
                } finally {
                    inFlight = undefined;
                }
            })();
        }
        await inFlight;
        if (!cached) throw new Error('installation token unavailable (mint failed)');
        return cached.token;
    };
}
```

- [ ] **Step 2: Run the failing test**

```
yarn workspace @bedrock/shared run test src/github/installationTokenProvider.test.ts
```
Expected: 1 PASS.

- [ ] **Step 3: Typecheck**

```
yarn workspace @bedrock/shared run typecheck
```
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add applications/shared/src/github/installationTokenProvider.ts
git commit -m "feat(github): createInstallationTokenProvider — refresh-near-expiry cache"
```

---

## Task 7: `createInstallationTokenProvider` — full coverage

**Files:**
- Modify: `applications/shared/src/github/installationTokenProvider.test.ts`

- [ ] **Step 1: Append the remaining 5 cases**

Append inside the existing `describe`:

```ts
    it('refreshes when remaining lifetime <= refreshThresholdMs', async () => {
        const t0 = 1_700_000_000_000;
        const mint = jest.fn()
            .mockResolvedValueOnce({ token: 'tok-1', expiresAt: new Date(t0 + 60 * 60_000) })
            .mockResolvedValueOnce({ token: 'tok-2', expiresAt: new Date(t0 + 120 * 60_000) });
        let nowMs = t0;
        const get = createInstallationTokenProvider({
            appId: '1', privateKeyPem: 'pem', installationId: 'inst-1',
            now: () => nowMs,
            mint: mint as unknown as typeof import('./mintInstallationToken.js').mintInstallationToken,
            sign: (() => 'jwt') as unknown as typeof import('./appJwt.js').signGitHubAppJwt,
        });

        expect(await get()).toBe('tok-1');
        // Advance to 4 min before expiry (i.e. within the 5-min refresh window).
        nowMs = t0 + 56 * 60_000;
        expect(await get()).toBe('tok-2');
        expect(mint).toHaveBeenCalledTimes(2);
    });

    it('coalesces concurrent refresh into one mint call', async () => {
        const t0 = 1_700_000_000_000;
        let resolveMint!: (v: { token: string; expiresAt: Date }) => void;
        const mint = jest.fn(() => new Promise<{ token: string; expiresAt: Date }>((res) => {
            resolveMint = res;
        }));
        const get = createInstallationTokenProvider({
            appId: '1', privateKeyPem: 'pem', installationId: 'inst-1',
            now:  () => t0,
            mint: mint as unknown as typeof import('./mintInstallationToken.js').mintInstallationToken,
            sign: (() => 'jwt') as unknown as typeof import('./appJwt.js').signGitHubAppJwt,
        });

        const p1 = get();
        const p2 = get();
        const p3 = get();

        resolveMint({ token: 'tok-1', expiresAt: new Date(t0 + 60 * 60_000) });
        expect(await p1).toBe('tok-1');
        expect(await p2).toBe('tok-1');
        expect(await p3).toBe('tok-1');
        expect(mint).toHaveBeenCalledTimes(1);
    });

    it('honors a custom refreshThresholdMs', async () => {
        const t0 = 1_700_000_000_000;
        const mint = jest.fn()
            .mockResolvedValueOnce({ token: 'tok-1', expiresAt: new Date(t0 + 60 * 60_000) })
            .mockResolvedValueOnce({ token: 'tok-2', expiresAt: new Date(t0 + 120 * 60_000) });
        let nowMs = t0;
        const get = createInstallationTokenProvider({
            appId: '1', privateKeyPem: 'pem', installationId: 'inst-1',
            refreshThresholdMs: 60_000,        // 1 minute
            now:  () => nowMs,
            mint: mint as unknown as typeof import('./mintInstallationToken.js').mintInstallationToken,
            sign: (() => 'jwt') as unknown as typeof import('./appJwt.js').signGitHubAppJwt,
        });

        expect(await get()).toBe('tok-1');
        // At 5 min before expiry the default would refresh; with a 1-min
        // threshold the cache is still fresh.
        nowMs = t0 + 55 * 60_000;
        expect(await get()).toBe('tok-1');
        expect(mint).toHaveBeenCalledTimes(1);
        // At 30 s before expiry, the 1-min threshold triggers refresh.
        nowMs = t0 + 60 * 60_000 - 30_000;
        expect(await get()).toBe('tok-2');
        expect(mint).toHaveBeenCalledTimes(2);
    });

    it('signs the JWT on every mint, not on every getToken', async () => {
        const t0 = 1_700_000_000_000;
        const mint = jest.fn(async () => ({ token: 't', expiresAt: new Date(t0 + 60 * 60_000) }));
        const sign = jest.fn(() => 'jwt');
        const get = createInstallationTokenProvider({
            appId: '1', privateKeyPem: 'pem', installationId: 'inst-1',
            now:  () => t0,
            mint: mint as unknown as typeof import('./mintInstallationToken.js').mintInstallationToken,
            sign: sign as unknown as typeof import('./appJwt.js').signGitHubAppJwt,
        });

        await get();
        await get();
        await get();
        expect(sign).toHaveBeenCalledTimes(1);
        expect(mint).toHaveBeenCalledTimes(1);
    });

    it('mint failure surfaces; cache stays empty; next call retries', async () => {
        const t0 = 1_700_000_000_000;
        const mint = jest.fn()
            .mockRejectedValueOnce(new Error('first fail'))
            .mockResolvedValueOnce({ token: 'tok-1', expiresAt: new Date(t0 + 60 * 60_000) });
        const get = createInstallationTokenProvider({
            appId: '1', privateKeyPem: 'pem', installationId: 'inst-1',
            now:  () => t0,
            mint: mint as unknown as typeof import('./mintInstallationToken.js').mintInstallationToken,
            sign: (() => 'jwt') as unknown as typeof import('./appJwt.js').signGitHubAppJwt,
        });

        await expect(get()).rejects.toThrow(/first fail/);
        expect(await get()).toBe('tok-1');
        expect(mint).toHaveBeenCalledTimes(2);
    });
```

- [ ] **Step 2: Run**

```
yarn workspace @bedrock/shared run test src/github/installationTokenProvider.test.ts
```
Expected: 6 PASS.

- [ ] **Step 3: Commit**

```bash
git add applications/shared/src/github/installationTokenProvider.test.ts
git commit -m "test(github): cache, refresh, coalescing, threshold, retry coverage"
```

---

## Task 8: Shared barrel — export new helpers

**Files:**
- Modify: `applications/shared/src/github/index.ts`
- Modify: `applications/shared/src/index.ts`

- [ ] **Step 1: Extend `applications/shared/src/github/index.ts`**

Append:

```ts
export { mintInstallationToken, MintInstallationTokenError } from './mintInstallationToken.js';
export type { MintInstallationTokenOpts, InstallationToken } from './mintInstallationToken.js';
export { createInstallationTokenProvider } from './installationTokenProvider.js';
export type { InstallationTokenProviderOpts, GitHubTokenProvider } from './installationTokenProvider.js';
```

- [ ] **Step 2: Extend `applications/shared/src/index.ts`**

In the existing `// ─── GitHub App Helpers ───` block, replace the two lines with:

```ts
export {
    signGitHubAppJwt, GitHubAppJwtError,
    verifyWebhookSignature,
    revokeInstallation,
    mintInstallationToken, MintInstallationTokenError,
    createInstallationTokenProvider,
} from './github/index.js';
export type {
    AppJwtOptions,
    RevokeInstallationOpts, RevokeInstallationResult,
    MintInstallationTokenOpts, InstallationToken,
    InstallationTokenProviderOpts, GitHubTokenProvider,
} from './github/index.js';
```

- [ ] **Step 3: Rebuild shared dist**

```
yarn workspace @bedrock/shared run build
```
Expected: exit 0.

- [ ] **Step 4: Typecheck**

```
yarn workspace @bedrock/shared run typecheck
```
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/github/index.ts applications/shared/src/index.ts
git commit -m "feat(shared): export mintInstallationToken + createInstallationTokenProvider"
```

---

## Task 9: OAuth repo — `getInstallationIdByUserAndProvider`

**Files:**
- Modify: `applications/shared/src/rds/interfaces/IOAuthConnectionsRepository.ts`
- Modify: `applications/shared/src/rds/implementations/RdsOAuthConnectionsRepository.ts`
- Modify: `applications/shared/src/rds/implementations/RdsOAuthConnectionsRepository.test.ts`

- [ ] **Step 1: Extend the interface**

In `IOAuthConnectionsRepository.ts`, add to the `IOAuthConnectionsRepository` interface (before the closing `}`):

```ts
    /**
     * Plain SQL lookup for `installation_id` — no envelope decryption.
     * Used by consumers that need the installation reference without
     * touching the encrypted access token (e.g. ingestion jobs).
     */
    getInstallationIdByUserAndProvider(userId: string, provider: string): Promise<string | null>;
```

- [ ] **Step 2: Make envelope optional + implement the method**

In `RdsOAuthConnectionsRepository.ts`, change the constructor's deps type:

Before:
```ts
constructor(
    private readonly deps: {
        pool:     Pool;
        envelope: KmsEnvelope;
    },
) {}
```

After:
```ts
constructor(
    private readonly deps: {
        pool:      Pool;
        envelope?: KmsEnvelope;
    },
) {}
```

Find `decryptRow` and add a guard at the top of its envelope branch:

```ts
if (
    row.access_token_ciphertext &&
    row.access_token_dek &&
    row.access_token_iv &&
    row.access_token_tag
) {
    if (!this.deps.envelope) {
        throw new Error(
            `RdsOAuthConnectionsRepository: envelope is required to decrypt row ${row.id} but was not provided`,
        );
    }
    return await this.deps.envelope.decrypt(
        /* ... */
    );
}
```

Add the new method below the existing `markSuspended`:

```ts
async getInstallationIdByUserAndProvider(userId: string, provider: string): Promise<string | null> {
    const res = await this.deps.pool.query<{ installation_id: string | null }>(
        `SELECT installation_id FROM oauth_connections WHERE user_id = $1 AND provider = $2`,
        [userId, provider],
    );
    return res.rows[0]?.installation_id ?? null;
}
```

- [ ] **Step 3: Append two tests**

In `RdsOAuthConnectionsRepository.test.ts`, append a new describe block at the end:

```ts
describe('RdsOAuthConnectionsRepository.getInstallationIdByUserAndProvider', () => {
    it('returns installation_id for an existing row', async () => {
        const pool = fakePool([{ rows: [{ installation_id: 'inst-42' }] }]);
        const repo = newRepo(pool, fakeEnvelope());
        const out = await repo.getInstallationIdByUserAndProvider('u1', 'github');
        expect(out).toBe('inst-42');
        expect(pool.calls[0]!.sql).toMatch(/SELECT installation_id FROM oauth_connections WHERE user_id = \$1 AND provider = \$2/);
        expect(pool.calls[0]!.params).toEqual(['u1', 'github']);
    });

    it('returns null when no row matches', async () => {
        const pool = fakePool([{ rows: [] }]);
        const repo = newRepo(pool, fakeEnvelope());
        expect(await repo.getInstallationIdByUserAndProvider('missing', 'github')).toBeNull();
    });
});
```

- [ ] **Step 4: Run**

```
yarn workspace @bedrock/shared run test src/rds/implementations/RdsOAuthConnectionsRepository.test.ts
```
Expected: all existing tests + 2 new pass.

- [ ] **Step 5: Typecheck**

```
yarn workspace @bedrock/shared run typecheck
```
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add applications/shared/src/rds/interfaces/IOAuthConnectionsRepository.ts \
        applications/shared/src/rds/implementations/RdsOAuthConnectionsRepository.ts \
        applications/shared/src/rds/implementations/RdsOAuthConnectionsRepository.test.ts
git commit -m "feat(rds): getInstallationIdByUserAndProvider — no envelope decryption"
```

---

## Task 10: `GitHubAdapter` refactor — failing test

**Files:**
- Create: `applications/shared/src/ingestion/implementations/GitHubAdapter.test.ts`

- [ ] **Step 1: Inspect the current adapter for how it calls https.request**

Run: `grep -n "https.request\|this.token\|private readonly token" applications/shared/src/ingestion/implementations/GitHubAdapter.ts`
Note the line numbers; the implementation tests reference them.

- [ ] **Step 2: Write the failing test**

```ts
// applications/shared/src/ingestion/implementations/GitHubAdapter.test.ts
import { describe, it, expect, jest } from '@jest/globals';
import * as https from 'node:https';
import { EventEmitter } from 'node:events';
import { GitHubAdapter } from './GitHubAdapter.js';

/**
 * Stubs https.request: returns a writable-ish ClientRequest that completes
 * with the supplied body + status when `req.end()` is called.
 */
function stubHttpsRequest(body: object, status = 200): {
    spy: jest.SpyInstance;
    captured: { headers: Record<string, string> }[];
} {
    const captured: { headers: Record<string, string> }[] = [];
    const spy = jest.spyOn(https, 'request').mockImplementation((options: unknown, cb?: unknown) => {
        captured.push({ headers: (options as { headers: Record<string, string> }).headers });

        const res = new EventEmitter() as EventEmitter & { statusCode?: number };
        res.statusCode = status;
        const req = new EventEmitter() as EventEmitter & { end: () => void; write: () => void };
        req.end = (): void => {
            setImmediate(() => {
                (cb as (r: typeof res) => void)?.(res);
                res.emit('data', Buffer.from(JSON.stringify(body), 'utf-8'));
                res.emit('end');
            });
        };
        req.write = (): void => {};
        return req as unknown as ReturnType<typeof https.request>;
    });
    return { spy, captured };
}

describe('GitHubAdapter', () => {
    it('calls tokenProvider before each HTTPS request and forwards the token in Authorization', async () => {
        const tokens = ['t1', 't2', 't3'];
        let i = 0;
        const provider = jest.fn(async () => tokens[i++]!);

        // Two-step `listFiles`: it does at least 2 HTTPS calls (repo info + tree).
        // We arrange enough stubs for those two + an extra getRepoMeta call.
        const { spy, captured } = stubHttpsRequest({
            default_branch: 'main',
            tree: [{ path: 'README.md', type: 'blob', size: 100 }],
            truncated: false,
        });

        const adapter = new GitHubAdapter(provider as unknown as () => Promise<string>);
        await adapter.listFiles('owner/repo');

        // listFiles makes 2 calls: GET /repos/{repo} then GET /repos/{repo}/git/trees/...
        expect(provider).toHaveBeenCalledTimes(2);
        expect(captured[0]!.headers['Authorization']).toBe('Bearer t1');
        expect(captured[1]!.headers['Authorization']).toBe('Bearer t2');

        spy.mockRestore();
    });

    it('fromTokenString wraps a static token as a provider', async () => {
        const adapter = GitHubAdapter.fromTokenString('static-token');
        const { spy, captured } = stubHttpsRequest({
            default_branch: 'main',
            tree: [{ path: 'a.md', type: 'blob', size: 1 }],
            truncated: false,
        });

        await adapter.listFiles('owner/repo');
        expect(captured[0]!.headers['Authorization']).toBe('Bearer static-token');

        spy.mockRestore();
    });
});
```

- [ ] **Step 3: Run, expect FAIL**

```
yarn workspace @bedrock/shared run test src/ingestion/implementations/GitHubAdapter.test.ts
```
Expected: FAIL — either constructor mismatch (still expects string) or `fromTokenString` not defined.

- [ ] **Step 4: Commit**

```bash
git add applications/shared/src/ingestion/implementations/GitHubAdapter.test.ts
git commit -m "test(ingestion): failing tokenProvider tests for GitHubAdapter"
```

---

## Task 11: `GitHubAdapter` refactor — implementation

**Files:**
- Modify: `applications/shared/src/ingestion/implementations/GitHubAdapter.ts`

- [ ] **Step 1: Replace constructor and add the static**

Locate (around line 115–132):

```ts
export class GitHubAdapter implements IRepoAdapter {
    private readonly token: string;
    private readonly apiBase = 'api.github.com';

    constructor(token: string) {
        this.token = token;
    }

    static fromEnvironment(): GitHubAdapter {
        const token = process.env.GITHUB_TOKEN;
        if (!token) {
            throw new Error(
                'GitHubAdapter: GITHUB_TOKEN environment variable is required',
            );
        }
        return new GitHubAdapter(token);
    }
```

Replace with:

```ts
export type GitHubTokenProvider = () => Promise<string>;

export class GitHubAdapter implements IRepoAdapter {
    private readonly apiBase = 'api.github.com';

    constructor(private readonly tokenProvider: GitHubTokenProvider) {}

    /**
     * Convenience for callers that have a static token (e.g. smoke
     * scripts). Wraps the string in a provider that always returns it.
     */
    static fromTokenString(token: string): GitHubAdapter {
        return new GitHubAdapter(async () => token);
    }
```

(Note: `fromEnvironment` is removed.)

- [ ] **Step 2: Update the private `get<T>` helper**

Locate the private `get<T>(path: string)` method (around line 340–375). The `headers.Authorization` value currently reads `Bearer ${this.token}`. Change the method body so the token is fetched per call:

```ts
private get<T>(path: string): Promise<T> {
    return new Promise((resolve, reject) => {
        (async () => {
            const token = await this.tokenProvider();
            const options = {
                hostname: this.apiBase,
                path,
                method:   'GET',
                headers:  {
                    'Authorization': `Bearer ${token}`,
                    'User-Agent':    'portfolio-ingestion/1.0',
                    'Accept':        'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            };

            const req = https.request(options, res => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf-8');
                    if (!res.statusCode || res.statusCode >= 400) {
                        reject(new Error(
                            `GitHub API ${path} returned ${res.statusCode}: ${body}`,
                        ));
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
        })().catch(reject);
    });
}
```

The new `async` IIFE inside the existing `new Promise` lets us `await` the provider while still using the existing `https.request` callback pattern. `.catch(reject)` propagates a thrown provider error as a rejected promise.

- [ ] **Step 3: Run the test, expect PASS**

```
yarn workspace @bedrock/shared run test src/ingestion/implementations/GitHubAdapter.test.ts
```
Expected: 2 PASS.

- [ ] **Step 4: Typecheck**

```
yarn workspace @bedrock/shared run typecheck
```
Expected: exit 0.

- [ ] **Step 5: Rebuild shared dist**

```
yarn workspace @bedrock/shared run build
```
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add applications/shared/src/ingestion/implementations/GitHubAdapter.ts
git commit -m "refactor(ingestion): GitHubAdapter accepts a token provider"
```

---

## Task 12: Smoke script — one-line update

**Files:**
- Modify: `scripts/smoke-test-github-adapter.ts`

- [ ] **Step 1: Replace the construction line**

Find:
```ts
const adapter = new GitHubAdapter(token);
```

Replace with:
```ts
const adapter = GitHubAdapter.fromTokenString(token);
```

- [ ] **Step 2: Typecheck**

```
yarn workspace @bedrock/shared run typecheck
```
Expected: exit 0. (Smoke scripts share the shared typecheck via tsconfig roots.)

If the smoke script is in a workspace that runs its own typecheck (e.g. `@repo/script-utils` or the root), run that workspace's typecheck instead.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-test-github-adapter.ts
git commit -m "chore(scripts): smoke-test-github-adapter uses fromTokenString"
```

---

## Task 13: Ingestion env — drop `GITHUB_TOKEN`, add `GITHUB_APP_SECRET_ARN`

**Files:**
- Modify: `applications/ingestion/src/env.ts`

- [ ] **Step 1: Update the interface and parser**

Replace the existing `IngestionEnv` interface and `parseEnv` function with:

```ts
/**
 * @format
 * Environment variable parser for the ingestion K8s Job.
 * Validates required vars at startup; throws on missing.
 */

export interface IngestionEnv {
    readonly userId:                   string;
    readonly repoFullName:             string;
    readonly forceReindex:             boolean;
    readonly githubAppSecretArn:       string;
    readonly awsRegion:                string;
    readonly profileExtractorModelId:  string;
    readonly pg: {
        readonly host:     string;
        readonly port:     number;
        readonly database: string;
        readonly user:     string;
        readonly password: string;
    };
}

function required(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

export function parseEnv(): IngestionEnv {
    return {
        userId:                  required('USER_ID'),
        repoFullName:            required('REPO_FULL_NAME'),
        forceReindex:            (process.env['FORCE_REINDEX'] ?? 'false').toLowerCase() === 'true',
        githubAppSecretArn:      required('GITHUB_APP_SECRET_ARN'),
        awsRegion:               process.env['AWS_REGION']
                              ?? process.env['AWS_DEFAULT_REGION']
                              ?? 'eu-west-1',
        profileExtractorModelId: process.env['PROFILE_EXTRACTOR_MODEL_ID']
            ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
        pg: {
            host:     required('PG_HOST'),
            port:     Number.parseInt(process.env['PG_PORT'] ?? '5432', 10),
            database: required('PG_DATABASE'),
            user:     required('PG_USER'),
            password: required('PG_PASSWORD'),
        },
    };
}
```

- [ ] **Step 2: Find and update any env tests if they exist**

```
find applications/ingestion -name "env.test*" -not -path "*/node_modules/*"
```

If a file exists, update fixtures: drop `GITHUB_TOKEN`, add
`GITHUB_APP_SECRET_ARN: 'arn:aws:secretsmanager:eu-west-1:0:secret/gh-app-test'`,
update any assertions referencing `githubToken` to `githubAppSecretArn`.

If no test file exists, skip — no test work needed beyond the parser change.

- [ ] **Step 3: Typecheck**

```
yarn workspace @bedrock/ingestion run typecheck
```
Expected: exit 0. (This may flag downstream consumers of `env.githubToken` — they get fixed in Task 14.)

If typecheck fails at this step with errors about `env.githubToken` being undefined, that's expected — Task 14's run-ingestion.ts edit clears them.

- [ ] **Step 4: Commit**

```bash
git add applications/ingestion/src/env.ts
git commit -m "feat(ingestion): require GITHUB_APP_SECRET_ARN (drop GITHUB_TOKEN)"
```

---

## Task 14: Ingestion boot — wire installation token provider

**Files:**
- Modify: `applications/ingestion/src/run-ingestion.ts`

- [ ] **Step 1: Inspect the current `main` flow**

Run: `sed -n '150,220p' applications/ingestion/src/run-ingestion.ts`
Note where `parseEnv()` is called, where the `Pool` is constructed (if at all here), and where `new GitHubAdapter(...)` happens.

- [ ] **Step 2: Add new imports at the top**

Find the existing imports block. Ensure these are present (add any that are not):

```ts
import { Pool } from 'pg';
import {
    RdsOAuthConnectionsRepository,
    getGitHubAppSecrets,
    createInstallationTokenProvider,
} from '@bedrock/shared';
```

Keep the existing `import { GitHubAdapter } from '@bedrock/shared';` line as-is — only add what's missing.

- [ ] **Step 3: Replace the adapter construction block**

Locate:
```ts
const repoAdapter  = new GitHubAdapter(env.githubToken);
```

If a `Pool` is already constructed earlier in `main()` for an existing repository (e.g. `RdsSyncStateRepository`), reuse it as `pool`. If not, construct one before the adapter wiring (place it just after `const env = parseEnv();`):

```ts
const pool = new Pool({
    host:     env.pg.host,
    port:     env.pg.port,
    database: env.pg.database,
    user:     env.pg.user,
    password: env.pg.password,
});
```

Then replace the `const repoAdapter = new GitHubAdapter(env.githubToken);` line with:

```ts
const oauthRepo = new RdsOAuthConnectionsRepository({ pool });   // envelope omitted — we only read installation_id

const installationId = await oauthRepo.getInstallationIdByUserAndProvider(env.userId, 'github');
if (!installationId) {
    throw new Error(
        `User ${env.userId} has no GitHub App installation linked to their oauth_connections row. ` +
        `Ingestion cannot run without it. Confirm the user has installed the App in their GitHub account.`,
    );
}

const secrets = await getGitHubAppSecrets({
    secretArn: env.githubAppSecretArn,
    region:    env.awsRegion,
});

const tokenProvider = createInstallationTokenProvider({
    appId:          secrets.appId,
    privateKeyPem:  secrets.privateKeyPem,
    installationId,
});

const repoAdapter = new GitHubAdapter(tokenProvider);
```

If `pool` was already constructed by other code, do NOT duplicate it.

- [ ] **Step 4: Typecheck**

```
yarn workspace @bedrock/ingestion run typecheck
```
Expected: exit 0.

- [ ] **Step 5: Run ingestion tests (if any exist)**

```
yarn workspace @bedrock/ingestion run test
```
Expected: green (`--passWithNoTests` is set in the package's jest config; if there are no tests it still exits 0).

- [ ] **Step 6: Commit**

```bash
git add applications/ingestion/src/run-ingestion.ts
git commit -m "feat(ingestion): mint installation tokens from oauth_connections.installation_id"
```

---

## Task 15: Full verification + push + PR

**Files:** none — operational.

- [ ] **Step 1: Run every affected suite**

```
yarn workspace @bedrock/shared run test src/aws/ src/github/ src/crypto/ src/rds/ src/ingestion/
yarn workspace @repo/public-api run test __tests__/
yarn workspace @bedrock/ingestion run test
```
Expected: all green.

- [ ] **Step 2: Typecheck across all four workspaces**

```
yarn workspace @bedrock/shared run typecheck
yarn workspace @repo/public-api run typecheck
yarn workspace @bedrock/ingestion run typecheck
```

If the smoke script is in a workspace with its own typecheck (e.g. `@repo/script-utils`), include it too.

- [ ] **Step 3: Branch-diff sanity check**

```
git log --oneline oauth-soft-delete-revoke..HEAD
```
Expected: roughly 14 commits matching Tasks 1–14.

If PR-2c has merged by now, rebase:
```
git fetch origin develop
git rebase origin/develop
```

- [ ] **Step 4: Push**

```
git push -u origin ingestion-installation-tokens
```

- [ ] **Step 5: Open PR**

Stack on PR-2c if still open; otherwise base on `develop`.

```bash
BASE_PR=20    # PR-2c
BASE=$(gh pr view "$BASE_PR" --json state --jq '.state' 2>/dev/null | grep -q OPEN \
    && echo oauth-soft-delete-revoke || echo develop)

gh pr create \
  --base "$BASE" \
  --title "feat: ingestion installation tokens (PR-3)" \
  --body-file - <<'EOF'
## Summary

Replaces ingestion's shared `GITHUB_TOKEN` PAT with per-user GitHub App
installation tokens. Adds `mintInstallationToken` +
`createInstallationTokenProvider` in `@bedrock/shared`, refactors
`GitHubAdapter` to accept a token-provider closure, and rewires
ingestion boot to look up the user's `installation_id` and mint
refreshable tokens.

### What ships

- `applications/shared/src/aws/githubAppSecrets.ts` — moved from
  public-api; cache keyed on `secretArn` so multiple consumers share
  cleanly.
- `applications/shared/src/github/mintInstallationToken.ts` — pure
  HTTP client for `POST /app/installations/{id}/access_tokens`.
- `applications/shared/src/github/installationTokenProvider.ts` —
  refresh-near-expiry cache with concurrent-refresh coalescing.
- `GitHubAdapter(tokenProvider: () => Promise<string>)` — surface
  unchanged; constructor now takes a provider. `fromTokenString()`
  static for the smoke script.
- `RdsOAuthConnectionsRepository.getInstallationIdByUserAndProvider` —
  plain SQL, no envelope. Constructor's `envelope` is now optional.
- `applications/ingestion/src/env.ts` — `GITHUB_TOKEN` replaced by
  `GITHUB_APP_SECRET_ARN`; added `awsRegion`.

### Operator runbook

1. Update the ingestion K8s Job manifest:
   - Add `GITHUB_APP_SECRET_ARN` env var (same ARN PR-2b/2c use).
   - Remove `GITHUB_TOKEN` env (no longer read).
   - Confirm the EKS node IAM role has
     `secretsmanager:GetSecretValue` on the ARN (already true if
     PR-2b is deployed).
2. Confirm every user with active ingestion has a populated
   `oauth_connections.installation_id`:
   ```sql
   SELECT user_id FROM oauth_connections
   WHERE provider = 'github' AND installation_id IS NULL;
   ```
   Any rows returned → ask those users to reinstall the App before
   their next ingestion run.
3. Deploy this PR.
4. Trigger ingestion for a test user; expect normal completion.

### Deferred / out of scope

- Retry-on-401 in `GitHubAdapter` (mid-run revocation handling) —
  YAGNI; operator re-runs after reinstall.
- Removing `oauth_connections.access_token_*` columns — OAuth callback
  path still writes them.
- Migrating the smoke script to App auth — stays on `GITHUB_TOKEN`.

## Test Plan

- [x] `yarn workspace @bedrock/shared run test src/github/ src/aws/ src/rds/ src/ingestion/` — all green; 9 new aws tests + 5 mint + 6 provider + 2 repo + 2 adapter tests.
- [x] `yarn workspace @repo/public-api run test __tests__/` — green; PR-2b/2c routes unaffected via the wrapper.
- [x] `yarn workspace @bedrock/ingestion run test` — green.
- [x] Typecheck across all workspaces — exit 0.
- [ ] Reviewer: confirm the operator runbook is followed before
      deploy (esp. the `installation_id IS NULL` audit).

## Spec / Plan

- Design: `docs/superpowers/specs/2026-05-21-ingestion-installation-tokens-design.md`
- Plan:   `docs/superpowers/plans/2026-05-21-ingestion-installation-tokens.md`
- Builds on PR-1 (#17), PR-2a (#18), PR-2b (#19), PR-2c (#20).
EOF
```

---

## Out of this plan (tracked elsewhere)

- Retry-on-401 in `GitHubAdapter`.
- Removing `oauth_connections.access_token_*` once nothing reads it.
- Migrating the smoke script to App auth.
- IRSA migration for the ingestion job.
