# GitHub Webhook + App JWT Implementation Plan (PR-2b of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pure GitHub App JWT signer + a pure HMAC webhook verifier in `@bedrock/shared/github`, plus a `POST /webhooks/github` route in public-api that handles `installation.deleted` / `installation.suspended` and calls PR-2a's `markRevoked` / `markSuspended` via the lazy `getOAuthConnectionsRepo`.

**Architecture:** Pure helpers in shared (`signGitHubAppJwt`, `verifyWebhookSignature`) carry zero AWS/HTTP knowledge and are reusable by PR-2c. A TTL-cached Secrets Manager fetcher in public-api mirrors the proven `chatbot.ts:getApiKey` pattern and returns a validated `{appId, privateKeyPem, webhookSecret}` shape. The webhook route is thin orchestration: verify → JSON.parse → switch → call repo, with one structured log line per branch keyed on `X-GitHub-Delivery`.

**Tech Stack:** TypeScript, Node 22, `node:crypto` (RS256 + HMAC-SHA256 + timingSafeEqual), Hono on Node, AWS SDK v3 (`@aws-sdk/client-secrets-manager`), Jest + `aws-sdk-client-mock`.

**Spec:** [docs/superpowers/specs/2026-05-21-github-webhook-and-app-jwt-design.md](../specs/2026-05-21-github-webhook-and-app-jwt-design.md)

---

## File Structure

**Create:**
- `applications/shared/src/github/appJwt.ts` — `signGitHubAppJwt`, `GitHubAppJwtError`
- `applications/shared/src/github/appJwt.test.ts`
- `applications/shared/src/github/webhookSignature.ts` — `verifyWebhookSignature`
- `applications/shared/src/github/webhookSignature.test.ts`
- `applications/shared/src/github/index.ts` — barrel
- `api/public-api/src/lib/githubAppSecrets.ts` — `getGitHubAppSecrets`, `__resetGitHubAppSecretsCacheForTests`
- `api/public-api/__tests__/lib/githubAppSecrets.test.ts`
- `api/public-api/src/routes/github-webhook.ts` — `POST /webhooks/github`
- `api/public-api/__tests__/routes/github-webhook.test.ts`

**Modify:**
- `applications/shared/src/index.ts` — re-export `signGitHubAppJwt`, `GitHubAppJwtError`, `verifyWebhookSignature`
- `api/public-api/src/lib/config.ts` — add `githubAppSecretArn: string` + required env
- `api/public-api/__tests__/lib/config.test.ts` — assert `GITHUB_APP_SECRET_ARN` is required
- `api/public-api/src/index.ts` — mount the new route

---

## Task 1: JWT helper — failing roundtrip test

**Files:**
- Create: `applications/shared/src/github/appJwt.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// applications/shared/src/github/appJwt.test.ts
import { describe, it, expect, beforeAll } from '@jest/globals';
import { generateKeyPairSync } from 'node:crypto';
import { signGitHubAppJwt, GitHubAppJwtError } from './appJwt.js';

let privateKeyPem: string;
let publicKeyPem:  string;

beforeAll(() => {
    const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKeyPem = kp.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    publicKeyPem  = kp.publicKey.export({  type: 'spki',  format: 'pem' }).toString();
});

function decodeJwt(token: string): { header: unknown; payload: unknown; sig: Buffer; signingInput: string } {
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) throw new Error('bad jwt shape');
    const fromB64Url = (str: string): Buffer => Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return {
        header:       JSON.parse(fromB64Url(h).toString('utf8')),
        payload:      JSON.parse(fromB64Url(p).toString('utf8')),
        sig:          fromB64Url(s),
        signingInput: `${h}.${p}`,
    };
}

describe('signGitHubAppJwt', () => {
    it('produces RS256 JWT with iat=now-60, exp=now+540, iss=appId by default', () => {
        const fixedNow = 1_700_000_000_000; // ms
        const token = signGitHubAppJwt({
            appId:         42,
            privateKeyPem,
            now:           () => fixedNow,
        });
        const { header, payload } = decodeJwt(token);
        expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
        expect(payload).toEqual({
            iat: Math.floor(fixedNow / 1000) - 60,
            exp: Math.floor(fixedNow / 1000) + 540,
            iss: '42',
        });
    });
});

// referenced so unused-import lint doesn't trip; GitHubAppJwtError test lands in Task 4
void GitHubAppJwtError;
void publicKeyPem;
```

- [ ] **Step 2: Run, verify failure**

Run: `yarn workspace @bedrock/shared run test src/github/appJwt.test.ts`
Expected: FAIL — `Cannot find module './appJwt.js'`.

- [ ] **Step 3: Commit**

```bash
git add applications/shared/src/github/appJwt.test.ts
git commit -m "test(github): failing roundtrip for signGitHubAppJwt"
```

---

## Task 2: JWT helper — implementation

**Files:**
- Create: `applications/shared/src/github/appJwt.ts`

- [ ] **Step 1: Write the implementation**

