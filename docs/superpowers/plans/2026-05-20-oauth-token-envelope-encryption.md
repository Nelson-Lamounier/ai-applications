# OAuth Token Envelope Encryption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encrypt `oauth_connections.access_token` at rest with AWS KMS envelope encryption, backfill existing plaintext rows, and funnel all access through a single repository — establishing the foundation PR-2 (webhook + outbound revoke) and PR-3 (ingestion installation tokens) build on.

**Architecture:** Pure `kmsEnvelope` helper (AES-256-GCM + KMS-wrapped DEK with `{user_id, provider}` encryption context) is consumed by an `RdsOAuthConnectionsRepository`. A two-phase migration (additive 027, drop-plaintext 028) plus a re-runnable backfill script moves rows without downtime. A dedicated CMK with rotation enabled is provisioned in CDK and granted only to the public-api Lambda role.

**Tech Stack:** TypeScript, Node 22, AWS SDK v3 (`@aws-sdk/client-kms`), `node:crypto` (AES-GCM), `pg`, Jest, `aws-sdk-client-mock`, AWS CDK v2.

**Spec:** [docs/superpowers/specs/2026-05-20-oauth-token-envelope-encryption-design.md](../specs/2026-05-20-oauth-token-envelope-encryption-design.md)

---

## File Structure

**Create:**
- `applications/shared/src/crypto/kmsEnvelope.ts` — pure crypto helper
- `applications/shared/src/crypto/kmsEnvelope.test.ts`
- `applications/shared/src/crypto/index.ts` — public exports
- `applications/shared/src/rds/interfaces/IOAuthConnectionsRepository.ts`
- `applications/shared/src/rds/implementations/RdsOAuthConnectionsRepository.ts`
- `applications/shared/src/rds/implementations/RdsOAuthConnectionsRepository.test.ts`
- `applications/platform-rds-bootstrap/migrations/027_oauth_token_envelope.sql`
- `applications/platform-rds-bootstrap/migrations/028_oauth_token_drop_plain.sql` (committed but applied later, after backfill)
- `scripts/backfill-oauth-token-envelope.ts`
- `scripts/backfill-oauth-token-envelope.test.ts`

**Modify:**
- `applications/shared/package.json` — add `@aws-sdk/client-kms`, dev-dep `aws-sdk-client-mock`
- `applications/shared/src/rds/index.ts` — export new repo + interface
- `applications/shared/src/index.ts` — re-export crypto helper if pattern matches
- `infra/lib/stacks/bedrock/api-stack.ts` — add CMK, grant Lambda role, SSM param, env var

---

## Task 1: Add KMS SDK dependency

**Files:**
- Modify: `applications/shared/package.json`

- [ ] **Step 1: Add the dependency**

Edit `applications/shared/package.json`. Insert into `"dependencies"` (alphabetical):

```json
"@aws-sdk/client-kms": "^3.1001.0",
```

Insert `"devDependencies"`:

```json
"aws-sdk-client-mock": "^4.1.0"
```

- [ ] **Step 2: Install**

Run: `yarn workspace @bedrock/shared install` (from repo root).
Expected: lockfile updated, no errors.

- [ ] **Step 3: Build shared to refresh dist**

Run: `yarn workspace @bedrock/shared build`
Expected: `dist/` updated, exit 0.

- [ ] **Step 4: Commit**

```bash
git add applications/shared/package.json yarn.lock
git commit -m "chore(shared): add @aws-sdk/client-kms + aws-sdk-client-mock"
```

---

## Task 2: kmsEnvelope helper — failing roundtrip test

**Files:**
- Create: `applications/shared/src/crypto/kmsEnvelope.test.ts`

- [ ] **Step 1: Write the test file (only the roundtrip test for now)**

```ts
// applications/shared/src/crypto/kmsEnvelope.test.ts
import { mockClient } from 'aws-sdk-client-mock';
import {
    KMSClient,
    GenerateDataKeyCommand,
    DecryptCommand,
} from '@aws-sdk/client-kms';
import { randomBytes } from 'node:crypto';
import { createKmsEnvelope } from './kmsEnvelope.js';

const kmsMock = mockClient(KMSClient);

beforeEach(() => kmsMock.reset());

test('encrypt → decrypt roundtrip returns original plaintext', async () => {
    const dekPlain = randomBytes(32);
    const dekEnc = Buffer.from('fake-kms-ciphertext');

    kmsMock.on(GenerateDataKeyCommand).resolves({
        Plaintext: dekPlain,
        CiphertextBlob: dekEnc,
    });
    kmsMock.on(DecryptCommand).resolves({ Plaintext: dekPlain });

    const env = createKmsEnvelope({
        kmsClient: new KMSClient({}),
        keyId: 'alias/test',
    });

    const payload = await env.encrypt('ghp_secret_token', {
        user_id: 'u1',
        provider: 'github',
    });
    const out = await env.decrypt(payload, {
        user_id: 'u1',
        provider: 'github',
    });

    expect(out).toBe('ghp_secret_token');
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `yarn workspace @bedrock/shared jest src/crypto/kmsEnvelope.test.ts -t roundtrip`
Expected: FAIL — `Cannot find module './kmsEnvelope.js'`.

- [ ] **Step 3: Commit the failing test**

```bash
git add applications/shared/src/crypto/kmsEnvelope.test.ts
git commit -m "test(crypto): failing roundtrip test for kmsEnvelope"
```

---

## Task 3: kmsEnvelope helper — minimal implementation

**Files:**
- Create: `applications/shared/src/crypto/kmsEnvelope.ts`
- Create: `applications/shared/src/crypto/index.ts`

- [ ] **Step 1: Write `kmsEnvelope.ts`**

```ts
// applications/shared/src/crypto/kmsEnvelope.ts
/**
 * AES-256-GCM envelope encryption backed by AWS KMS.
 *
 * Each call to `encrypt` requests a fresh data key from KMS, uses it once,
 * and zeroes the plaintext key buffer. The encrypted DEK is stored alongside
 * the ciphertext. Decryption asks KMS to unwrap the DEK, then performs
 * AES-256-GCM with the supplied IV and auth tag.
 *
 * The optional `ctx` parameter is passed to KMS as EncryptionContext (AAD).
 * Callers MUST supply the same context on decrypt or KMS refuses. Use this
 * to bind ciphertext to its row (e.g. `{ user_id, provider }`).
 */

