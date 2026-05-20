# OAuth App Revocation Foundation (PR-2a of PR-2 trio)

**Date:** 2026-05-20
**Status:** Design, pending implementation
**Author:** Nelson Lamounier

## Context

PR-1 ([2026-05-20-oauth-token-envelope-encryption-design.md](2026-05-20-oauth-token-envelope-encryption-design.md))
landed envelope encryption for `oauth_connections.access_token` with a
dedicated repository, a backfill, and migrations 029/030. It deliberately
deferred three pieces:

1. Provisioning the dedicated KMS CMK that the repo encrypts against.
2. Wiring `RdsOAuthConnectionsRepository` into the public-api boot path.
3. Structured observability for encrypt/decrypt (logs + decrypt-failure
   metric).

PR-2 in the original spec was a single follow-up. During brainstorming it
was decomposed into three smaller PRs:

- **PR-2a (this spec):** foundation — CDK CMK, boot wiring, observability.
- **PR-2b:** GitHub App JWT helper + inbound webhook handler
  (`installation.deleted` / `installation.suspended`).
- **PR-2c:** user soft-delete handler + outbound
  `DELETE /app/installations/{id}` revocation.

PR-2a is consumer-less by design — its job is to make the encrypted repo
constructable and observable so PR-2b and PR-2c can focus on their
business logic.

## Goals

- Provision a dedicated KMS CMK (`alias/oauth-token-encryption`) with
  rotation enabled and a 30-day deletion grace window.
- Publish the CMK ARN to SSM at `/oauth/token-encryption-key-arn` so the
  Helm ConfigMap can deliver it to the pod.
- Add lazy singleton accessors `getKmsEnvelope(config)` and
  `getOAuthConnectionsRepo(config)` to `api/public-api/src/lib/oauth.ts`,
  mirroring the existing `getPool` pattern.
- Add structured logs (`oauth.token.encrypt` / `oauth.token.decrypt`) and
  an EMF metric (`OAuthTokenDecryptFailures` in `Portfolio/OAuth`) inside
  `RdsOAuthConnectionsRepository`.

## Non-Goals

- IAM grant from the CMK to the EKS node role. The user manages this out
  of band — the new key's policy stays at AWS default (root-only) after
  CDK deploys it.
- Helm chart updates (ConfigMap addition). The user owns the Helm /
  Kustomize layer.
- GitHub App JWT signing, webhook handler, outbound `DELETE /app/installations`
  — all deferred to PR-2b / PR-2c.
- Migrating public-api from EC2-instance-profile auth to IRSA.

## Discoveries that shaped the design

- **public-api is a K8s pod, not a Lambda.** Auth via the EC2 node
  instance profile (`api/public-api/src/lib/config.ts` documents this).
  CDK cannot grant the node role here because the EKS cluster + node
  IAM role live outside this repo.
- **No DI container.** Routes call `getPool(loadConfig())` directly
  (`api/public-api/src/lib/pg.ts`). The new repo follows the same
  pattern.
- **Existing helpers exist** for both structured logs (`logger.ts`) and
  EMF metrics (`emf.ts`) in `@bedrock/shared`. Reuse them.

## Architecture

```
infra/lib/stacks/bedrock/data-stack.ts                                MODIFY
  + new kms.Key 'OAuthTokenKey'  (alias/oauth-token-encryption)
  + new ssm.StringParameter '/oauth/token-encryption-key-arn'
  + CfnOutput OAuthTokenKeyArn
  (key policy unchanged from AWS default — user grants node role manually)

api/public-api/src/lib/oauth.ts                                       NEW
  export getKmsEnvelope(config): KmsEnvelope
  export getOAuthConnectionsRepo(config): IOAuthConnectionsRepository
  export __resetOAuthSingletonsForTests(): void

api/public-api/src/lib/oauth.test.ts                                  NEW

api/public-api/src/lib/config.ts                                      MODIFY
  + readonly oauthTokenKmsKeyArn: string
  + loadConfig() reads OAUTH_TOKEN_KMS_KEY_ARN

applications/shared/src/rds/implementations/
  RdsOAuthConnectionsRepository.ts                                    MODIFY
  + log('info', 'oauth.token.encrypt', { ... })
  + log('info'|'error', 'oauth.token.decrypt', { ... })
  + emitEmfMetric('Portfolio/OAuth', ...) on decrypt failure

applications/shared/src/rds/implementations/
  RdsOAuthConnectionsRepository.test.ts                               MODIFY
  + spy assertions for log + emitEmfMetric on encrypt + decrypt paths
```