```ts
// applications/shared/src/github/appJwt.ts
/**
 * @format
 * Pure RS256 signer for GitHub App authentication.
 *
 * GitHub App JWTs are three claims (iat, exp, iss) signed with the App's
 * RSA private key. There's no need to pull in a JWT library — this file
 * fits in 60 lines using node:crypto.
 *
 * The helper is also reused by PR-2c (outbound DELETE /app/installations/{id})
 * which calls api.github.com with the JWT as Bearer auth.
 */

import {
    createSign,
    constants as cryptoConstants,
} from 'node:crypto';

export interface AppJwtOptions {
    appId:         string | number;
    privateKeyPem: string;
    /** Token lifetime in seconds; default 540 (9 min — GitHub caps at 10). */
    ttlSeconds?:   number;
    /** Test seam — returns current epoch ms; default Date.now. */
    now?:          () => number;
}

export class GitHubAppJwtError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'GitHubAppJwtError';
    }
}

function base64url(input: Buffer | string): string {
    const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
    return buf.toString('base64')
        .replace(/=+$/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

export function signGitHubAppJwt(opts: AppJwtOptions): string {
    const nowMs = opts.now?.() ?? Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
        iat: nowSec - 60,                                // 60s clock-skew slack
        exp: nowSec + (opts.ttlSeconds ?? 540),
        iss: String(opts.appId),
    };

    const h = base64url(JSON.stringify(header));
    const p = base64url(JSON.stringify(payload));
    const signingInput = `${h}.${p}`;

    try {
        const sig = createSign('RSA-SHA256')
            .update(signingInput)
            .sign({
                key:     opts.privateKeyPem,
                padding: cryptoConstants.RSA_PKCS1_PADDING,
            });
        return `${signingInput}.${base64url(sig)}`;
    } catch (err) {
        throw new GitHubAppJwtError('failed to sign GitHub App JWT', { cause: err });
    }
}
```

- [ ] **Step 2: Run the failing test, verify PASS**

Run: `yarn workspace @bedrock/shared run test src/github/appJwt.test.ts`
Expected: 1 PASS.

- [ ] **Step 3: Typecheck**

Run: `yarn workspace @bedrock/shared run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add applications/shared/src/github/appJwt.ts
git commit -m "feat(github): signGitHubAppJwt — RS256 JWT signer"
```

---

## Task 3: JWT helper — additional coverage

**Files:**
- Modify: `applications/shared/src/github/appJwt.test.ts`

- [ ] **Step 1: Append the remaining tests**

Replace the lines `void GitHubAppJwtError;` and `void publicKeyPem;` at the bottom of the file with these tests (and remove those `void` statements):

```ts
    it('honors a custom ttlSeconds', () => {
        const fixedNow = 1_700_000_000_000;
        const token = signGitHubAppJwt({
            appId:         '99',
            privateKeyPem,
            ttlSeconds:    300,
            now:           () => fixedNow,
        });
        const { payload } = decodeJwt(token) as { payload: { iat: number; exp: number } };
        expect(payload.exp - payload.iat).toBe(360); // 300 + 60 slack
    });

    it('default ttl is 540 + 60 slack = 600s window', () => {
        const fixedNow = 1_700_000_000_000;
        const token = signGitHubAppJwt({ appId: 1, privateKeyPem, now: () => fixedNow });
        const { payload } = decodeJwt(token) as { payload: { iat: number; exp: number } };
        expect(payload.exp - payload.iat).toBe(600);
    });

    it('produces a signature that verifies against the matching public key', () => {
        const { createVerify } = require('node:crypto') as typeof import('node:crypto');
        const token = signGitHubAppJwt({ appId: 1, privateKeyPem });
        const { sig, signingInput } = decodeJwt(token);
        const ok = createVerify('RSA-SHA256')
            .update(signingInput)
            .verify({ key: publicKeyPem, padding: cryptoConstants.RSA_PKCS1_PADDING }, sig);
        expect(ok).toBe(true);
    });

    it('wraps a malformed private key as GitHubAppJwtError with cause', () => {
        expect(() => signGitHubAppJwt({ appId: 1, privateKeyPem: 'not-a-pem' }))
            .toThrow(GitHubAppJwtError);
    });
});
```

At the top of the file, add the import needed by the verify test:

```ts
import { constants as cryptoConstants } from 'node:crypto';
```

- [ ] **Step 2: Run all JWT tests**

Run: `yarn workspace @bedrock/shared run test src/github/appJwt.test.ts`
Expected: 5 PASS.

- [ ] **Step 3: Commit**

```bash
git add applications/shared/src/github/appJwt.test.ts
git commit -m "test(github): TTL, signature verify, and error-wrap coverage"
```

---

## Task 4: Webhook signature verifier — failing test

**Files:**
- Create: `applications/shared/src/github/webhookSignature.test.ts`

- [ ] **Step 1: Write the failing test file**