import {
    KMSClient,
    GenerateDataKeyCommand,
    DecryptCommand,
} from '@aws-sdk/client-kms';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedPayload {
    ciphertext: Buffer;
    dek:        Buffer;
    iv:         Buffer;
    tag:        Buffer;
}

export interface KmsEnvelope {
    encrypt(plaintext: string, ctx?: Record<string, string>): Promise<EncryptedPayload>;
    decrypt(p: EncryptedPayload, ctx?: Record<string, string>): Promise<string>;
}

export class KmsEnvelopeError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'KmsEnvelopeError';
    }
}

export class IntegrityError extends KmsEnvelopeError {
    constructor(message = 'envelope integrity check failed', options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'IntegrityError';
    }
}

export function createKmsEnvelope(opts: {
    kmsClient: KMSClient;
    keyId:     string;
}): KmsEnvelope {
    const { kmsClient, keyId } = opts;

    return {
        async encrypt(plaintext, ctx) {
            let dekPlain: Buffer | undefined;
            try {
                const out = await kmsClient.send(
                    new GenerateDataKeyCommand({
                        KeyId: keyId,
                        KeySpec: 'AES_256',
                        EncryptionContext: ctx,
                    }),
                );
                if (!out.Plaintext || !out.CiphertextBlob) {
                    throw new KmsEnvelopeError('KMS GenerateDataKey returned empty material');
                }
                dekPlain = Buffer.from(out.Plaintext);
                const dekEnc = Buffer.from(out.CiphertextBlob);

                const iv = randomBytes(12);
                const cipher = createCipheriv('aes-256-gcm', dekPlain, iv);
                const ciphertext = Buffer.concat([
                    cipher.update(plaintext, 'utf8'),
                    cipher.final(),
                ]);
                const tag = cipher.getAuthTag();

                return { ciphertext, dek: dekEnc, iv, tag };
            } catch (err) {
                if (err instanceof KmsEnvelopeError) throw err;
                throw new KmsEnvelopeError('encrypt failed', { cause: err });
            } finally {
                if (dekPlain) dekPlain.fill(0);
            }
        },

        async decrypt(payload, ctx) {
            let dekPlain: Buffer | undefined;
            try {
                const out = await kmsClient.send(
                    new DecryptCommand({
                        CiphertextBlob: payload.dek,
                        EncryptionContext: ctx,
                    }),
                );
                if (!out.Plaintext) {
                    throw new KmsEnvelopeError('KMS Decrypt returned empty plaintext');
                }
                dekPlain = Buffer.from(out.Plaintext);

                const decipher = createDecipheriv('aes-256-gcm', dekPlain, payload.iv);
                decipher.setAuthTag(payload.tag);
                const plain = Buffer.concat([
                    decipher.update(payload.ciphertext),
                    decipher.final(),
                ]);
                return plain.toString('utf8');
            } catch (err) {
                // GCM auth failure surfaces as a generic Error from node:crypto.
                if (err instanceof Error && /unable to authenticate|auth tag/i.test(err.message)) {
                    throw new IntegrityError(undefined, { cause: err });
                }
                if (err instanceof KmsEnvelopeError) throw err;
                throw new KmsEnvelopeError('decrypt failed', { cause: err });
            } finally {
                if (dekPlain) dekPlain.fill(0);
            }
        },
    };
}
```

- [ ] **Step 2: Write `crypto/index.ts`**

```ts
// applications/shared/src/crypto/index.ts
export {
    createKmsEnvelope,
    KmsEnvelopeError,
    IntegrityError,
} from './kmsEnvelope.js';
export type { KmsEnvelope, EncryptedPayload } from './kmsEnvelope.js';
```

- [ ] **Step 3: Run the test, verify it passes**

Run: `yarn workspace @bedrock/shared jest src/crypto/kmsEnvelope.test.ts -t roundtrip`
Expected: PASS, 1 test.

- [ ] **Step 4: Commit**

```bash
git add applications/shared/src/crypto/kmsEnvelope.ts applications/shared/src/crypto/index.ts
git commit -m "feat(crypto): kmsEnvelope helper with AES-256-GCM + KMS-wrapped DEK"
```

---

## Task 4: kmsEnvelope — tamper / integrity tests

**Files:**
- Modify: `applications/shared/src/crypto/kmsEnvelope.test.ts`

- [ ] **Step 1: Append the tamper tests**

Append below the roundtrip test:

```ts
test('tampered ciphertext byte → IntegrityError', async () => {
    const dekPlain = randomBytes(32);
    kmsMock.on(GenerateDataKeyCommand).resolves({
        Plaintext: dekPlain,
        CiphertextBlob: Buffer.from('enc'),
    });
    kmsMock.on(DecryptCommand).resolves({ Plaintext: dekPlain });

    const env = createKmsEnvelope({ kmsClient: new KMSClient({}), keyId: 'k' });
    const p = await env.encrypt('hello');
    p.ciphertext[0] ^= 0xff; // flip a byte

    await expect(env.decrypt(p)).rejects.toBeInstanceOf(IntegrityError);
});

