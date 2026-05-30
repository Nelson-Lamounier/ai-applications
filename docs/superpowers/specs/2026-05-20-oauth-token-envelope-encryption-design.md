# OAuth Token Envelope Encryption (PR-1 of 3)

**Date:** 2026-05-20
**Status:** Design, pending implementation
**Author:** Nelson Lamounier

## Context

Audit of `oauth_connections.access_token_enc` (defined in
`applications/platform-rds-bootstrap/src/index.ts:56`) found the column name
suggests encryption but values are stored **plaintext**. No crypto helper or
KMS integration exists in the codebase. GitHub App `installation_id` column
also lives on this table and will accumulate additional sensitive material as
PR-2 (webhook + outbound revoke) and PR-3 (ingestion token migration) land.

This PR establishes the encryption foundation that PR-2 and PR-3 depend on.

## Goals

- Encrypt `oauth_connections.access_token` at rest using AWS KMS envelope
  encryption (per-row data encryption key wrapped by a dedicated CMK).
- Backfill existing plaintext rows in the same release.
- Add `revoked_at` and `suspended_at` columns (consumed by PR-2).
- Funnel all `oauth_connections` access through a single repository that
  owns encryption — callers see plaintext on read, pass plaintext on write.

## Non-Goals

- Webhook handler for `installation.deleted` / `installation.suspended` (PR-2).
- Outbound `DELETE /app/installations/{id}` on user soft-delete (PR-2).
- Replacing `GITHUB_TOKEN` PAT with installation tokens in
  `GitHubAdapter.ts` (PR-3).
- DEK caching, multi-region key replication, per-tenant CMK.

## Architecture

```
applications/shared/src/crypto/
  kmsEnvelope.ts                NEW — encrypt/decrypt API
  kmsEnvelope.test.ts           NEW — unit tests

applications/shared/src/rds/
  oauthConnectionsRepo.ts       NEW or extend — uses kmsEnvelope

applications/platform-rds-bootstrap/migrations/
  027_oauth_token_envelope.sql  NEW — schema additions
  028_oauth_token_drop_plain.sql NEW (follow-up) — drop plaintext column

scripts/
  backfill-oauth-token-envelope.ts  NEW — one-shot backfill

infra/lib/stacks/<crypto-or-existing>.ts
  Adds KMS CMK + Lambda grants + SSM param for key ARN
```

### Boundaries

- **kmsEnvelope.ts** — pure encryption. Input plaintext + optional
  encryption context; output `{ciphertext, dek, iv, tag}` buffers. No DB
  knowledge.
- **oauthConnectionsRepo.ts** — only call site for `oauth_connections`
  reads/writes. Encryption happens here so consumers can't bypass.
- **Migration 027** — schema additions, reversible. Backfill is a separate
  script. Migration 028 enforces NOT NULL + drops the plaintext column.
- **CDK** — provisions a dedicated CMK with rotation enabled and grants the
  public-api Lambda role `Encrypt` / `Decrypt` / `GenerateDataKey`.

## Crypto Helper

### Algorithm

AES-256-GCM with a per-row data encryption key (DEK). The DEK is generated
and wrapped by a dedicated KMS CMK ("envelope encryption"). GCM provides
confidentiality and integrity in one primitive.

### Interface

```ts
export interface EncryptedPayload {
  ciphertext: Buffer;  // AES-256-GCM output
  dek:        Buffer;  // KMS-encrypted data key
  iv:         Buffer;  // 12 bytes, random per encrypt
  tag:        Buffer;  // 16 bytes GCM auth tag
}

export interface KmsEnvelope {
  encrypt(plaintext: string, ctx?: Record<string,string>): Promise<EncryptedPayload>;
  decrypt(p: EncryptedPayload, ctx?: Record<string,string>): Promise<string>;
}

export function createKmsEnvelope(opts: {
  kmsClient: KMSClient;
  keyId: string;
}): KmsEnvelope;
```

### Encrypt steps

1. `kms.GenerateDataKey({ KeyId, KeySpec: 'AES_256', EncryptionContext })`
   returns `{ Plaintext: dekPlain, CiphertextBlob: dekEnc }`.
2. `iv = randomBytes(12)`.
3. `cipher = createCipheriv('aes-256-gcm', dekPlain, iv)`.
4. `ciphertext = update + final`; `tag = cipher.getAuthTag()`.
5. Zero `dekPlain` (`dekPlain.fill(0)`).
6. Return `{ ciphertext, dek: dekEnc, iv, tag }`.

### Decrypt steps

1. `kms.Decrypt({ CiphertextBlob: dek, EncryptionContext })` → `dekPlain`.
2. `createDecipheriv('aes-256-gcm', dekPlain, iv); setAuthTag(tag)`.
3. `update + final`; auth failure throws.
4. Zero `dekPlain`. Return utf8 string.