```ts
// applications/shared/src/github/webhookSignature.test.ts
import { describe, it, expect } from '@jest/globals';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature } from './webhookSignature.js';

function signed(body: Buffer, secret: string): string {
    return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifyWebhookSignature', () => {
    const secret = 'topsecret';
    const body   = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8');

    it('returns true for a valid signature', () => {
        expect(verifyWebhookSignature(body, signed(body, secret), secret)).toBe(true);
    });

    it('returns false when the body is tampered', () => {
        const sig = signed(body, secret);
        const tampered = Buffer.from(body);
        tampered[0] ^= 0xff;
        expect(verifyWebhookSignature(tampered, sig, secret)).toBe(false);
    });

    it('returns false when the signature header is tampered', () => {
        const sig = signed(body, secret);
        const t = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');
        expect(verifyWebhookSignature(body, t, secret)).toBe(false);
    });

    it('returns false when the secret is wrong', () => {
        const sig = signed(body, 'other-secret');
        expect(verifyWebhookSignature(body, sig, secret)).toBe(false);
    });

    it('returns false when header is undefined', () => {
        expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
    });

    it('returns false on empty string header', () => {
        expect(verifyWebhookSignature(body, '', secret)).toBe(false);
    });

    it('returns false when header is not sha256-prefixed (e.g. sha1=)', () => {
        const sha1 = 'sha1=' + createHmac('sha1', secret).update(body).digest('hex');
        expect(verifyWebhookSignature(body, sha1, secret)).toBe(false);
    });

    it('returns false when header hex is malformed', () => {
        expect(verifyWebhookSignature(body, 'sha256=not-hex', secret)).toBe(false);
    });

    it('returns false on truncated header (length mismatch, no throw)', () => {
        const sig = signed(body, secret);
        expect(verifyWebhookSignature(body, sig.slice(0, 20), secret)).toBe(false);
    });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `yarn workspace @bedrock/shared run test src/github/webhookSignature.test.ts`
Expected: FAIL — `Cannot find module './webhookSignature.js'`.

- [ ] **Step 3: Commit**

```bash
git add applications/shared/src/github/webhookSignature.test.ts
git commit -m "test(github): failing tests for verifyWebhookSignature"
```

---

## Task 5: Webhook signature verifier — implementation

**Files:**
- Create: `applications/shared/src/github/webhookSignature.ts`

- [ ] **Step 1: Write the implementation**

```ts
// applications/shared/src/github/webhookSignature.ts
/**
 * @format
 * Pure HMAC-SHA256 verifier for GitHub webhook signatures.
 *
 * GitHub signs every webhook delivery with the secret you configure in
 * the App's settings and ships the digest in `X-Hub-Signature-256:
 * sha256=<hex>`. This helper compares the supplied digest to a freshly
 * computed one in constant time and returns false on every malformed-
 * input case — no throwing on bad headers.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhookSignature(
    rawBody:     Buffer,
    headerValue: string | undefined | null,
    secret:      string,
): boolean {
    if (!headerValue || !headerValue.startsWith('sha256=')) return false;

    const expected = Buffer.from(headerValue.slice('sha256='.length), 'hex');
    const actual   = createHmac('sha256', secret).update(rawBody).digest();

    if (expected.length !== actual.length) return false; // also catches malformed hex
    return timingSafeEqual(expected, actual);
}
```

- [ ] **Step 2: Run tests**

Run: `yarn workspace @bedrock/shared run test src/github/webhookSignature.test.ts`
Expected: 9 PASS.

- [ ] **Step 3: Commit**

```bash
git add applications/shared/src/github/webhookSignature.ts
git commit -m "feat(github): verifyWebhookSignature — HMAC-SHA256 timing-safe"
```

---

## Task 6: shared barrel — export new github helpers

**Files:**
- Create: `applications/shared/src/github/index.ts`
- Modify: `applications/shared/src/index.ts`

- [ ] **Step 1: Create the github barrel**

```ts
// applications/shared/src/github/index.ts
export {
    signGitHubAppJwt,
    GitHubAppJwtError,
} from './appJwt.js';
export type { AppJwtOptions } from './appJwt.js';
export { verifyWebhookSignature } from './webhookSignature.js';
```

- [ ] **Step 2: Re-export from the package root**

Open `applications/shared/src/index.ts`. Append (group near the existing OAuth / crypto re-exports added in PR-1 / PR-2a):

```ts
export {
    signGitHubAppJwt,
    GitHubAppJwtError,
    verifyWebhookSignature,
} from './github/index.js';
export type { AppJwtOptions } from './github/index.js';
```

- [ ] **Step 3: Rebuild shared dist**

Run: `yarn workspace @bedrock/shared run build`
Expected: exit 0; `applications/shared/dist/` refreshed (memory `worktree-yarn-shared-dist.md`).

- [ ] **Step 4: Typecheck**

Run: `yarn workspace @bedrock/shared run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/github/index.ts applications/shared/src/index.ts
git commit -m "feat(shared): export github/appJwt + github/webhookSignature"
```

---

## Task 7: public-api config — require `GITHUB_APP_SECRET_ARN`

**Files:**
- Modify: `api/public-api/src/lib/config.ts`
- Modify: `api/public-api/__tests__/lib/config.test.ts`

- [ ] **Step 1: Add field to the `Config` interface**

In `config.ts`, after the existing `oauthTokenKmsKeyArn` field, add:

```ts
  /**
   * Secrets Manager ARN for the GitHub App JSON secret containing
   * `{ appId, privateKeyPem, webhookSecret }`. Sourced from the
   * `GITHUB_APP_SECRET_ARN` env var (ConfigMap).
   */
  readonly githubAppSecretArn: string;
```

- [ ] **Step 2: Add to `required` tuple in `loadConfig`**

Locate the existing `required` tuple — it should contain `PG_HOST`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD`, `OAUTH_TOKEN_KMS_KEY_ARN`. Append `'GITHUB_APP_SECRET_ARN'`:

```ts
  const required = [
    'PG_HOST',
    'PG_DATABASE',
    'PG_USER',
    'PG_PASSWORD',
    'OAUTH_TOKEN_KMS_KEY_ARN',
    'GITHUB_APP_SECRET_ARN',
  ] as const;
```

- [ ] **Step 3: Add to the frozen return object**

Inside the `return Object.freeze({ … })` block, add:

```ts
    githubAppSecretArn: process.env['GITHUB_APP_SECRET_ARN'] as string,
```

- [ ] **Step 4: Add config tests**

Open `api/public-api/__tests__/lib/config.test.ts`. Find the existing test fixture (likely a `VALID_ENV` const and an `afterEach` that resets `process.env`). Add `GITHUB_APP_SECRET_ARN` to the valid-env fixture:

```ts
process.env['GITHUB_APP_SECRET_ARN'] = 'arn:aws:secretsmanager:eu-west-1:0:secret/test-gh';
```