test('tampered tag → IntegrityError', async () => {
    const dekPlain = randomBytes(32);
    kmsMock.on(GenerateDataKeyCommand).resolves({
        Plaintext: dekPlain,
        CiphertextBlob: Buffer.from('enc'),
    });
    kmsMock.on(DecryptCommand).resolves({ Plaintext: dekPlain });

    const env = createKmsEnvelope({ kmsClient: new KMSClient({}), keyId: 'k' });
    const p = await env.encrypt('hello');
    p.tag[0] ^= 0xff;

    await expect(env.decrypt(p)).rejects.toBeInstanceOf(IntegrityError);
});

test('fresh IV per call — same plaintext encrypts to different ciphertext', async () => {
    const dekPlain = randomBytes(32);
    kmsMock.on(GenerateDataKeyCommand).resolves({
        Plaintext: dekPlain,
        CiphertextBlob: Buffer.from('enc'),
    });
    const env = createKmsEnvelope({ kmsClient: new KMSClient({}), keyId: 'k' });

    const a = await env.encrypt('same');
    const b = await env.encrypt('same');

    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
});

test('KMS Decrypt failure surfaces wrapped error with cause', async () => {
    const dekPlain = randomBytes(32);
    kmsMock.on(GenerateDataKeyCommand).resolves({
        Plaintext: dekPlain,
        CiphertextBlob: Buffer.from('enc'),
    });
    const env = createKmsEnvelope({ kmsClient: new KMSClient({}), keyId: 'k' });
    const p = await env.encrypt('hello');

    kmsMock.on(DecryptCommand).rejects(new Error('InvalidCiphertextException'));
    await expect(env.decrypt(p)).rejects.toBeInstanceOf(KmsEnvelopeError);
});
```

Also add the imports at the top of the test file (extend existing import line):

```ts
import { createKmsEnvelope, KmsEnvelopeError, IntegrityError } from './kmsEnvelope.js';
```

- [ ] **Step 2: Run all tests in the file**

Run: `yarn workspace @bedrock/shared jest src/crypto/kmsEnvelope.test.ts`
Expected: 5 PASS.

- [ ] **Step 3: Commit**

```bash
git add applications/shared/src/crypto/kmsEnvelope.test.ts
git commit -m "test(crypto): tamper, IV-freshness, and KMS-failure coverage"
```

---

## Task 5: Repository interface

**Files:**
- Create: `applications/shared/src/rds/interfaces/IOAuthConnectionsRepository.ts`
- Modify: `applications/shared/src/rds/interfaces/index.ts` (if it exists; create otherwise)

- [ ] **Step 1: Write the interface**

```ts
// applications/shared/src/rds/interfaces/IOAuthConnectionsRepository.ts

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

export type NewOAuthConnection = Omit<
    OAuthConnection,
    'id' | 'connectedAt' | 'revokedAt' | 'suspendedAt'
>;

export interface IOAuthConnectionsRepository {
    upsert(c: NewOAuthConnection): Promise<OAuthConnection>;
    getByUserAndProvider(userId: string, provider: string): Promise<OAuthConnection | null>;
    getByInstallationId(installationId: string): Promise<OAuthConnection | null>;
    markRevoked(id: string, at: Date): Promise<void>;
    markSuspended(id: string, at: Date): Promise<void>;
}
```

- [ ] **Step 2: Re-export from `interfaces/index.ts`**

Check if file exists with `cat applications/shared/src/rds/interfaces/index.ts`. Append (or create with) a line:

```ts
export * from './IOAuthConnectionsRepository.js';
```

- [ ] **Step 3: Typecheck**

Run: `yarn workspace @bedrock/shared typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add applications/shared/src/rds/interfaces/IOAuthConnectionsRepository.ts applications/shared/src/rds/interfaces/index.ts
git commit -m "feat(rds): IOAuthConnectionsRepository interface"
```

---

## Task 6: Repo implementation — failing upsert+get test

**Files:**
- Create: `applications/shared/src/rds/implementations/RdsOAuthConnectionsRepository.test.ts`

This task uses an in-memory `KmsEnvelope` fake (base64) and a real Postgres via the same harness used by `RdsSyncStateRepository.test.ts`. Inspect that file first for the connection pattern; replicate it.

- [ ] **Step 1: Inspect the existing harness**

Run: `head -60 applications/shared/src/rds/implementations/RdsSyncStateRepository.test.ts`
Note: pool construction, `beforeAll`/`afterAll`, the connection string env var (likely `DATABASE_URL` or `RDS_URL`).

- [ ] **Step 2: Write the failing test**

```ts
// applications/shared/src/rds/implementations/RdsOAuthConnectionsRepository.test.ts
import { Pool } from 'pg';
import { RdsOAuthConnectionsRepository } from './RdsOAuthConnectionsRepository.js';
import type { KmsEnvelope, EncryptedPayload } from '../../crypto/index.js';

