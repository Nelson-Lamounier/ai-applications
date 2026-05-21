# OAuth App Revocation Foundation Implementation Plan (PR-2a of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision a dedicated KMS CMK for oauth-token envelope encryption, lazily wire the encrypted repo into the public-api boot path, and instrument the repo with structured logs + a decrypt-failure EMF metric — establishing the foundation PR-2b (webhook) and PR-2c (soft-delete + outbound revoke) build on.

**Architecture:** CDK adds the CMK + an SSM-published ARN to `data-stack.ts` (key policy stays at AWS default; user grants node role out of band). The public-api process gains a lazy-singleton `lib/oauth.ts` mirroring `lib/pg.ts:getPool`. `RdsOAuthConnectionsRepository` grows structured logs and an EMF metric using the existing `logger.ts` + `emf.ts` helpers — no new observability primitives.

**Tech Stack:** TypeScript, Node 22, AWS CDK v2 (`aws-cdk-lib/aws-kms`, `aws-cdk-lib/aws-ssm`), AWS SDK v3 (`@aws-sdk/client-kms`), Jest with `aws-cdk-lib/assertions` for synth tests.

**Spec:** [docs/superpowers/specs/2026-05-20-oauth-app-revocation-foundation-design.md](../specs/2026-05-20-oauth-app-revocation-foundation-design.md)

---

## File Structure

**Create:**
- `api/public-api/src/lib/oauth.ts` — lazy singletons for `KmsEnvelope` + `IOAuthConnectionsRepository`
- `api/public-api/src/lib/oauth.test.ts`

**Modify:**
- `infra/lib/stacks/bedrock/data-stack.ts` — add `OAuthTokenKey`, `OAuthTokenKeyArnParam`, `OAuthTokenKeyArn` output
- `infra/tests/unit/stacks/bedrock/data-stack.test.ts` — assert the new resources
- `api/public-api/src/lib/config.ts` — add `oauthTokenKmsKeyArn` + required-env check
- `api/public-api/test/lib/config.test.ts` (or wherever `loadConfig` is tested — verify in Task 4)
- `applications/shared/src/rds/implementations/RdsOAuthConnectionsRepository.ts` — encrypt/decrypt instrumentation
- `applications/shared/src/rds/implementations/RdsOAuthConnectionsRepository.test.ts` — log + EMF assertions

---

## Task 1: CDK — add KMS CMK + SSM param + output to data-stack

**Files:**
- Modify: `infra/lib/stacks/bedrock/data-stack.ts`

- [ ] **Step 1: Inspect the file**

Run: `head -25 infra/lib/stacks/bedrock/data-stack.ts`
Confirm imports already include `aws-cdk-lib/aws-kms`, `aws-cdk-lib/aws-ssm`, `aws-cdk-lib/core` (aliased as `cdk`). The file already has `kms.Key` use elsewhere (the conditional S3 encryption key) — follow the same import style.

- [ ] **Step 2: Locate the end of the constructor body**

Find the closing brace of the `BedrockDataStack` constructor. The new block belongs near the bottom of the constructor, after existing resource definitions, before any CDK Nag suppressions.

- [ ] **Step 3: Insert the new resources**

Insert this block (adjust placement so it groups with any existing key/SSM blocks if obvious):

```ts
// ─── OAuth token envelope encryption ──────────────────────────────────
// Dedicated CMK for oauth_connections.access_token envelope encryption
// (per PR-1 design). The key policy is left at AWS default (root-only);
// the EKS node IAM role is granted Encrypt/Decrypt/GenerateDataKey out
// of band — see docs/superpowers/specs/2026-05-20-oauth-app-revocation-
// foundation-design.md for the deploy runbook.
const oauthTokenKey = new kms.Key(this, 'OAuthTokenKey', {
    alias: 'alias/oauth-token-encryption',
    description: 'Envelope encryption for oauth_connections.access_token',
    enableKeyRotation: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    pendingWindow: cdk.Duration.days(30),
});

new ssm.StringParameter(this, 'OAuthTokenKeyArnParam', {
    parameterName: '/oauth/token-encryption-key-arn',
    stringValue: oauthTokenKey.keyArn,
    description: 'KMS CMK ARN for oauth_connections token envelope encryption',
});

new cdk.CfnOutput(this, 'OAuthTokenKeyArn', {
    value: oauthTokenKey.keyArn,
    description: 'KMS CMK ARN for oauth_connections token envelope encryption',
    exportName: `${props.namePrefix}-OAuthTokenKeyArn`,
});
```