## CDK changes

**File:** `infra/lib/stacks/bedrock/data-stack.ts`

```ts
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';

const oauthTokenKey = new kms.Key(this, 'OAuthTokenKey', {
    alias: 'alias/oauth-token-encryption',
    description: 'Envelope encryption for oauth_connections.access_token',
    enableKeyRotation: true,
    removalPolicy: RemovalPolicy.RETAIN,
    pendingWindow: Duration.days(30),
});

new ssm.StringParameter(this, 'OAuthTokenKeyArnParam', {
    parameterName: '/oauth/token-encryption-key-arn',
    stringValue: oauthTokenKey.keyArn,
    description: 'KMS CMK ARN for oauth_connections token envelope encryption',
});

new CfnOutput(this, 'OAuthTokenKeyArn', {
    value: oauthTokenKey.keyArn,
    description: 'KMS CMK ARN for oauth_connections token envelope encryption',
    exportName: 'OAuthTokenKeyArn',
});
```

**Why no `grantEncryptDecrypt`:** the EKS node IAM role is managed
outside this repo. User adds it to the CMK key policy manually after
CDK deploy.

**Test:** synth-based unit test in `infra/tests/` asserting:
- A `AWS::KMS::Key` resource exists with `EnableKeyRotation: true`,
  `PendingWindowInDays: 30`, and the alias.
- A `AWS::SSM::Parameter` resource exists with name
  `/oauth/token-encryption-key-arn`.

## App boot wiring

### `config.ts`

Append to the `Config` interface:

```ts
/** KMS CMK ARN for oauth token envelope encryption — sourced from
 *  OAUTH_TOKEN_KMS_KEY_ARN (ConfigMap, populated from SSM). */
readonly oauthTokenKmsKeyArn: string;
```

In `loadConfig()`:

```ts
const oauthTokenKmsKeyArn = process.env.OAUTH_TOKEN_KMS_KEY_ARN;
if (!oauthTokenKmsKeyArn) {
    throw new Error('OAUTH_TOKEN_KMS_KEY_ARN env var is required');
}
```

### `lib/oauth.ts`

```ts
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

export function __resetOAuthSingletonsForTests(): void {
    kmsClient = undefined;
    envelope  = undefined;
    repo      = undefined;
}
```

**Tests** (`oauth.test.ts`):
- `getKmsEnvelope` returns the same instance on repeated calls.
- `getOAuthConnectionsRepo` returns the same instance on repeated calls.
- After `__resetOAuthSingletonsForTests()`, the next call returns a new
  instance.
- `loadConfig()` throws when `OAUTH_TOKEN_KMS_KEY_ARN` is unset.

## Observability instrumentation

**File:** `applications/shared/src/rds/implementations/RdsOAuthConnectionsRepository.ts`

Use existing helpers: `log` from `applications/shared/src/logger.ts`,
`emitEmfMetric` from `applications/shared/src/emf.ts`.

### Encrypt path

Inside `upsert`, around the `envelope.encrypt` call:

```ts
const start = performance.now();
let outcome: 'success' | 'error' = 'success';
try {
    const payload = await this.deps.envelope.encrypt(c.accessToken, {
        user_id:  c.userId,
        provider: c.provider,
    });
    // ... INSERT ...
    return /* ... */;
} catch (err) {
    outcome = 'error';
    throw err;
} finally {
    log('info', 'oauth.token.encrypt', {
        userId:     c.userId,
        provider:   c.provider,
        durationMs: Math.round(performance.now() - start),
        outcome,
    });
}
```

### Decrypt path

Inside `decryptRow`:

```ts
const start = performance.now();
let outcome: 'success' | 'integrity_error' | 'kms_error' | 'legacy_plaintext' = 'success';
try {
    if (row.access_token_ciphertext && /* … */) {
        return await this.deps.envelope.decrypt(/* … */);
    }
    if (row.access_token_enc != null) {
        outcome = 'legacy_plaintext';
        return row.access_token_enc;
    }
    throw new Error(`oauth_connections row ${row.id} has no token material`);
} catch (err) {
    outcome = err instanceof IntegrityError ? 'integrity_error' : 'kms_error';
    emitEmfMetric(
        'Portfolio/OAuth',
        { Environment: process.env.NODE_ENV ?? 'unknown' },
        [{ name: 'OAuthTokenDecryptFailures', value: 1, unit: 'Count' }],
        { userId: row.user_id, provider: row.provider, errorClass: err instanceof Error ? err.constructor.name : 'unknown' },
    );
    throw err;
} finally {
    const level = outcome === 'success' || outcome === 'legacy_plaintext' ? 'info' : 'error';
    log(level, 'oauth.token.decrypt', {
        userId:     row.user_id,
        provider:   row.provider,
        durationMs: Math.round(performance.now() - start),
        outcome,
    });
}
```