// Fake envelope: base64 round-trip, asserts ctx symmetry
function fakeEnvelope(): KmsEnvelope {
    return {
        async encrypt(plaintext) {
            return {
                ciphertext: Buffer.from(plaintext, 'utf8'),
                dek:        Buffer.from('fake-dek'),
                iv:         Buffer.alloc(12, 1),
                tag:        Buffer.alloc(16, 2),
            } satisfies EncryptedPayload;
        },
        async decrypt(p) {
            return p.ciphertext.toString('utf8');
        },
    };
}

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

beforeAll(async () => {
    // Match existing harness — apply migrations 001..027 against test DB.
    // If a shared helper exists (e.g. applyMigrations()), use it.
});

afterAll(async () => {
    await pool.end();
});

beforeEach(async () => {
    await pool.query('TRUNCATE oauth_connections, users CASCADE');
    await pool.query(
        `INSERT INTO users (id, email) VALUES ('00000000-0000-0000-0000-000000000001', 'a@b.c')`,
    );
});

test('upsert then getByUserAndProvider returns plaintext token', async () => {
    const repo = new RdsOAuthConnectionsRepository({ pool, envelope: fakeEnvelope() });

    await repo.upsert({
        userId:         '00000000-0000-0000-0000-000000000001',
        provider:       'github',
        providerUserId: '42',
        username:       'octocat',
        accessToken:    'ghp_supersecret',
        scopes:         ['repo'],
        installationId: '999',
    });

    const got = await repo.getByUserAndProvider(
        '00000000-0000-0000-0000-000000000001',
        'github',
    );
    expect(got?.accessToken).toBe('ghp_supersecret');
    expect(got?.installationId).toBe('999');
});
```

- [ ] **Step 3: Run, verify failure**

Run: `yarn workspace @bedrock/shared jest src/rds/implementations/RdsOAuthConnectionsRepository.test.ts -t "returns plaintext"`
Expected: FAIL — `Cannot find module './RdsOAuthConnectionsRepository.js'`.

- [ ] **Step 4: Commit failing test**

```bash
git add applications/shared/src/rds/implementations/RdsOAuthConnectionsRepository.test.ts
git commit -m "test(rds): failing upsert+get for RdsOAuthConnectionsRepository"
```

---

## Task 7: Apply migration 027 in test DB harness, then implement repo

**Files:**
- Create: `applications/platform-rds-bootstrap/migrations/027_oauth_token_envelope.sql`
- Create: `applications/shared/src/rds/implementations/RdsOAuthConnectionsRepository.ts`
- Modify: `applications/shared/src/rds/index.ts`

- [ ] **Step 1: Write migration 027**

```sql
-- applications/platform-rds-bootstrap/migrations/027_oauth_token_envelope.sql
-- Adds envelope-encryption columns + revoked_at/suspended_at to oauth_connections.
-- Plaintext access_token_enc is kept for the transition window; dropped by 028
-- after backfill verification.

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

- [ ] **Step 2: Apply locally against the test DB**

Run (replace URL if your harness differs):

```bash
psql "$TEST_DATABASE_URL" -f applications/platform-rds-bootstrap/migrations/027_oauth_token_envelope.sql
```

Expected: `COMMIT` printed, exit 0.

- [ ] **Step 3: Write the repo implementation**

```ts
// applications/shared/src/rds/implementations/RdsOAuthConnectionsRepository.ts
/**
 * @format
 * RdsOAuthConnectionsRepository — IOAuthConnectionsRepository backed by RDS.
 *
 * Owns all reads/writes of oauth_connections. Encryption happens here so
 * callers never see ciphertext and can never accidentally skip encryption.
 * Encryption context is bound to `{ user_id, provider }` so a row's DEK
 * cannot be replayed against a different row's ciphertext.
 *
 * Transition window (between migrations 027 and 028): reads prefer
 * envelope columns; if absent, fall back to plaintext access_token_enc.
 * Writes only populate envelope columns. Remove fallback after 028.
 */

import { Pool } from 'pg';
import type {
    IOAuthConnectionsRepository,
    NewOAuthConnection,
    OAuthConnection,
} from '../interfaces/IOAuthConnectionsRepository.js';
import type { KmsEnvelope } from '../../crypto/index.js';

interface Row {
    id:                       string;
    user_id:                  string;
    provider:                 string;
    provider_user_id:         string;
    username:                 string;
    access_token_enc:         string | null;
    access_token_ciphertext:  Buffer | null;
    access_token_dek:         Buffer | null;
    access_token_iv:          Buffer | null;
    access_token_tag:         Buffer | null;
    scopes:                   string[] | null;
    installation_id:          string | null;
    connected_at:             Date;
    revoked_at:               Date | null;
    suspended_at:             Date | null;
}

export class RdsOAuthConnectionsRepository implements IOAuthConnectionsRepository {
    constructor(
        private readonly deps: {
            pool:     Pool;
            envelope: KmsEnvelope;
        },
    ) {}

    async upsert(c: NewOAuthConnection): Promise<OAuthConnection> {
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
    }

    async getByUserAndProvider(userId: string, provider: string): Promise<OAuthConnection | null> {
        const res = await this.deps.pool.query<Row>(
            `SELECT * FROM oauth_connections WHERE user_id = $1 AND provider = $2`,
            [userId, provider],
        );
        const row = res.rows[0];
        if (!row) return null;
        const plaintext = await this.decryptRow(row);
        return this.toModel(row, plaintext);
    }

    async getByInstallationId(installationId: string): Promise<OAuthConnection | null> {
        const res = await this.deps.pool.query<Row>(
            `SELECT * FROM oauth_connections WHERE installation_id = $1`,
            [installationId],
        );
        const row = res.rows[0];
        if (!row) return null;
        const plaintext = await this.decryptRow(row);
        return this.toModel(row, plaintext);
    }

    async markRevoked(id: string, at: Date): Promise<void> {
        await this.deps.pool.query(
            `UPDATE oauth_connections SET revoked_at = $2 WHERE id = $1`,
            [id, at],
        );
    }

    async markSuspended(id: string, at: Date): Promise<void> {
        await this.deps.pool.query(
            `UPDATE oauth_connections SET suspended_at = $2 WHERE id = $1`,
            [id, at],
        );
    }

    // Transition-window dual-read: prefer envelope columns, fall back to
    // plaintext. Remove the fallback branch after migration 028.
    private async decryptRow(row: Row): Promise<string> {
        if (
            row.access_token_ciphertext &&
            row.access_token_dek &&
            row.access_token_iv &&
            row.access_token_tag
        ) {
            return this.deps.envelope.decrypt(
                {
                    ciphertext: row.access_token_ciphertext,
                    dek:        row.access_token_dek,
                    iv:         row.access_token_iv,
                    tag:        row.access_token_tag,
                },
                { user_id: row.user_id, provider: row.provider },
            );
        }
        if (row.access_token_enc != null) return row.access_token_enc; // TODO remove after 028
        throw new Error(`oauth_connections row ${row.id} has no token material`);
    }

    private toModel(row: Row, plaintext: string): OAuthConnection {
        return {
            id:             row.id,
            userId:         row.user_id,
            provider:       row.provider,
            providerUserId: row.provider_user_id,
            username:       row.username,
            accessToken:    plaintext,
            scopes:         row.scopes ?? [],
            installationId: row.installation_id,
            connectedAt:    row.connected_at,
            revokedAt:      row.revoked_at,
            suspendedAt:    row.suspended_at,
        };
    }
}
```