If the file already prefers `RemovalPolicy` imported bare instead of `cdk.RemovalPolicy`, follow that style instead — match what is already there.

- [ ] **Step 4: Synth to verify**

Run: `yarn workspace @repo/infra cdk synth --quiet 2>&1 | tail -20`
Expected: synth succeeds, no errors. If the workspace name differs, run from `infra/` directly: `cd infra && yarn cdk synth --quiet`.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/stacks/bedrock/data-stack.ts
git commit -m "feat(infra): provision oauth-token-encryption CMK + SSM param"
```

---

## Task 2: CDK — assert new resources in the data-stack test

**Files:**
- Modify: `infra/tests/unit/stacks/bedrock/data-stack.test.ts`

- [ ] **Step 1: Inspect the existing test structure**

Run: `head -60 infra/tests/unit/stacks/bedrock/data-stack.test.ts`
Note the `createDataStack` helper and `describe`/`it` style used by neighbouring tests.

- [ ] **Step 2: Add the new describe block**

Append below the existing `describe('BedrockDataStack', () => { ... })` body (still inside the top-level describe — adapt placement to match the file's nesting):

```ts
    describe('OAuth token envelope encryption', () => {
        it('creates a KMS key with rotation, RETAIN policy, and the OAuth alias', () => {
            const { template } = createDataStack();
            template.hasResourceProperties('AWS::KMS::Key', {
                EnableKeyRotation: true,
                Description: 'Envelope encryption for oauth_connections.access_token',
                PendingWindowInDays: 30,
            });
            template.hasResourceProperties('AWS::KMS::Alias', {
                AliasName: 'alias/oauth-token-encryption',
            });
        });

        it('retains the CMK on stack destroy', () => {
            const { template } = createDataStack();
            template.hasResource('AWS::KMS::Key', {
                Properties: { Description: 'Envelope encryption for oauth_connections.access_token' },
                DeletionPolicy: 'Retain',
                UpdateReplacePolicy: 'Retain',
            });
        });

        it('publishes the CMK ARN to SSM at /oauth/token-encryption-key-arn', () => {
            const { template } = createDataStack();
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/oauth/token-encryption-key-arn',
                Description: 'KMS CMK ARN for oauth_connections token envelope encryption',
            });
        });

        it('exports OAuthTokenKeyArn as a stack output', () => {
            const { template } = createDataStack();
            template.hasOutput('OAuthTokenKeyArn', {
                Export: { Name: Match.stringLikeRegexp('.*-OAuthTokenKeyArn$') },
            });
        });
    });
```

- [ ] **Step 3: Run tests**

Run: `yarn workspace @repo/infra run test tests/unit/stacks/bedrock/data-stack.test.ts`
Expected: all tests pass, including the 4 new ones. If the workspace name differs run `cd infra && yarn test tests/unit/stacks/bedrock/data-stack.test.ts`.

- [ ] **Step 4: Commit**

```bash
git add infra/tests/unit/stacks/bedrock/data-stack.test.ts
git commit -m "test(infra): assert oauth-token-encryption CMK, SSM param, and output"
```

---

## Task 3: Public-API config — add `oauthTokenKmsKeyArn`

**Files:**
- Modify: `api/public-api/src/lib/config.ts`

- [ ] **Step 1: Add field to the `Config` interface**

Locate the `Config` interface (file head). Add immediately after `awsRegion`:

```ts
  /**
   * KMS CMK ARN for oauth_connections token envelope encryption.
   * Sourced from `OAUTH_TOKEN_KMS_KEY_ARN` (ConfigMap, populated from the
   * SSM param `/oauth/token-encryption-key-arn`).
   */
  readonly oauthTokenKmsKeyArn: string;