Append two tests at the end of the file (adjust import path to match the file's existing pattern for `loadConfig`):

```ts
describe('loadConfig — GITHUB_APP_SECRET_ARN', () => {
    const original = { ...process.env };
    afterEach(() => {
        for (const k of Object.keys(process.env)) delete process.env[k];
        Object.assign(process.env, original);
    });

    function setRequired(): void {
        process.env['PG_HOST']                  = 'localhost';
        process.env['PG_DATABASE']              = 'db';
        process.env['PG_USER']                  = 'u';
        process.env['PG_PASSWORD']              = 'p';
        process.env['OAUTH_TOKEN_KMS_KEY_ARN']  = 'arn:aws:kms:eu-west-1:0:key/abc';
    }

    it('throws when GITHUB_APP_SECRET_ARN is missing', () => {
        setRequired();
        delete process.env['GITHUB_APP_SECRET_ARN'];
        expect(() => loadConfig()).toThrow(/GITHUB_APP_SECRET_ARN/);
    });

    it('exposes the ARN on the returned Config when set', () => {
        setRequired();
        process.env['GITHUB_APP_SECRET_ARN'] = 'arn:aws:secretsmanager:eu-west-1:0:secret/gh-app';
        const cfg = loadConfig();
        expect(cfg.githubAppSecretArn).toBe('arn:aws:secretsmanager:eu-west-1:0:secret/gh-app');
    });
});
```

If the existing config test file already has a similar `setRequired`-style helper at top-level, reuse it instead of declaring a second one.

- [ ] **Step 5: Run tests + typecheck**

```
yarn workspace @repo/public-api run test __tests__/lib/config.test.ts
yarn workspace @repo/public-api run typecheck
```
Expected: tests green (existing config tests still pass + 2 new), typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add api/public-api/src/lib/config.ts api/public-api/__tests__/lib/config.test.ts
git commit -m "feat(public-api): require GITHUB_APP_SECRET_ARN at boot"
```

---

## Task 8: Secrets Manager fetcher — failing test

**Files:**
- Create: `api/public-api/__tests__/lib/githubAppSecrets.test.ts`

- [ ] **Step 1: Inspect existing config test for fixture style**

Run: `head -40 api/public-api/__tests__/lib/config.test.ts`
Note how mocking, env reset, and helpers are organised; mirror that style.

- [ ] **Step 2: Write the failing test**

```ts
// api/public-api/__tests__/lib/githubAppSecrets.test.ts
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
    getGitHubAppSecrets,
    __resetGitHubAppSecretsCacheForTests,
} from '../../src/lib/githubAppSecrets.js';
import type { Config } from '../../src/lib/config.js';

const smMock = mockClient(SecretsManagerClient);

function stubConfig(overrides: Partial<Config> = {}): Config {
    return {
        awsRegion:              'eu-west-1',
        pgHost:                 'localhost',
        pgPort:                 5432,
        pgDatabase:             'db',
        pgUser:                 'u',
        pgPassword:             'p',
        port:                   3001,
        allowedOrigins:         [],
        bedrockApiUrl:          undefined,
        bedrockApiKeySecretArn: undefined,
        bedrockPublicApiUrl:    undefined,
        bedrockAuthApiUrl:      undefined,
        oauthTokenKmsKeyArn:    'arn:aws:kms:eu-west-1:0:key/abc',
        githubAppSecretArn:     'arn:aws:secretsmanager:eu-west-1:0:secret/gh-app',
        ...overrides,
    } as Config;
}

const VALID_JSON = JSON.stringify({
    appId:          '123',
    privateKeyPem:  '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----',
    webhookSecret:  'whsec_test',
});

beforeEach(() => {
    smMock.reset();
    __resetGitHubAppSecretsCacheForTests();
    jest.useRealTimers();
});

describe('getGitHubAppSecrets', () => {
    it('parses a valid JSON secret into a frozen { appId, privateKeyPem, webhookSecret }', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: VALID_JSON });
        const cfg = stubConfig();
        const out = await getGitHubAppSecrets(cfg);
        expect(out.appId).toBe('123');
        expect(out.privateKeyPem).toContain('BEGIN RSA PRIVATE KEY');
        expect(out.webhookSecret).toBe('whsec_test');
        expect(Object.isFrozen(out)).toBe(true);
    });
});
```

- [ ] **Step 3: Run, verify failure**

Run: `yarn workspace @repo/public-api run test __tests__/lib/githubAppSecrets.test.ts`
Expected: FAIL — `Cannot find module '../../src/lib/githubAppSecrets.js'`.

- [ ] **Step 4: Commit**

```bash
git add api/public-api/__tests__/lib/githubAppSecrets.test.ts
git commit -m "test(public-api): failing happy-path test for getGitHubAppSecrets"
```

---

## Task 9: Secrets Manager fetcher — implementation

**Files:**
- Create: `api/public-api/src/lib/githubAppSecrets.ts`

- [ ] **Step 1: Verify `aws-sdk-client-mock` and `@aws-sdk/client-secrets-manager` deps**

Run: `grep -n "@aws-sdk/client-secrets-manager\|aws-sdk-client-mock" api/public-api/package.json`
Expected: `@aws-sdk/client-secrets-manager` already present (used by `chatbot.ts`). If `aws-sdk-client-mock` is not in `devDependencies`, add it now matching the version in `applications/shared/package.json`:
```bash
yarn workspace @repo/public-api add -D aws-sdk-client-mock@^4.1.0
```

- [ ] **Step 2: Write the implementation**

```ts
// api/public-api/src/lib/githubAppSecrets.ts
/**
 * @file githubAppSecrets.ts
 * @description Secrets Manager fetcher for the GitHub App JSON secret.
 * Mirrors lib/pg.ts and chatbot.ts:getApiKey — module-level
 * SecretsManagerClient (credentials via EC2 node instance profile),
 * TTL-cached value with transparent re-fetch after expiry, validation
 * inside the fetcher so misconfiguration surfaces as "500 secret
 * misconfigured" rather than a downstream "401 signature mismatch".
 */