- [ ] **Step 4: Re-export from `rds/index.ts`**

Append to `applications/shared/src/rds/index.ts`:

```ts
export { RdsOAuthConnectionsRepository } from './implementations/RdsOAuthConnectionsRepository.js';
export * from './interfaces/IOAuthConnectionsRepository.js';
```

- [ ] **Step 5: Run the failing test**

Run: `yarn workspace @bedrock/shared jest src/rds/implementations/RdsOAuthConnectionsRepository.test.ts -t "returns plaintext"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add applications/platform-rds-bootstrap/migrations/027_oauth_token_envelope.sql \
        applications/shared/src/rds/implementations/RdsOAuthConnectionsRepository.ts \
        applications/shared/src/rds/index.ts
git commit -m "feat(rds): RdsOAuthConnectionsRepository + migration 027"
```

---

## Task 8: Repo — additional behaviour tests

**Files:**
- Modify: `applications/shared/src/rds/implementations/RdsOAuthConnectionsRepository.test.ts`

- [ ] **Step 1: Append the additional tests**

```ts
test('upsert writes 4 non-null bytea columns and leaves access_token_enc null', async () => {
    const repo = new RdsOAuthConnectionsRepository({ pool, envelope: fakeEnvelope() });
    await repo.upsert({
        userId:         '00000000-0000-0000-0000-000000000001',
        provider:       'github',
        providerUserId: '42',
        username:       'octocat',
        accessToken:    'tok',
        scopes:         [],
        installationId: null,
    });

    const r = await pool.query(
        `SELECT access_token_enc, access_token_ciphertext, access_token_dek,
                access_token_iv, access_token_tag
         FROM oauth_connections LIMIT 1`,
    );
    const row = r.rows[0];
    expect(row.access_token_enc).toBeNull();
    expect(row.access_token_ciphertext).not.toBeNull();
    expect(row.access_token_dek).not.toBeNull();
    expect(row.access_token_iv).not.toBeNull();
    expect(row.access_token_tag).not.toBeNull();
});

test('getByInstallationId returns row and decrypted token', async () => {
    const repo = new RdsOAuthConnectionsRepository({ pool, envelope: fakeEnvelope() });
    await repo.upsert({
        userId:         '00000000-0000-0000-0000-000000000001',
        provider:       'github',
        providerUserId: '42',
        username:       'octocat',
        accessToken:    'tok',
        scopes:         [],
        installationId: 'inst-42',
    });

    const got = await repo.getByInstallationId('inst-42');
    expect(got?.accessToken).toBe('tok');
});

test('getByInstallationId returns null when no match', async () => {
    const repo = new RdsOAuthConnectionsRepository({ pool, envelope: fakeEnvelope() });
    expect(await repo.getByInstallationId('missing')).toBeNull();
});

test('markRevoked / markSuspended set timestamps', async () => {
    const repo = new RdsOAuthConnectionsRepository({ pool, envelope: fakeEnvelope() });
    const c = await repo.upsert({
        userId:         '00000000-0000-0000-0000-000000000001',
        provider:       'github',
        providerUserId: '42',
        username:       'octocat',
        accessToken:    'tok',
        scopes:         [],
        installationId: 'inst-1',
    });

    const t = new Date('2026-01-02T03:04:05Z');
    await repo.markRevoked(c.id, t);
    await repo.markSuspended(c.id, t);
    const got = await repo.getByInstallationId('inst-1');
    expect(got?.revokedAt?.toISOString()).toBe(t.toISOString());
    expect(got?.suspendedAt?.toISOString()).toBe(t.toISOString());
});

test('dual-read: falls back to plaintext access_token_enc when envelope columns null', async () => {
    // Simulate a pre-backfill row.
    await pool.query(
        `INSERT INTO oauth_connections
           (user_id, provider, provider_user_id, username, access_token_enc, installation_id)
         VALUES ($1,'github','1','legacy-user','plaintext-token','legacy-1')`,
        ['00000000-0000-0000-0000-000000000001'],
    );

    const repo = new RdsOAuthConnectionsRepository({ pool, envelope: fakeEnvelope() });
    const got = await repo.getByInstallationId('legacy-1');
    expect(got?.accessToken).toBe('plaintext-token');
});
```