```

- [ ] **Step 2: Add it to the required-env list in `loadConfig`**

Find the `required` tuple inside `loadConfig`:

```ts
  const required = [
    'PG_HOST',
    'PG_DATABASE',
    'PG_USER',
    'PG_PASSWORD',
  ] as const;
```

Replace with:

```ts
  const required = [
    'PG_HOST',
    'PG_DATABASE',
    'PG_USER',
    'PG_PASSWORD',
    'OAUTH_TOKEN_KMS_KEY_ARN',
  ] as const;
```

- [ ] **Step 3: Add the field to the returned frozen object**

Inside the `return Object.freeze({ … })` block, add (anywhere — group sensibly):

```ts
    oauthTokenKmsKeyArn: process.env['OAUTH_TOKEN_KMS_KEY_ARN'] as string,
```

- [ ] **Step 4: Typecheck**

Run: `yarn workspace @repo/public-api run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add api/public-api/src/lib/config.ts
git commit -m "feat(public-api): require OAUTH_TOKEN_KMS_KEY_ARN at boot"
```

---

## Task 4: Public-API config — test the required-env failure

**Files:**
- Determined by discovery in step 1 below.

- [ ] **Step 1: Locate the existing config test**

Run: `find api/public-api -name "config.test.*" -not -path "*/node_modules/*"`

If a file exists, append the test to it. If none exists, create `api/public-api/test/lib/config.test.ts` (mirror the `test/` vs `src/` layout used by neighbouring suites — confirm by checking `find api/public-api -name "*.test.ts" -not -path "*/node_modules/*" | head`).

- [ ] **Step 2: Add the test**

```ts
import { loadConfig } from '../../src/lib/config.js';

describe('loadConfig — OAUTH_TOKEN_KMS_KEY_ARN', () => {
    const original = { ...process.env };
    afterEach(() => {
        // Restore env between tests.
        for (const k of Object.keys(process.env)) delete process.env[k];
        Object.assign(process.env, original);
    });

    function setPgDefaults(): void {
        process.env['PG_HOST']     = 'localhost';
        process.env['PG_DATABASE'] = 'db';
        process.env['PG_USER']     = 'u';
        process.env['PG_PASSWORD'] = 'p';
    }

    it('throws when OAUTH_TOKEN_KMS_KEY_ARN is missing', () => {
        setPgDefaults();
        delete process.env['OAUTH_TOKEN_KMS_KEY_ARN'];
        expect(() => loadConfig()).toThrow(/OAUTH_TOKEN_KMS_KEY_ARN/);
    });

    it('exposes the ARN on the returned Config when set', () => {
        setPgDefaults();
        process.env['OAUTH_TOKEN_KMS_KEY_ARN'] = 'arn:aws:kms:eu-west-1:0:key/abc';
        const cfg = loadConfig();
        expect(cfg.oauthTokenKmsKeyArn).toBe('arn:aws:kms:eu-west-1:0:key/abc');
    });
});
```

Adjust the import path (`'../../src/lib/config.js'`) to the actual relative path from the test file location.

- [ ] **Step 3: Run the test**

Run: `yarn workspace @repo/public-api run test <relative-path-to-test-file>`
Expected: 2 PASS.

- [ ] **Step 4: Commit**

```bash
git add <test-file-path>
git commit -m "test(public-api): loadConfig requires OAUTH_TOKEN_KMS_KEY_ARN"
```

---

## Task 5: `lib/oauth.ts` — failing singleton test

**Files:**
- Create: `api/public-api/src/lib/oauth.test.ts`

- [ ] **Step 1: Write the failing test file**

```ts
/**
 * @file oauth.test.ts
 * @description Verifies that getKmsEnvelope / getOAuthConnectionsRepo
 * cache their singletons and that __resetOAuthSingletonsForTests resets
 * the cache.
 */