import {
    GetSecretValueCommand,
    SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { Config } from './config.js';

export interface GitHubAppSecrets {
    readonly appId:          string;
    readonly privateKeyPem:  string;
    readonly webhookSecret:  string;
}

const TTL_MS = 10 * 60 * 1000; // 10 min — matches chatbot.ts default
const client = new SecretsManagerClient({});

interface Cached { value: GitHubAppSecrets; expiresAt: number }
let cache: Cached | undefined;

export async function getGitHubAppSecrets(config: Config): Promise<GitHubAppSecrets> {
    if (cache !== undefined && Date.now() < cache.expiresAt) return cache.value;

    const resp = await client.send(
        new GetSecretValueCommand({ SecretId: config.githubAppSecretArn }),
    );
    if (!resp.SecretString) {
        throw new Error(`[github-app] Secrets Manager secret has no value: ${config.githubAppSecretArn}`);
    }

    const parsed = parseAndValidate(resp.SecretString, config.githubAppSecretArn);
    cache = { value: parsed, expiresAt: Date.now() + TTL_MS };
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
    const appIdRaw       = o['appId'];
    const appId          = (typeof appIdRaw === 'string' || typeof appIdRaw === 'number') ? String(appIdRaw) : undefined;
    const privateKeyPem  = typeof o['privateKeyPem'] === 'string' && o['privateKeyPem'].length > 0 ? o['privateKeyPem'] : undefined;
    const webhookSecret  = typeof o['webhookSecret'] === 'string' && o['webhookSecret'].length > 0 ? o['webhookSecret'] : undefined;
    if (!appId || !privateKeyPem || !webhookSecret) {
        throw new Error(`[github-app] Secret ${arn} missing one of: appId, privateKeyPem, webhookSecret`);
    }
    return Object.freeze({ appId, privateKeyPem, webhookSecret });
}

/** Test seam — clears the cache. */
export function __resetGitHubAppSecretsCacheForTests(): void {
    cache = undefined;
}
```

- [ ] **Step 3: Run the failing test**

Run: `yarn workspace @repo/public-api run test __tests__/lib/githubAppSecrets.test.ts`
Expected: 1 PASS.

- [ ] **Step 4: Commit**

```bash
git add api/public-api/src/lib/githubAppSecrets.ts api/public-api/package.json yarn.lock
git commit -m "feat(public-api): TTL-cached fetcher for GitHub App secrets"
```

---

## Task 10: Secrets Manager fetcher — full test coverage

**Files:**
- Modify: `api/public-api/__tests__/lib/githubAppSecrets.test.ts`

- [ ] **Step 1: Append the remaining cases**

Inside the existing `describe('getGitHubAppSecrets', …)` block, after the happy-path test, append:

```ts
    it('serves the cached value on a second call within TTL', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: VALID_JSON });
        const cfg = stubConfig();
        await getGitHubAppSecrets(cfg);
        await getGitHubAppSecrets(cfg);
        expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
    });

    it('re-fetches after the TTL expires', async () => {
        jest.useFakeTimers();
        try {
            jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
            smMock.on(GetSecretValueCommand).resolves({ SecretString: VALID_JSON });
            const cfg = stubConfig();
            await getGitHubAppSecrets(cfg);

            // 11 minutes later — TTL is 10 min
            jest.setSystemTime(new Date('2026-01-01T00:11:00Z'));
            await getGitHubAppSecrets(cfg);

            expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(2);
        } finally {
            jest.useRealTimers();
        }
    });

    it('throws when SecretString is missing', async () => {
        smMock.on(GetSecretValueCommand).resolves({});
        await expect(getGitHubAppSecrets(stubConfig())).rejects.toThrow(/has no value/);
    });

    it('throws on invalid JSON', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: 'not json' });
        await expect(getGitHubAppSecrets(stubConfig())).rejects.toThrow(/is not valid JSON/);
    });

    it('throws when a required field is missing', async () => {
        smMock.on(GetSecretValueCommand).resolves({
            SecretString: JSON.stringify({ appId: '1', privateKeyPem: 'x' }), // no webhookSecret
        });
        await expect(getGitHubAppSecrets(stubConfig())).rejects.toThrow(/missing one of/);
    });

    it('accepts appId as a number and coerces to string', async () => {
        smMock.on(GetSecretValueCommand).resolves({
            SecretString: JSON.stringify({ appId: 123, privateKeyPem: 'x', webhookSecret: 'y' }),
        });
        const out = await getGitHubAppSecrets(stubConfig());
        expect(out.appId).toBe('123');
    });

    it('__resetGitHubAppSecretsCacheForTests forces a fresh fetch', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: VALID_JSON });
        await getGitHubAppSecrets(stubConfig());
        __resetGitHubAppSecretsCacheForTests();
        await getGitHubAppSecrets(stubConfig());
        expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(2);
    });
```

- [ ] **Step 2: Run the suite**

Run: `yarn workspace @repo/public-api run test __tests__/lib/githubAppSecrets.test.ts`
Expected: 8 PASS.

- [ ] **Step 3: Commit**

```bash
git add api/public-api/__tests__/lib/githubAppSecrets.test.ts
git commit -m "test(public-api): TTL, error paths, and cache reset for github app secrets"
```

---

## Task 11: Webhook route — failing test (happy path)

**Files:**
- Create: `api/public-api/__tests__/routes/github-webhook.test.ts`

- [ ] **Step 1: Inspect existing route tests if any**

Run: `find api/public-api/__tests__ -type d -maxdepth 3` to confirm `routes/` is a fresh test dir. Confirm Hono's `app.request` interface is usable in this jest setup (the existing routes use `@hono/node-server`; tests can invoke the Hono `app` directly via `app.request(url, init)` without a server).

- [ ] **Step 2: Write the failing test**

```ts
// api/public-api/__tests__/routes/github-webhook.test.ts
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { createHmac } from 'node:crypto';

import githubWebhook from '../../src/routes/github-webhook.js';
import {
    __resetGitHubAppSecretsCacheForTests,
} from '../../src/lib/githubAppSecrets.js';
import {
    __resetOAuthSingletonsForTests,
} from '../../src/lib/oauth.js';
import * as ghSecrets from '../../src/lib/githubAppSecrets.js';
import * as oauthLib from '../../src/lib/oauth.js';