- [ ] **Step 2: Run all repo tests**

Run: `yarn workspace @bedrock/shared jest src/rds/implementations/RdsOAuthConnectionsRepository.test.ts`
Expected: 5 PASS.

- [ ] **Step 3: Commit**

```bash
git add applications/shared/src/rds/implementations/RdsOAuthConnectionsRepository.test.ts
git commit -m "test(rds): upsert column shape, lookup, revocation, dual-read coverage"
```

---

## Task 9: Backfill script — failing test

**Files:**
- Create: `scripts/backfill-oauth-token-envelope.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// scripts/backfill-oauth-token-envelope.test.ts
import { Pool } from 'pg';
import type { KmsEnvelope } from '../applications/shared/src/crypto/index.js';
import { runBackfill } from './backfill-oauth-token-envelope.js';

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

const fakeEnvelope: KmsEnvelope = {
    async encrypt(plaintext) {
        return {
            ciphertext: Buffer.from(`enc(${plaintext})`),
            dek:        Buffer.from('dek'),
            iv:         Buffer.alloc(12, 1),
            tag:        Buffer.alloc(16, 2),
        };
    },
    async decrypt(p) {
        return p.ciphertext.toString('utf8').replace(/^enc\((.*)\)$/, '$1');
    },
};

beforeEach(async () => {
    await pool.query('TRUNCATE oauth_connections, users CASCADE');
    await pool.query(
        `INSERT INTO users (id, email) VALUES ('00000000-0000-0000-0000-000000000001','a@b.c')`,
    );
});

afterAll(() => pool.end());

test('backfills plaintext rows and is idempotent', async () => {
    for (let i = 0; i < 3; i++) {
        await pool.query(
            `INSERT INTO oauth_connections
               (user_id, provider, provider_user_id, username, access_token_enc)
             VALUES ($1, $2, $3, 'u', $4)`,
            ['00000000-0000-0000-0000-000000000001', `prov-${i}`, String(i), `tok-${i}`],
        );
    }

    const result = await runBackfill({ pool, envelope: fakeEnvelope, batchSize: 2 });
    expect(result.encrypted).toBe(3);

    const remaining = await pool.query(
        `SELECT COUNT(*)::int AS n FROM oauth_connections
         WHERE access_token_enc IS NOT NULL AND access_token_ciphertext IS NULL`,
    );
    expect(remaining.rows[0].n).toBe(0);

    const ct = await pool.query(`SELECT access_token_ciphertext FROM oauth_connections ORDER BY provider`);
    expect(ct.rows[0].access_token_ciphertext.toString('utf8')).toBe('enc(tok-0)');

    // Re-run → no-op.
    const second = await runBackfill({ pool, envelope: fakeEnvelope, batchSize: 2 });
    expect(second.encrypted).toBe(0);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `yarn jest scripts/backfill-oauth-token-envelope.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Commit failing test**

```bash
git add scripts/backfill-oauth-token-envelope.test.ts
git commit -m "test(scripts): failing backfill test"
```

---

## Task 10: Backfill script implementation

**Files:**
- Create: `scripts/backfill-oauth-token-envelope.ts`

- [ ] **Step 1: Write the script**

```ts
// scripts/backfill-oauth-token-envelope.ts
/**
 * One-shot backfill: encrypts plaintext access_token_enc rows into the
 * envelope columns added by migration 027. Idempotent (WHERE-guard) and
 * batched. Re-runnable; halts non-zero on first row error.
 *
 * Usage:
 *   TEST_DATABASE_URL=... yarn ts-node scripts/backfill-oauth-token-envelope.ts
 *   (or pass DATABASE_URL for the target env)
 */

import { Pool } from 'pg';
import { KMSClient } from '@aws-sdk/client-kms';
import {
    createKmsEnvelope,
    type KmsEnvelope,
} from '../applications/shared/src/crypto/index.js';

export interface BackfillResult {
    encrypted: number;
    batches:   number;
}

export async function runBackfill(opts: {
    pool:      Pool;
    envelope:  KmsEnvelope;
    batchSize: number;
}): Promise<BackfillResult> {
    const { pool, envelope, batchSize } = opts;
    let encrypted = 0;
    let batches = 0;

    while (true) {
        const sel = await pool.query<{
            id:               string;
            user_id:          string;
            provider:         string;
            access_token_enc: string;
        }>(
            `SELECT id, user_id, provider, access_token_enc
             FROM oauth_connections
             WHERE access_token_ciphertext IS NULL
               AND access_token_enc IS NOT NULL
             ORDER BY id
             LIMIT $1`,
            [batchSize],
        );

        if (sel.rows.length === 0) break;
        batches++;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const r of sel.rows) {
                const p = await envelope.encrypt(r.access_token_enc, {
                    user_id:  r.user_id,
                    provider: r.provider,
                });
                await client.query(
                    `UPDATE oauth_connections SET
                        access_token_ciphertext = $2,
                        access_token_dek        = $3,
                        access_token_iv         = $4,
                        access_token_tag        = $5
                     WHERE id = $1
                       AND access_token_ciphertext IS NULL`,
                    [r.id, p.ciphertext, p.dek, p.iv, p.tag],
                );
                encrypted++;
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    return { encrypted, batches };
}

// CLI entrypoint
if (require.main === module) {
    void (async () => {
        const url = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
        if (!url) {
            console.error('DATABASE_URL or TEST_DATABASE_URL required');
            process.exit(2);
        }
        const keyId = process.env.OAUTH_TOKEN_KMS_KEY_ARN;
        if (!keyId) {
            console.error('OAUTH_TOKEN_KMS_KEY_ARN required');
            process.exit(2);
        }
        const pool = new Pool({ connectionString: url });
        const envelope = createKmsEnvelope({
            kmsClient: new KMSClient({}),
            keyId,
        });
        try {
            const r = await runBackfill({ pool, envelope, batchSize: 100 });
            console.log(`backfill complete: ${r.encrypted} rows in ${r.batches} batches`);
        } finally {
            await pool.end();
        }
    })().catch((err) => {
        console.error('backfill failed:', err);
        process.exit(1);
    });
}
```