The `IntegrityError` import already exists in the repo's neighbourhood
(`../../crypto/index.js`); only the named import widens.

### What is NEVER logged

- Plaintext access token, ciphertext bytes, DEK, IV, or tag.
- KMS error `.message` verbatim (may contain key id fragments in some
  failure modes). Log only `errorClass = err.constructor.name`. The
  caught `cause` survives on the thrown error for upstream handlers.

### Metric cardinality

`userId` is a metric *property* (high cardinality, log-only),
not a metric *dimension*. Only `Environment` is a dimension — CloudWatch
metric count stays bounded.

## Configuration & deployment

### What this PR delivers
- New CDK resources (CMK + SSM param + output).
- Required env var `OAUTH_TOKEN_KMS_KEY_ARN` documented in `config.ts`.
- App-side lazy wiring (no consumer in this PR).

### What the operator does after merging this PR (in order)
1. Deploy CDK (`cdk deploy`) to provision the CMK + SSM param.
2. Add the EKS node IAM role to the CMK key policy with
   `kms:Encrypt`, `kms:Decrypt`, `kms:GenerateDataKey`.
3. Update the public-api Helm ConfigMap to add
   `OAUTH_TOKEN_KMS_KEY_ARN`, sourced from the SSM param
   `/oauth/token-encryption-key-arn`.
4. Roll the public-api pod. Boot succeeds because env var is now present;
   no KMS call happens until PR-2b lands a consumer.

If steps 2–3 are skipped, the pod will still boot (env var only checked
at boot, no KMS call until a real consumer arrives), but PR-2b/PR-2c
deployments will 403 on encrypt/decrypt.

## Risks

| Risk | Mitigation |
|---|---|
| Operator skips key-policy grant → encrypt/decrypt 403s when PR-2b lands | PR-2a has no consumer; can't break prod. PR-2b PR description repeats the prerequisite. |
| ConfigMap not updated → pod CrashLoopBackoff on next deploy | Required env var is documented; deploy order in PR description. App will continue running on old pods until the new env var is set, so no instant outage. |
| Test singleton bleed across files | `__resetOAuthSingletonsForTests()` exposed; called in `beforeEach`. |
| EMF metric cost spike if decrypt fails in tight loop | `OAuthTokenDecryptFailures` is one metric, one dimension (`Environment`). Cost is per data point, not per failed call (CloudWatch aggregates). Bounded. |
| `userId` logged at every encrypt/decrypt risks PII volume in logs | `userId` is an internal UUID, not PII. Already logged elsewhere in the codebase. |
| `RemovalPolicy.RETAIN` blocks accidental key deletion but also blocks intentional teardown via `cdk destroy` | Documented. To delete the key, schedule deletion via AWS console and accept the 30-day pending window. |

## Rollback

- CDK: revert the data-stack change. The key is retained, so a no-op for
  the live key but the SSM param is removed.
- App: revert removes the import and the lazy accessors. No production
  effect — no consumer in PR-2a.
- DB: nothing.

## Observability acceptance criteria

- After deploy, every successful `upsert` produces a log line
  `level=info, msg=oauth.token.encrypt, userId=..., provider=..., durationMs=..., outcome=success`.
- A forced decrypt failure (e.g. dropped `access_token_dek`) produces
  one EMF metric data point on `OAuthTokenDecryptFailures` and a
  matching `level=error` log line.

## Follow-up PRs

- **PR-2b:** GitHub App JWT helper (RS256, ≤10min TTL) +
  `POST /webhooks/github` route verifying HMAC-SHA256 signature,
  handling `installation.deleted` / `installation.suspended` events,
  calling `markRevoked` / `markSuspended` via `getOAuthConnectionsRepo`.
- **PR-2c:** account soft-delete handler at the public-api layer
  (`users.deleted_at` write path), with an outbound
  `DELETE /app/installations/{id}` call via the App JWT from PR-2b.

## Out of scope

- RDS `StorageEncrypted` verification (operator task).
- CloudTrail alarms on `DisableKey` / `ScheduleKeyDeletion` (operator
  task).
- `(err as any)?.message` cleanup in `kmsEnvelope.ts` (low priority;
  separate refactor).
- Migration from EC2 instance profile to IRSA for public-api (separate
  K8s-infra concern).