const WEBHOOK_SECRET = 'whsec_test';
const SECRETS_FIXTURE = {
    appId:         '123',
    privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
    webhookSecret: WEBHOOK_SECRET,
};

function makeRepoMock(overrides: Partial<{
    getByInstallationId: (id: string) => Promise<unknown | null>;
    markRevoked:         (id: string, at: Date) => Promise<void>;
    markSuspended:       (id: string, at: Date) => Promise<void>;
}> = {}): {
    markRevoked:   jest.Mock;
    markSuspended: jest.Mock;
    getById:       jest.Mock;
} {
    const markRevoked   = jest.fn(async () => undefined);
    const markSuspended = jest.fn(async () => undefined);
    const getById       = jest.fn(async (_id: string) => ({ id: 'row-1', installationId: 'inst-42' }));

    // Replace getOAuthConnectionsRepo to return our mock.
    jest.spyOn(oauthLib, 'getOAuthConnectionsRepo').mockReturnValue({
        getByInstallationId: overrides.getByInstallationId ?? (getById as unknown as never),
        markRevoked:         overrides.markRevoked         ?? (markRevoked as unknown as never),
        markSuspended:       overrides.markSuspended       ?? (markSuspended as unknown as never),
        upsert:              jest.fn() as unknown as never,
        getByUserAndProvider: jest.fn() as unknown as never,
    });
    return { markRevoked, markSuspended, getById };
}