- [ ] **Step 2: Run the test, verify PASS**

Run: `yarn jest scripts/backfill-oauth-token-envelope.test.ts`
Expected: 1 PASS (covers idempotency + correctness).

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-oauth-token-envelope.ts
git commit -m "feat(scripts): re-runnable backfill for oauth token envelope"
```

---

## Task 11: Migration 028 (committed, applied later)

**Files:**
- Create: `applications/platform-rds-bootstrap/migrations/028_oauth_token_drop_plain.sql`

This migration is committed now but applied only after ≥48h prod soak and a verified `count = 0`. Apply order is documented in the spec.

- [ ] **Step 1: Write migration 028**

```sql
-- applications/platform-rds-bootstrap/migrations/028_oauth_token_drop_plain.sql
-- Enforces NOT NULL on envelope columns, adds length checks, and drops the
-- plaintext access_token_enc column. Apply ONLY after:
--   1. Migration 027 applied in target env.
--   2. backfill-oauth-token-envelope.ts run to completion.
--   3. Verification:
--        SELECT COUNT(*) FROM oauth_connections
--        WHERE access_token_enc IS NOT NULL
--          AND access_token_ciphertext IS NULL;
--      -- must be 0
--   4. Manual RDS snapshot taken (rollback path).

BEGIN;

ALTER TABLE oauth_connections
    ALTER COLUMN access_token_ciphertext SET NOT NULL,
    ALTER COLUMN access_token_dek        SET NOT NULL,
    ALTER COLUMN access_token_iv         SET NOT NULL,
    ALTER COLUMN access_token_tag        SET NOT NULL;

ALTER TABLE oauth_connections
    ADD CONSTRAINT oauth_iv_length  CHECK (octet_length(access_token_iv)  = 12),
    ADD CONSTRAINT oauth_tag_length CHECK (octet_length(access_token_tag) = 16);

ALTER TABLE oauth_connections DROP COLUMN access_token_enc;

COMMIT;
```

- [ ] **Step 2: Lint via DSQL helper if applicable, else psql --dry-run**

If using Aurora DSQL pattern from other migrations, run the project's standard lint. Otherwise visually verify syntax with:

```bash
psql --version  # sanity
cat applications/platform-rds-bootstrap/migrations/028_oauth_token_drop_plain.sql
```

- [ ] **Step 3: Commit (do NOT apply yet)**

```bash
git add applications/platform-rds-bootstrap/migrations/028_oauth_token_drop_plain.sql
git commit -m "feat(migrations): 028 drop plaintext access_token_enc (apply post-backfill)"
```

---

## Task 12: CDK — provision dedicated CMK + grants

**Files:**
- Modify: `infra/lib/stacks/bedrock/api-stack.ts`

- [ ] **Step 1: Inspect the existing stack to find the public-api Lambda role**

Run: `grep -n "Function\|Role\|publicApi\|grantInvoke" infra/lib/stacks/bedrock/api-stack.ts | head -40`

Identify: (a) the `lambda.Function` for public-api (or its role construct), (b) imports section.

- [ ] **Step 2: Add imports if missing**

Ensure the file imports:

```ts
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
```

- [ ] **Step 3: Add the CMK and grants**

Insert after the public-api Lambda is constructed (use the actual variable name from your stack — e.g. `publicApiFn`):

```ts
const oauthTokenKey = new kms.Key(this, 'OAuthTokenKey', {
    alias: 'alias/oauth-token-encryption',
    description: 'Envelope encryption for oauth_connections.access_token',
    enableKeyRotation: true,
    removalPolicy: RemovalPolicy.RETAIN,
    pendingWindow: Duration.days(30),
});

oauthTokenKey.grantEncryptDecrypt(publicApiFn.grantPrincipal);

new ssm.StringParameter(this, 'OAuthTokenKeyArnParam', {
    parameterName: '/oauth/token-encryption-key-arn',
    stringValue: oauthTokenKey.keyArn,
});