### Encryption context

Repo passes `{ user_id, provider }` as the KMS `EncryptionContext`. KMS only
permits decrypt when the same context is supplied — a DBA dump alone cannot
pivot one row's DEK onto another row's ciphertext.

### Errors

- `KmsEnvelopeError` wraps KMS SDK errors with `cause`.
- `IntegrityError` (distinct class) for GCM auth-tag failure → signals
  tampering or context mismatch.

## Schema

### Migration 027 — additive

```sql
BEGIN;

ALTER TABLE oauth_connections
  ADD COLUMN access_token_ciphertext BYTEA,
  ADD COLUMN access_token_dek        BYTEA,
  ADD COLUMN access_token_iv         BYTEA,
  ADD COLUMN access_token_tag        BYTEA,
  ADD COLUMN revoked_at              TIMESTAMPTZ,
  ADD COLUMN suspended_at            TIMESTAMPTZ;

COMMIT;
```

### Backfill script

`scripts/backfill-oauth-token-envelope.ts`:

```
for batch of 100 rows WHERE access_token_ciphertext IS NULL
                        AND access_token_enc IS NOT NULL:
  payload = kmsEnvelope.encrypt(row.access_token_enc,
                                {user_id: row.user_id, provider: row.provider})
  UPDATE oauth_connections SET
    access_token_ciphertext = payload.ciphertext,
    access_token_dek        = payload.dek,
    access_token_iv         = payload.iv,
    access_token_tag        = payload.tag
  WHERE id = row.id
commit batch; log progress; on error halt non-zero
```

Idempotent (WHERE-guard); re-runnable. Runs dev → staging → prod.

### Verification gate

```sql
SELECT COUNT(*) FROM oauth_connections
WHERE access_token_enc IS NOT NULL
  AND access_token_ciphertext IS NULL;
-- must be 0 before applying migration 028
```

### Migration 028 — drop plaintext (follow-up release)

```sql
BEGIN;

ALTER TABLE oauth_connections
  ALTER COLUMN access_token_ciphertext SET NOT NULL,
  ALTER COLUMN access_token_dek        SET NOT NULL,
  ALTER COLUMN access_token_iv         SET NOT NULL,
  ALTER COLUMN access_token_tag        SET NOT NULL,
  DROP COLUMN access_token_enc,
  ADD CONSTRAINT oauth_iv_length  CHECK (octet_length(access_token_iv)  = 12),
  ADD CONSTRAINT oauth_tag_length CHECK (octet_length(access_token_tag) = 16);

COMMIT;
```

Take a manual RDS snapshot immediately before applying 028.

## Repository

`applications/shared/src/rds/oauthConnectionsRepo.ts`:

```ts
export interface OAuthConnection {
  id:             string;
  userId:         string;
  provider:       string;
  providerUserId: string;
  username:       string;
  accessToken:    string;          // plaintext, in-memory only
  scopes:         string[];
  installationId: string | null;
  connectedAt:    Date;
  revokedAt:      Date | null;
  suspendedAt:    Date | null;
}

export interface OAuthConnectionsRepo {
  upsert(c: Omit<OAuthConnection,'id'|'connectedAt'|'revokedAt'|'suspendedAt'>): Promise<OAuthConnection>;
  getByUserAndProvider(userId: string, provider: string): Promise<OAuthConnection | null>;
  getByInstallationId(installationId: string): Promise<OAuthConnection | null>;
  markRevoked(id: string, at: Date): Promise<void>;
  markSuspended(id: string, at: Date): Promise<void>;
}

export function createOAuthConnectionsRepo(deps: {
  pool: Pool;
  envelope: KmsEnvelope;
}): OAuthConnectionsRepo;
```

### Transition-window dual-read

Between migrations 027 and 028, the repo `get*` methods:

1. If `access_token_ciphertext IS NOT NULL`, decrypt envelope.
2. Else if `access_token_enc IS NOT NULL`, return plaintext directly.

After 028 ships, remove the fallback branch (tracked by inline TODO).

Writes always use the new envelope columns. Old column is not updated.

`markRevoked` and `markSuspended` ship in PR-1 even though PR-2 is their
primary consumer — keeps PR-2 from re-touching the repo file.

## CDK

```ts
const tokenKey = new kms.Key(this, 'OAuthTokenKey', {
  alias: 'alias/oauth-token-encryption',
  description: 'Envelope encryption for oauth_connections.access_token',
  enableKeyRotation: true,
  removalPolicy: RemovalPolicy.RETAIN,
  pendingWindow: Duration.days(30),
});

tokenKey.grantEncryptDecrypt(publicApiLambdaRole);

new ssm.StringParameter(this, 'OAuthTokenKeyArnParam', {
  parameterName: '/oauth/token-encryption-key-arn',
  stringValue: tokenKey.keyArn,
});
```