function sign(body: Buffer, secret: string): string {
    return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

beforeEach(() => {
    __resetGitHubAppSecretsCacheForTests();
    __resetOAuthSingletonsForTests();
    jest.restoreAllMocks();

    // Provide minimum env so loadConfig() succeeds inside the route.
    process.env['PG_HOST']                  = 'localhost';
    process.env['PG_DATABASE']              = 'db';
    process.env['PG_USER']                  = 'u';
    process.env['PG_PASSWORD']              = 'p';
    process.env['OAUTH_TOKEN_KMS_KEY_ARN']  = 'arn:aws:kms:eu-west-1:0:key/abc';
    process.env['GITHUB_APP_SECRET_ARN']    = 'arn:aws:secretsmanager:eu-west-1:0:secret/gh-app';

    // Short-circuit getGitHubAppSecrets so we don't touch AWS.
    jest.spyOn(ghSecrets, 'getGitHubAppSecrets').mockResolvedValue(SECRETS_FIXTURE);
});

async function post(body: object, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const res = await githubWebhook.request('/webhooks/github', {
        method:  'POST',
        body:    raw,
        headers: {
            'content-type':         'application/json',
            'x-github-event':       'installation',
            'x-github-delivery':    'delivery-uuid',
            'x-hub-signature-256':  sign(raw, WEBHOOK_SECRET),
            ...headers,
        },
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

describe('POST /webhooks/github', () => {
    it('valid installation.deleted → 200 ok + markRevoked called', async () => {
        const repo = makeRepoMock();
        const out = await post({ action: 'deleted', installation: { id: 42 } });
        expect(out.status).toBe(200);
        expect(out.json).toMatchObject({ status: 'ok' });
        expect(repo.markRevoked).toHaveBeenCalledTimes(1);
        expect(repo.markRevoked.mock.calls[0]![0]).toBe('row-1');
        expect(repo.markSuspended).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 3: Run, verify failure**

Run: `yarn workspace @repo/public-api run test __tests__/routes/github-webhook.test.ts`
Expected: FAIL — `Cannot find module '../../src/routes/github-webhook.js'`.

- [ ] **Step 4: Commit**

```bash
git add api/public-api/__tests__/routes/github-webhook.test.ts
git commit -m "test(public-api): failing happy-path test for github-webhook route"
```

---

## Task 12: Webhook route — implementation

**Files:**
- Create: `api/public-api/src/routes/github-webhook.ts`

- [ ] **Step 1: Write the route**

```ts
// api/public-api/src/routes/github-webhook.ts
/**
 * @file github-webhook.ts
 * @description POST /webhooks/github
 *
 * Verifies the HMAC-SHA256 signature, then branches on installation
 * events. The body is read raw (arrayBuffer) because the HMAC is over
 * the exact wire bytes — any re-stringification breaks verification.
 *
 * Status-code contract: see
 * docs/superpowers/specs/2026-05-21-github-webhook-and-app-jwt-design.md.
 */

import { Hono } from 'hono';
import { verifyWebhookSignature, log } from '@bedrock/shared';
import { loadConfig } from '../lib/config.js';
import { getGitHubAppSecrets } from '../lib/githubAppSecrets.js';
import { getOAuthConnectionsRepo } from '../lib/oauth.js';

const githubWebhook = new Hono();

githubWebhook.post('/webhooks/github', async (c) => {
    const cfg        = loadConfig();
    const deliveryId = c.req.header('x-github-delivery') ?? 'unknown';
    const event      = c.req.header('x-github-event') ?? '';
    const sigHeader  = c.req.header('x-hub-signature-256');

    const rawBody = Buffer.from(await c.req.arrayBuffer());
    const secrets = await getGitHubAppSecrets(cfg);

    if (!verifyWebhookSignature(rawBody, sigHeader, secrets.webhookSecret)) {
        log('WARN', 'github.webhook.invalid_signature', { deliveryId, event });
        return c.json({ error: 'invalid signature' }, 401);
    }

    if (event !== 'installation') {
        log('INFO', 'github.webhook.ignored', { deliveryId, event, reason: 'event_type' });
        return c.body(null, 204);
    }

    let payload: { action?: string; installation?: { id?: number | string } };
    try {
        payload = JSON.parse(rawBody.toString('utf8')) as typeof payload;
    } catch {
        log('WARN', 'github.webhook.bad_json', { deliveryId, event });
        return c.json({ error: 'bad json' }, 400);
    }

    const action = payload.action;
    const idRaw  = payload.installation?.id;
    const installationId = idRaw != null ? String(idRaw) : undefined;
    if (!installationId) {
        log('WARN', 'github.webhook.missing_installation_id', { deliveryId, event, action });
        return c.json({ error: 'missing installation.id' }, 400);
    }

    if (action !== 'deleted' && action !== 'suspended') {
        log('INFO', 'github.webhook.ignored', { deliveryId, event, action, reason: 'action_type' });
        return c.body(null, 204);
    }

    const repo = getOAuthConnectionsRepo(cfg);
    const row  = await repo.getByInstallationId(installationId);
    if (!row) {
        log('INFO', 'github.webhook.no_match', { deliveryId, event, action, installationId });
        return c.json({ status: 'no_match' }, 200);
    }

    const at = new Date();
    if (action === 'deleted') {
        await repo.markRevoked(row.id, at);
    } else {
        await repo.markSuspended(row.id, at);
    }

    log('INFO', 'github.webhook.processed', {
        deliveryId, event, action,
        installationId, oauthConnectionId: row.id,
    });
    return c.json({ status: 'ok' }, 200);
});

export default githubWebhook;
```

- [ ] **Step 2: Run the happy-path test**

Run: `yarn workspace @repo/public-api run test __tests__/routes/github-webhook.test.ts`
Expected: 1 PASS.

- [ ] **Step 3: Typecheck**

Run: `yarn workspace @repo/public-api run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add api/public-api/src/routes/github-webhook.ts
git commit -m "feat(public-api): POST /webhooks/github route"
```

---

## Task 13: Webhook route — remaining 9 test cases

**Files:**
- Modify: `api/public-api/__tests__/routes/github-webhook.test.ts`

- [ ] **Step 1: Append the rest of the cases**

Inside the existing `describe('POST /webhooks/github', …)`, append:

```ts
    it('valid installation.suspended → 200 ok + markSuspended called', async () => {
        const repo = makeRepoMock();
        const out = await post({ action: 'suspended', installation: { id: 42 } });
        expect(out.status).toBe(200);
        expect(out.json).toMatchObject({ status: 'ok' });
        expect(repo.markSuspended).toHaveBeenCalledTimes(1);
        expect(repo.markRevoked).not.toHaveBeenCalled();
    });

    it('valid installation.created → 204 ignored, no repo call', async () => {
        const repo = makeRepoMock();
        const out = await post({ action: 'created', installation: { id: 42 } });
        expect(out.status).toBe(204);
        expect(repo.markRevoked).not.toHaveBeenCalled();
        expect(repo.markSuspended).not.toHaveBeenCalled();
    });

    it('event=push with valid signature → 204 ignored', async () => {
        const repo = makeRepoMock();
        const raw = Buffer.from(JSON.stringify({ ref: 'main' }), 'utf8');
        const res = await githubWebhook.request('/webhooks/github', {
            method: 'POST',
            body: raw,
            headers: {
                'content-type':         'application/json',
                'x-github-event':       'push',
                'x-github-delivery':    'delivery-uuid',
                'x-hub-signature-256':  sign(raw, WEBHOOK_SECRET),
            },
        });
        expect(res.status).toBe(204);
        expect(repo.markRevoked).not.toHaveBeenCalled();
    });

    it('bad signature → 401, no repo call', async () => {
        const repo = makeRepoMock();
        const raw = Buffer.from(JSON.stringify({ action: 'deleted', installation: { id: 42 } }), 'utf8');
        const res = await githubWebhook.request('/webhooks/github', {
            method: 'POST',
            body: raw,
            headers: {
                'content-type':         'application/json',
                'x-github-event':       'installation',
                'x-github-delivery':    'delivery-uuid',
                'x-hub-signature-256':  'sha256=deadbeef',
            },
        });
        expect(res.status).toBe(401);
        expect(repo.markRevoked).not.toHaveBeenCalled();
    });

    it('missing X-Hub-Signature-256 → 401', async () => {
        makeRepoMock();
        const raw = Buffer.from(JSON.stringify({ action: 'deleted', installation: { id: 42 } }), 'utf8');
        const res = await githubWebhook.request('/webhooks/github', {
            method: 'POST',
            body: raw,
            headers: {
                'content-type':      'application/json',
                'x-github-event':    'installation',
                'x-github-delivery': 'delivery-uuid',
            },
        });
        expect(res.status).toBe(401);
    });

    it('body not JSON (signature still valid over raw bytes) → 400', async () => {
        makeRepoMock();
        const raw = Buffer.from('not-json', 'utf8');
        const res = await githubWebhook.request('/webhooks/github', {
            method: 'POST',
            body: raw,
            headers: {
                'content-type':         'application/json',
                'x-github-event':       'installation',
                'x-github-delivery':    'delivery-uuid',
                'x-hub-signature-256':  sign(raw, WEBHOOK_SECRET),
            },
        });
        expect(res.status).toBe(400);
    });

    it('installation.deleted with missing installation.id → 400', async () => {
        const repo = makeRepoMock();
        const out = await post({ action: 'deleted' });
        expect(out.status).toBe(400);
        expect(repo.markRevoked).not.toHaveBeenCalled();
    });

    it('unknown installation_id → 200 no_match, no repo write', async () => {
        const repo = makeRepoMock({ getByInstallationId: async () => null });
        const out = await post({ action: 'deleted', installation: { id: 99999 } });
        expect(out.status).toBe(200);
        expect(out.json).toMatchObject({ status: 'no_match' });
        expect(repo.markRevoked).not.toHaveBeenCalled();
    });

    it('repo.markRevoked throws → handler propagates → Hono 500', async () => {
        makeRepoMock({
            markRevoked: async () => { throw new Error('db down'); },
        });
        const out = await post({ action: 'deleted', installation: { id: 42 } });
        expect(out.status).toBe(500);
    });
```

- [ ] **Step 2: Run all webhook tests**

Run: `yarn workspace @repo/public-api run test __tests__/routes/github-webhook.test.ts`
Expected: 10 PASS.

- [ ] **Step 3: Commit**

```bash
git add api/public-api/__tests__/routes/github-webhook.test.ts
git commit -m "test(public-api): coverage for all 10 github-webhook branches"
```

---

## Task 14: Mount route in `index.ts`

**Files:**
- Modify: `api/public-api/src/index.ts`

- [ ] **Step 1: Import + mount**

In the existing imports block (next to the other route imports):

```ts
import githubWebhook from './routes/github-webhook.js';
```

In the routes-mount block (where `app.route('/', chatbot)` etc. live), append:

```ts
app.route('/', githubWebhook);
```

- [ ] **Step 2: Typecheck**

Run: `yarn workspace @repo/public-api run typecheck`
Expected: exit 0.

- [ ] **Step 3: Optional smoke-build**

Run: `yarn workspace @repo/public-api run build` (or `tsc -p api/public-api`)
Expected: exit 0; `api/public-api/dist/` produced. This guards against import-path drift the unit tests cannot catch.

- [ ] **Step 4: Commit**

```bash
git add api/public-api/src/index.ts
git commit -m "feat(public-api): mount POST /webhooks/github"
```

---

## Task 15: Full-suite verification + branch push

**Files:** none changed — operational.

- [ ] **Step 1: Run every affected suite**

```
yarn workspace @bedrock/shared run test src/github/ src/crypto/ src/rds/
yarn workspace @repo/public-api run test __tests__/lib/ __tests__/routes/
```
Expected: shared 14+ new tests under github/ green, all pre-existing green; public-api new (config 2 + secrets 8 + webhook 10) plus existing all green.

- [ ] **Step 2: Typecheck both workspaces**

```
yarn workspace @bedrock/shared run typecheck
yarn workspace @repo/public-api run typecheck
```
Expected: both exit 0.

- [ ] **Step 3: Branch diff sanity check**

```
git log --oneline origin/develop..HEAD
```
Expected: roughly 12–14 commits matching Tasks 1–14.

- [ ] **Step 4: Push**

```
git push -u origin oauth-github-webhook
```

- [ ] **Step 5: Open PR**

```
gh pr create --base develop \
  --title "feat: GitHub webhook + App JWT (PR-2b of 3)" \
  --body-file - <<'EOF'
## Summary

Inbound `POST /webhooks/github` route that handles
`installation.deleted` and `installation.suspended` and writes via
PR-2a's `getOAuthConnectionsRepo`. Also ships a pure RS256 JWT signer
(`@bedrock/shared/signGitHubAppJwt`) that PR-2c will use for the
outbound revoke flow.

### What ships

- `applications/shared/src/github/appJwt.ts` — RS256 signer, ~60 LOC,
  zero deps. Reusable.
- `applications/shared/src/github/webhookSignature.ts` — HMAC-SHA256
  verifier with `timingSafeEqual` and a length-guard.
- `api/public-api/src/lib/githubAppSecrets.ts` — TTL-cached Secrets
  Manager fetcher returning `{appId, privateKeyPem, webhookSecret}`,
  validated at fetch time.
- `api/public-api/src/routes/github-webhook.ts` — Hono route mounted at
  `/webhooks/github`. Thin orchestration; one structured log per
  branch keyed on `X-GitHub-Delivery`.
- `Config.githubAppSecretArn` is now a required env (`GITHUB_APP_SECRET_ARN`).

### Operator runbook

1. Create Secrets Manager secret with JSON
   `{appId, privateKeyPem, webhookSecret}`. Note ARN.
2. Update public-api Helm ConfigMap: add `GITHUB_APP_SECRET_ARN`. Grant
   the EKS node IAM role `secretsmanager:GetSecretValue` on the ARN.
3. Roll the pod.
4. In GitHub App settings: set webhook URL to
   `https://<host>/webhooks/github`, paste the same `webhookSecret`,
   subscribe to the `Installation` event.
5. Trigger a test delivery from GitHub. Expect a single
   `github.webhook.processed` (or `no_match`) log line.

### Deferred

- Outbound `DELETE /app/installations/{id}` on user soft-delete → PR-2c
  (will use `signGitHubAppJwt` shipped here).
- Ingestion installation-token migration → PR-3.

## Test Plan

- [x] `yarn workspace @bedrock/shared run test src/github/` — 14 new
      tests (5 JWT + 9 webhook signature) all green.
- [x] `yarn workspace @repo/public-api run test __tests__/` — 20 new
      tests (2 config + 8 secrets + 10 webhook), all existing still
      green.
- [x] Typecheck across both workspaces — exit 0.
- [ ] Reviewer: confirm no global middleware consumes the body before
      the webhook route handler.

## Spec / Plan

- Design: `docs/superpowers/specs/2026-05-21-github-webhook-and-app-jwt-design.md`
- Plan:   `docs/superpowers/plans/2026-05-21-github-webhook-and-app-jwt.md`
- Builds on PR-1 (#17) and PR-2a (#18), both merged.
EOF
```

---

## Out of this plan (tracked elsewhere)

- PR-2c: user soft-delete handler at the public-api layer with an
  outbound `DELETE /app/installations/{id}` call using
  `signGitHubAppJwt` from this PR.
- PR-3: ingestion `GitHubAdapter` migration to installation tokens.
- Operator: grant the EKS node IAM role
  `secretsmanager:GetSecretValue` on the new secret ARN; add a
  CloudTrail / log-metric alarm on
  `github.webhook.invalid_signature` if volume grows.