publicApiFn.addEnvironment('OAUTH_TOKEN_KMS_KEY_ARN', oauthTokenKey.keyArn);
```

- [ ] **Step 4: Synth to verify**

Run: `yarn workspace @bedrock/infra cdk synth` (or whichever package owns CDK).
Expected: synth succeeds; output contains `OAuthTokenKey` and a KMS::Key resource. Diff with `cdk diff` should show the new key + grant statement on the Lambda role + the SSM param.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/stacks/bedrock/api-stack.ts
git commit -m "feat(infra): dedicated CMK for oauth token envelope encryption"
```

---

## Task 13: App boot wiring — construct envelope at startup

**Files:**
- Modify: the public-api boot file that owns DB pool / dependency wiring (likely `api/public-api/src/index.ts` or `lambda.ts` — confirm with `grep -rn "new Pool\|RdsSyncStateRepository" api/public-api/src/`)

- [ ] **Step 1: Locate the boot site**

Run: `grep -rn "new Pool\|RdsSyncStateRepository\|createKmsEnvelope" api/public-api/src/`

Pick the file where existing DB-backed repos are constructed. Construct the envelope alongside them.

- [ ] **Step 2: Add envelope construction**

In the boot site (replace `<file>` with the located path), add near other repo construction:

```ts
import { KMSClient } from '@aws-sdk/client-kms';
import {
    createKmsEnvelope,
    RdsOAuthConnectionsRepository,
} from '@bedrock/shared';

const keyArn = process.env.OAUTH_TOKEN_KMS_KEY_ARN;
if (!keyArn) throw new Error('OAUTH_TOKEN_KMS_KEY_ARN env var required');

const envelope = createKmsEnvelope({
    kmsClient: new KMSClient({}),
    keyId: keyArn,
});

const oauthRepo = new RdsOAuthConnectionsRepository({
    pool,        // existing Pool
    envelope,
});
```

If no existing OAuth callback route consumes `oauthRepo` yet, that's fine — it's wired but inert until PR-2/PR-3. Export `oauthRepo` from whatever DI container/object the codebase uses, matching the pattern of `RdsSyncStateRepository`.

- [ ] **Step 3: Typecheck + build**

Run: `yarn workspace @bedrock/shared build && yarn workspace <api-public-api-package> typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add api/public-api/src/<file>
git commit -m "feat(api): wire OAuthConnectionsRepository with KMS envelope"
```

---

## Task 14: End-to-end verification + apply 027 in dev

**Files:** none (operational).

- [ ] **Step 1: Run the full shared test suite**

Run: `yarn workspace @bedrock/shared test`
Expected: all green, including the new crypto and repo tests.

- [ ] **Step 2: Apply migration 027 in dev**

```bash
psql "$DEV_DATABASE_URL" -f applications/platform-rds-bootstrap/migrations/027_oauth_token_envelope.sql
```

Expected: COMMIT, no error.

- [ ] **Step 3: Run backfill in dev**

```bash
DATABASE_URL="$DEV_DATABASE_URL" \
OAUTH_TOKEN_KMS_KEY_ARN="$(aws ssm get-parameter --name /oauth/token-encryption-key-arn --query Parameter.Value --output text)" \
yarn ts-node scripts/backfill-oauth-token-envelope.ts
```

Expected: `backfill complete: N rows in M batches`.

- [ ] **Step 4: Verify count = 0**

```bash
psql "$DEV_DATABASE_URL" -c "SELECT COUNT(*) FROM oauth_connections WHERE access_token_enc IS NOT NULL AND access_token_ciphertext IS NULL;"
```

Expected: `0`.

- [ ] **Step 5: Smoke check a decrypt**

Pick one row, sanity-check it decrypts:

```bash
DATABASE_URL="$DEV_DATABASE_URL" OAUTH_TOKEN_KMS_KEY_ARN=... \
yarn ts-node -e "
  (async () => {
    const { Pool } = require('pg');
    const { KMSClient } = require('@aws-sdk/client-kms');
    const { createKmsEnvelope, RdsOAuthConnectionsRepository } = require('@bedrock/shared');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const repo = new RdsOAuthConnectionsRepository({
      pool, envelope: createKmsEnvelope({ kmsClient: new KMSClient({}), keyId: process.env.OAUTH_TOKEN_KMS_KEY_ARN }),
    });
    const r = await pool.query('SELECT id, user_id, provider FROM oauth_connections LIMIT 1');
    if (r.rows[0]) {
      const c = await repo.getByUserAndProvider(r.rows[0].user_id, r.rows[0].provider);
      console.log('decrypted token length:', c.accessToken.length);
    }
    await pool.end();
  })();
"
```

Expected: prints a positive token length — confirms end-to-end KMS path.

- [ ] **Step 6: Promote to staging then prod**

Repeat Steps 2–5 against staging URL, then prod URL. Defer migration 028 by ≥48h after prod backfill — that gates PR-1b.

---

## Out of this plan (tracked elsewhere)

- PR-1b: apply migration 028, remove dual-read fallback in `RdsOAuthConnectionsRepository.decryptRow`.
- PR-2: GitHub webhook handler + outbound `DELETE /app/installations/{id}`. Consumes `markRevoked`, `markSuspended`, `getByInstallationId` from this plan.
- PR-3: ingestion PAT → installation token migration.
- Ops: verify RDS `StorageEncrypted` flag; add CloudTrail alarm on `DisableKey` / `ScheduleKeyDeletion`; ESLint rule + `redact()` helper to prevent whole-`OAuthConnection` logging.