App reads `OAUTH_TOKEN_KMS_KEY_ARN` env var (sourced from SSM at deploy
time) and constructs `KMSClient` + `createKmsEnvelope({ keyId })` at boot.

Backfill script needs the same IAM permissions; grant explicitly to whichever
role executes it (local dev role or one-shot Lambda).

### Why a dedicated CMK

- Blast-radius isolation from RDS / Secrets Manager keys.
- Per-application CloudTrail audit.
- Explicit key policy listing the one role allowed to decrypt.
- Independent rotation cadence.

## Testing

### `kmsEnvelope.test.ts`

`aws-sdk-client-mock` for KMS, real `node:crypto` for AES-GCM:

1. Roundtrip — plaintext in, same plaintext out.
2. Tampered ciphertext → `IntegrityError`.
3. Tampered tag → `IntegrityError`.
4. Wrong encryption context on decrypt → KMS rejects, helper wraps.
5. Fresh IV per call — same plaintext encrypts to different ciphertext.
6. KMS Decrypt failure → wrapped error preserves `cause`.
7. DEK zeroed after use (best-effort via observable proxy).

### `oauthConnectionsRepo.test.ts`

In-memory `KmsEnvelope` fake (base64 round-trip) + Postgres (testcontainers
or existing harness):

- `upsert` + `getByUserAndProvider` returns plaintext.
- `upsert` writes 4 non-null `bytea` columns (raw SELECT assertion).
- `getByInstallationId` happy + miss.
- `markRevoked` / `markSuspended` set timestamps.
- Decrypt with wrong context surfaces error.

### Backfill script test

- Seed 5 plaintext rows, run script, assert 0 plaintext remain, all 5
  decrypt to original values.
- Re-run → no-op.

No LocalStack. Fast, deterministic.

## Sequencing

1. CDK: add CMK + grant + SSM param. Deploy first.
2. App: `kmsEnvelope.ts` + tests.
3. App: `oauthConnectionsRepo.ts` (dual-read, encrypted writes).
4. Migration 027 — add columns. Apply dev → staging → prod.
5. Run backfill script in each env. Verify `count = 0`.
6. (Follow-up release after ≥48h prod soak) Migration 028 + remove
   dual-read fallback. Take RDS snapshot first.

Steps 1–5 = PR-1. Step 6 = PR-1b.

## Risks

| Risk | Mitigation |
|---|---|
| Backfill mid-run failure leaves half-migrated rows | Idempotent script, batched commits, re-runnable. Old column kept until 028. |
| CMK accidentally disabled / deleted → rows undecryptable | `pendingWindow: 30 days`, `RemovalPolicy.RETAIN`. Follow-up: CloudTrail alarm on `DisableKey` / `ScheduleKeyDeletion`. |
| Encryption-context drift | JSDoc on `kmsEnvelope.ts`; repo tests assert context binding. |
| KMS throttling on bulk reads | PR-1 has no bulk read path. Add DEK cache in PR-3 when ingestion read volume materializes. |
| Migration 027 ships but backfill forgotten | 028 verification query (count = 0) gates the drop. Dual-read keeps app functional in interim. |
| Plaintext leakage via logs | Repo returns `OAuthConnection` with plaintext token; callers must not log the object. Follow-up: ESLint rule + `redact()` helper. |

## Rollback

- Pre-028: drop the new columns. Reversible.
- Post-028: restore from manual RDS snapshot taken immediately before
  applying 028.

## Observability

- Structured logs: `oauth.token.encrypt` / `oauth.token.decrypt` with
  `userId`, `provider`, latency, outcome. No token material in logs.
- CloudWatch metric `OAuthTokenDecryptFailures` → alarm > 0.

## Follow-up PRs

- **PR-2:** GitHub webhook handler (`installation.deleted`,
  `installation.suspended`) + outbound `DELETE /app/installations/{id}` on
  user soft-delete. Uses `markRevoked` / `markSuspended` and
  `getByInstallationId` from this PR.
- **PR-3:** Replace `GITHUB_TOKEN` PAT in `GitHubAdapter.ts` with
  per-installation tokens via App JWT. Introduces in-memory installation-
  token cache (TTL < 1h). May add DEK cache if read volume warrants.

## Out of scope

- RDS storage-encryption verification (separate ops task; check
  `aws rds describe-db-instances --query 'DBInstances[].StorageEncrypted'`
  for the platform DB instance and snapshot+restore if `false`).
- ESLint rule preventing whole-object logging of `OAuthConnection`.
- CloudTrail alarms on KMS key disable/delete.