import {
    getKmsEnvelope,
    getOAuthConnectionsRepo,
    __resetOAuthSingletonsForTests,
} from './oauth.js';
import type { Config } from './config.js';

// Minimal stub Config — only the fields oauth.ts reads.
function stubConfig(overrides: Partial<Config> = {}): Config {
    return {
        awsRegion:           'eu-west-1',
        pgHost:              'localhost',
        pgPort:              5432,
        pgDatabase:          'db',
        pgUser:              'u',
        pgPassword:          'p',
        port:                3001,
        allowedOrigins:      [],
        bedrockApiUrl:       undefined,
        bedrockApiKeySecretArn: undefined,
        bedrockPublicApiUrl: undefined,
        bedrockAuthApiUrl:   undefined,
        oauthTokenKmsKeyArn: 'arn:aws:kms:eu-west-1:0:key/abc',
        ...overrides,
    } as Config;
}

beforeEach(() => __resetOAuthSingletonsForTests());

describe('lib/oauth singletons', () => {
    it('getKmsEnvelope returns the same instance across calls', () => {
        const cfg = stubConfig();
        const a = getKmsEnvelope(cfg);
        const b = getKmsEnvelope(cfg);
        expect(a).toBe(b);
    });

    it('getOAuthConnectionsRepo returns the same instance across calls', () => {
        const cfg = stubConfig();
        const a = getOAuthConnectionsRepo(cfg);
        const b = getOAuthConnectionsRepo(cfg);
        expect(a).toBe(b);
    });

    it('__resetOAuthSingletonsForTests clears the cache', () => {
        const cfg = stubConfig();
        const before = getOAuthConnectionsRepo(cfg);
        __resetOAuthSingletonsForTests();
        const after = getOAuthConnectionsRepo(cfg);
        expect(after).not.toBe(before);
    });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `yarn workspace @repo/public-api run test src/lib/oauth.test.ts`
Expected: FAIL — `Cannot find module './oauth.js'`.

- [ ] **Step 3: Commit the failing test**

```bash
git add api/public-api/src/lib/oauth.test.ts
git commit -m "test(public-api): failing oauth singleton + reset tests"
```

---

## Task 6: `lib/oauth.ts` — implement lazy singletons

**Files:**
- Create: `api/public-api/src/lib/oauth.ts`

- [ ] **Step 1: Write the file**

```ts
/**
 * @file oauth.ts
 * @description Lazy singletons for the OAuth-connection KMS envelope and
 * repository. Mirrors lib/pg.ts:getPool — first call constructs the
 * underlying client and caches it at module scope; subsequent calls reuse
 * the cached instance. Routes that need to read/write oauth_connections
 * call getOAuthConnectionsRepo(loadConfig()).
 *
 * The KMSClient is constructed once with the region from Config; the
 * default credential provider chain resolves AWS credentials from the
 * EC2 node instance profile (see config.ts header).
 */

import { KMSClient } from '@aws-sdk/client-kms';
import {
    createKmsEnvelope,
    RdsOAuthConnectionsRepository,
    type KmsEnvelope,
    type IOAuthConnectionsRepository,
} from '@bedrock/shared';
import { getPool } from './pg.js';
import type { Config } from './config.js';

let kmsClient: KMSClient | undefined;
let envelope:  KmsEnvelope | undefined;
let repo:      IOAuthConnectionsRepository | undefined;

export function getKmsEnvelope(config: Config): KmsEnvelope {
    if (!envelope) {
        kmsClient = new KMSClient({ region: config.awsRegion });
        envelope  = createKmsEnvelope({
            kmsClient,
            keyId: config.oauthTokenKmsKeyArn,
        });
    }
    return envelope;
}

export function getOAuthConnectionsRepo(config: Config): IOAuthConnectionsRepository {
    if (!repo) {
        repo = new RdsOAuthConnectionsRepository({
            pool:     getPool(config),
            envelope: getKmsEnvelope(config),
        });
    }
    return repo;
}

/** Test seam — resets all singletons. Use only in tests. */
export function __resetOAuthSingletonsForTests(): void {
    kmsClient = undefined;
    envelope  = undefined;
    repo      = undefined;
}
```

- [ ] **Step 2: Verify `@bedrock/shared` already exports what we need**

Run: `grep -n "RdsOAuthConnectionsRepository\|IOAuthConnectionsRepository\|createKmsEnvelope" applications/shared/src/index.ts applications/shared/src/rds/index.ts applications/shared/src/crypto/index.ts`
Expected: each name appears in at least one barrel. If `@bedrock/shared` itself doesn't re-export them at the top level, switch the import to the correct sub-path (e.g. `from '@bedrock/shared/dist/rds'`) — adjust to whatever pattern the existing public-api routes use.

If you discover the package needs a top-level re-export to make this import resolve, add a minimal export to `applications/shared/src/index.ts` rather than rewriting consumers. Then `yarn workspace @bedrock/shared run build` so `dist/` is fresh.

- [ ] **Step 3: Run the tests**

Run: `yarn workspace @repo/public-api run test src/lib/oauth.test.ts`
Expected: 3 PASS.

- [ ] **Step 4: Typecheck**

Run: `yarn workspace @repo/public-api run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add api/public-api/src/lib/oauth.ts
# Include applications/shared/src/index.ts if you added re-exports in step 2
git commit -m "feat(public-api): lazy singletons for KMS envelope + OAuth repo"
```

---

## Task 7: Repo observability — failing log + EMF tests

**Files:**
- Modify: `applications/shared/src/rds/implementations/RdsOAuthConnectionsRepository.test.ts`

- [ ] **Step 1: Append imports**

At the top of the file, alongside existing imports, add:

```ts
import * as logger from '../../logger.js';
import * as emf    from '../../emf.js';
```

Adjust the relative path if the actual directory depth differs.

- [ ] **Step 2: Append a new `describe` block at end of the file**

```ts
describe('RdsOAuthConnectionsRepository observability', () => {
    let logSpy: jest.SpyInstance;
    let emfSpy: jest.SpyInstance;

    beforeEach(() => {
        logSpy = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
        emfSpy = jest.spyOn(emf,    'emitEmfMetric').mockImplementation(() => undefined);
    });

    afterEach(() => {
        logSpy.mockRestore();
        emfSpy.mockRestore();
    });

    it('upsert emits oauth.token.encrypt log with outcome=success', async () => {
        const pool = fakePool([{ rows: [rowFixture()] }]);
        const env  = fakeEnvelope();
        const repo = newRepo(pool, env);

        await repo.upsert({
            userId: 'u1', provider: 'github',
            providerUserId: '42', username: 'octocat',
            accessToken: 'tok', scopes: [], installationId: null,
        });

        const call = logSpy.mock.calls.find(c => c[1] === 'oauth.token.encrypt');
        expect(call).toBeDefined();
        expect(call![0]).toBe('INFO');
        expect(call![2]).toMatchObject({
            userId:   'u1',
            provider: 'github',
            outcome:  'success',
        });
        expect(typeof (call![2] as Record<string, unknown>)['durationMs']).toBe('number');
    });

    it('getByUserAndProvider on envelope columns emits oauth.token.decrypt log with outcome=success', async () => {
        const pool = fakePool([{ rows: [rowFixture()] }]);
        const env  = fakeEnvelope();
        const repo = newRepo(pool, env);

        await repo.getByUserAndProvider('u1', 'github');

        const call = logSpy.mock.calls.find(c => c[1] === 'oauth.token.decrypt');
        expect(call).toBeDefined();
        expect(call![2]).toMatchObject({ outcome: 'success' });
    });

    it('legacy plaintext fallback logs outcome=legacy_plaintext at INFO', async () => {
        const row = rowFixture({
            access_token_ciphertext: null,
            access_token_dek:        null,
            access_token_iv:         null,
            access_token_tag:        null,
            access_token_enc:        'legacy',
        });
        const pool = fakePool([{ rows: [row] }]);
        const repo = newRepo(pool, fakeEnvelope());

        await repo.getByUserAndProvider('u1', 'github');

        const call = logSpy.mock.calls.find(c => c[1] === 'oauth.token.decrypt');
        expect(call![0]).toBe('INFO');
        expect(call![2]).toMatchObject({ outcome: 'legacy_plaintext' });
        expect(emfSpy).not.toHaveBeenCalled();
    });

    it('decrypt IntegrityError emits ERROR log AND an OAuthTokenDecryptFailures metric', async () => {
        const { IntegrityError } = await import('../../crypto/index.js');
        const row = rowFixture();
        const pool = fakePool([{ rows: [row] }]);
        const env: ReturnType<typeof fakeEnvelope> = {
            ...fakeEnvelope(),
            decrypt: jest.fn(async () => { throw new IntegrityError(); }),
        };
        const repo = newRepo(pool, env);

        await expect(repo.getByUserAndProvider('u1', 'github')).rejects.toBeInstanceOf(IntegrityError);

        expect(emfSpy).toHaveBeenCalledTimes(1);
        const [namespace, dims, metrics, props] = emfSpy.mock.calls[0]!;
        expect(namespace).toBe('Portfolio/OAuth');
        expect(dims).toEqual({ Environment: expect.any(String) });
        expect(metrics).toEqual([{ name: 'OAuthTokenDecryptFailures', value: 1, unit: 'Count' }]);
        expect(props).toMatchObject({ userId: 'u1', provider: 'github', errorClass: 'IntegrityError' });

        const decryptLog = logSpy.mock.calls.find(c => c[1] === 'oauth.token.decrypt');
        expect(decryptLog![0]).toBe('ERROR');
        expect(decryptLog![2]).toMatchObject({ outcome: 'integrity_error' });
    });

    it('decrypt KMS failure (non-Integrity) emits metric with errorClass and outcome=kms_error', async () => {
        const row = rowFixture();
        const pool = fakePool([{ rows: [row] }]);
        const env: ReturnType<typeof fakeEnvelope> = {
            ...fakeEnvelope(),
            decrypt: jest.fn(async () => { throw new Error('kms boom'); }),
        };
        const repo = newRepo(pool, env);

        await expect(repo.getByUserAndProvider('u1', 'github')).rejects.toThrow(/kms boom/);

        const [, , metrics, props] = emfSpy.mock.calls[0]!;
        expect(metrics[0]!.name).toBe('OAuthTokenDecryptFailures');
        expect(props).toMatchObject({ errorClass: 'Error' });

        const decryptLog = logSpy.mock.calls.find(c => c[1] === 'oauth.token.decrypt');
        expect(decryptLog![2]).toMatchObject({ outcome: 'kms_error' });
    });
});
```

- [ ] **Step 3: Run — expect failures**

Run: `yarn workspace @bedrock/shared run test src/rds/implementations/RdsOAuthConnectionsRepository.test.ts`
Expected: the 5 new observability tests FAIL (existing 9 still PASS). The new ones fail because no log / EMF instrumentation exists yet.

- [ ] **Step 4: Commit failing tests**

```bash
git add applications/shared/src/rds/implementations/RdsOAuthConnectionsRepository.test.ts
git commit -m "test(rds): failing observability assertions for oauth repo"
```

---

## Task 8: Repo observability — implement encrypt + decrypt instrumentation

**Files:**
- Modify: `applications/shared/src/rds/implementations/RdsOAuthConnectionsRepository.ts`

- [ ] **Step 1: Add imports**

At the top of the file, augment the imports. The `KmsEnvelope` import already pulls from `../../crypto/index.js` — widen it to also import `IntegrityError`. Add fresh imports for `log` and `emitEmfMetric`:

```ts
import { performance } from 'node:perf_hooks';
import type { KmsEnvelope } from '../../crypto/index.js';
import { IntegrityError } from '../../crypto/index.js';
import { log } from '../../logger.js';
import { emitEmfMetric } from '../../emf.js';
```

If `KmsEnvelope` is imported via a `type` import line, leave it as is and add the value-import of `IntegrityError` separately as above. Adjust relative paths if the actual file location differs from the assumed `applications/shared/src/rds/implementations/`.

- [ ] **Step 2: Instrument `upsert`**

Wrap the existing `upsert` body. Show the full method after change:

```ts
async upsert(c: NewOAuthConnection): Promise<OAuthConnection> {
    const start = performance.now();
    let outcome: 'success' | 'error' = 'success';
    try {
        const payload = await this.deps.envelope.encrypt(c.accessToken, {
            user_id:  c.userId,
            provider: c.provider,
        });

        const sql = `
            INSERT INTO oauth_connections (
                user_id, provider, provider_user_id, username,
                access_token_ciphertext, access_token_dek, access_token_iv, access_token_tag,
                scopes, installation_id
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT (user_id, provider) DO UPDATE SET
                provider_user_id        = EXCLUDED.provider_user_id,
                username                = EXCLUDED.username,
                access_token_ciphertext = EXCLUDED.access_token_ciphertext,
                access_token_dek        = EXCLUDED.access_token_dek,
                access_token_iv         = EXCLUDED.access_token_iv,
                access_token_tag        = EXCLUDED.access_token_tag,
                scopes                  = EXCLUDED.scopes,
                installation_id         = EXCLUDED.installation_id,
                revoked_at              = NULL,
                suspended_at            = NULL
            RETURNING *
        `;
        const res = await this.deps.pool.query<Row>(sql, [
            c.userId,
            c.provider,
            c.providerUserId,
            c.username,
            payload.ciphertext,
            payload.dek,
            payload.iv,
            payload.tag,
            c.scopes,
            c.installationId,
        ]);
        return this.toModel(res.rows[0]!, c.accessToken);
    } catch (err) {
        outcome = 'error';
        throw err;
    } finally {
        log('INFO', 'oauth.token.encrypt', {
            userId:     c.userId,
            provider:   c.provider,
            durationMs: Math.round(performance.now() - start),
            outcome,
        });
    }
}
```

- [ ] **Step 3: Instrument `decryptRow`**

Replace the existing private `decryptRow` with:

```ts
// TODO(PR-2): see comment above — observability now lives here.
//
// Transition-window dual-read: prefer envelope columns, fall back to
// plaintext. Remove the fallback branch after migration 030 (sql/manual).
private async decryptRow(row: Row): Promise<string> {
    const start = performance.now();
    let outcome: 'success' | 'integrity_error' | 'kms_error' | 'legacy_plaintext' = 'success';
    let level: 'INFO' | 'ERROR' = 'INFO';
    try {
        if (
            row.access_token_ciphertext &&
            row.access_token_dek &&
            row.access_token_iv &&
            row.access_token_tag
        ) {
            return await this.deps.envelope.decrypt(
                {
                    ciphertext: row.access_token_ciphertext,
                    dek:        row.access_token_dek,
                    iv:         row.access_token_iv,
                    tag:        row.access_token_tag,
                },
                { user_id: row.user_id, provider: row.provider },
            );
        }
        if (row.access_token_enc != null) {
            outcome = 'legacy_plaintext';
            return row.access_token_enc;
        }
        throw new Error(`oauth_connections row ${row.id} has no token material`);
    } catch (err) {
        outcome = err instanceof IntegrityError ? 'integrity_error' : 'kms_error';
        level = 'ERROR';
        emitEmfMetric(
            'Portfolio/OAuth',
            { Environment: process.env['NODE_ENV'] ?? 'unknown' },
            [{ name: 'OAuthTokenDecryptFailures', value: 1, unit: 'Count' }],
            {
                userId:     row.user_id,
                provider:   row.provider,
                errorClass: err instanceof Error ? err.constructor.name : 'unknown',
            },
        );
        throw err;
    } finally {
        log(level, 'oauth.token.decrypt', {
            userId:     row.user_id,
            provider:   row.provider,
            durationMs: Math.round(performance.now() - start),
            outcome,
        });
    }
}
```

Remove the older `TODO(PR-2)` comment that referenced "add … logs and an OAuthTokenDecryptFailures metric (deferred to PR-2)" — that work is now done.

- [ ] **Step 4: Run repo tests**

Run: `yarn workspace @bedrock/shared run test src/rds/implementations/RdsOAuthConnectionsRepository.test.ts`
Expected: 14 PASS (9 existing + 5 new observability).

- [ ] **Step 5: Run typecheck**

Run: `yarn workspace @bedrock/shared run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add applications/shared/src/rds/implementations/RdsOAuthConnectionsRepository.ts
git commit -m "feat(rds): oauth.token.encrypt/decrypt logs + OAuthTokenDecryptFailures metric"
```

---

## Task 9: Build shared `dist/` so public-api can resolve the new exports

**Files:** none changed — operational.

- [ ] **Step 1: Rebuild shared**

Run: `yarn workspace @bedrock/shared run build`
Expected: `applications/shared/dist/` updated, exit 0.

(`@bedrock/shared`'s `main` points at `dist/`. Without this rebuild, the `getOAuthConnectionsRepo` instantiation path in `lib/oauth.ts` references stale CJS. Memory note `worktree-yarn-shared-dist.md` records the rule.)

- [ ] **Step 2: Run the affected test suites end-to-end**

Run:
```
yarn workspace @bedrock/shared run test src/crypto/ src/rds/
yarn workspace @repo/public-api run test src/lib/oauth.test.ts src/lib/config.test.ts
```
(adjust the public-api paths to the actual config test file located in Task 4)

Expected: all green.

- [ ] **Step 3: Commit nothing** — `dist/` is gitignored. This step is a sanity check only.

---

## Task 10: End-to-end verification + branch summary

**Files:** none changed — operational.

- [ ] **Step 1: Diff against develop**

Run: `git log --oneline origin/develop..HEAD`
Expected: roughly 8–9 commits matching Tasks 1–8.

- [ ] **Step 2: Full typecheck across both workspaces**

```
yarn workspace @bedrock/shared run typecheck
yarn workspace @repo/public-api run typecheck
yarn workspace @repo/infra run typecheck
```
Expected: all exit 0. If the infra workspace name differs, use `cd infra && yarn typecheck`.

- [ ] **Step 3: Synth diff for review**

```
cd infra && yarn cdk diff bedrock-development-data | tail -40
```
Expected: only the new `OAuthTokenKey`, `OAuthTokenKeyArnParam`, and `OAuthTokenKeyArn` output appear in the diff. No unrelated drift.

- [ ] **Step 4: Push + open PR**

Push the branch and open a PR against `develop` with the body documenting the operator runbook (key-policy grant + ConfigMap update). The PR description is the runbook — the spec already contains the wording in its "Configuration & deployment" section; copy that block into the PR body.

```bash
git push -u origin oauth-app-revocation
gh pr create --base develop --title "feat: OAuth app revocation foundation (PR-2a of 3)" --body-file - <<'EOF'
... (copy from spec, plus the standard Summary / Test Plan headings)
EOF
```

---

## Out of this plan (tracked elsewhere)

- PR-2b: GitHub App JWT helper (RS256, ≤10 min) + `POST /webhooks/github` route verifying HMAC-SHA256 signature, calling `markRevoked` / `markSuspended` via `getOAuthConnectionsRepo`. Will need a Secrets Manager wire-up for the App ID + private key + webhook secret.
- PR-2c: account soft-delete handler at the public-api layer with an outbound `DELETE /app/installations/{id}` call using the JWT helper from PR-2b. First call site of `getOAuthConnectionsRepo`.
- Operator: grant EKS node IAM role `kms:Encrypt`/`kms:Decrypt`/`kms:GenerateDataKey` on the new CMK. Update Helm ConfigMap to provide `OAUTH_TOKEN_KMS_KEY_ARN` from SSM `/oauth/token-encryption-key-arn`.
- Operator: verify RDS `StorageEncrypted` flag; add CloudTrail alarm on `DisableKey` / `ScheduleKeyDeletion` for the new CMK.
