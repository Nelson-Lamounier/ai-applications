---
title: KMS envelope encryption for OAuth tokens
type: decision
tags: [security, oauth, github, kms, encryption, rls, postgres]
sources:
  - applications/platform-rds-bootstrap/migrations/029_oauth_token_envelope.sql
  - api/public-api/src/lib/oauth.ts
  - api/public-api/src/routes/github-webhook.ts
created: 2026-06-16
updated: 2026-06-16
---

## Status

Accepted — implemented as-deployed. OAuth tokens are stored in
`oauth_connections` as AES-256-GCM ciphertext with a KMS-wrapped per-row data
encryption key
([029_oauth_token_envelope.sql:9-15](../../applications/platform-rds-bootstrap/migrations/029_oauth_token_envelope.sql#L9-L15)).

## Context

Connecting a GitHub account yields an access/installation token that the
ingestion pipeline needs later to fetch the user's repositories. Storing that
token in plaintext in Postgres would mean a single DB read (backup, dump, or RLS
miss) leaks live GitHub credentials for every user. The platform already runs KMS
for other secrets and resolves AWS credentials from the EC2 node instance profile
([oauth.ts:8-11](../../api/public-api/src/lib/oauth.ts#L8-L11)), so a KMS-backed
scheme was available without new infrastructure.

## Decision

Store OAuth tokens with **KMS envelope encryption** — a per-row data encryption
key (DEK), itself wrapped by a KMS customer master key. Migration 029 adds four
ciphertext columns plus revocation timestamps to `oauth_connections`
([029_oauth_token_envelope.sql:9-15](../../applications/platform-rds-bootstrap/migrations/029_oauth_token_envelope.sql#L9-L15)):

- `access_token_ciphertext BYTEA` — the AES-256-GCM ciphertext
- `access_token_dek BYTEA` — the KMS-encrypted data encryption key
- `access_token_iv BYTEA` — the 12-byte random IV
- `access_token_tag BYTEA` — the GCM authentication tag
- `revoked_at` / `suspended_at TIMESTAMPTZ` — webhook-driven lifecycle

The envelope is a lazy module-scope singleton: `getKmsEnvelope(config)` constructs
one `KMSClient` and a `KmsEnvelope` on first use; routes read/write tokens via
`getOAuthConnectionsRepo()`
([oauth.ts:14-30](../../api/public-api/src/lib/oauth.ts#L14-L30)). The GitHub
webhook flips `revoked_at` / `suspended_at` on `installation.deleted` /
`installation.suspended`
([github-webhook.ts](../../api/public-api/src/routes/github-webhook.ts)).

## Consequences

**Enabled:**

- A DB read alone never yields a usable token — decryption requires a KMS
  `Decrypt` call on the per-row DEK, which is IAM-gated to the node role.
- Per-row DEKs limit blast radius: compromising one row's DEK does not decrypt
  others.
- Token lifecycle is explicit — revocation/suspension are first-class columns the
  webhook sets, so the pipeline can fail closed on a revoked connection.

**Prevented:**

- Plaintext credential leakage via backups, dumps, or an RLS slip.
- A single static key for all tokens (the envelope CMK wraps per-row DEKs, not the
  tokens directly).

**New problems / accepted residual:**

- Every token read costs a KMS `Decrypt` call — a small latency + cost per
  ingestion dispatch, mitigated by the singleton client and the fact that reads
  are infrequent (per sync, not per request).
- Operational dependency on KMS availability and correct IAM on the node role;
  the default credential chain resolving via the EC2 node instance profile is part
  of the trust model.

## Alternatives considered

### Plaintext column

The original `oauth_connections.access_token_enc` (now deprecated by the envelope
columns). Rejected — a DB read leaks live credentials.

### Single application-level symmetric key

One key in Secrets Manager encrypting all tokens. Rejected — no per-row blast-radius
limit, and key rotation re-encrypts every row. The envelope scheme rotates the CMK
without touching ciphertext (only the wrapped DEKs).

<!--
Evidence trail (auto-generated):
- Source: applications/platform-rds-bootstrap/migrations/029_oauth_token_envelope.sql (read on 2026-06-16, lines 1-15)
- Source: api/public-api/src/lib/oauth.ts (read on 2026-06-16, lines 1-30)
- Source: api/public-api/src/routes/github-webhook.ts (read on 2026-06-16)
-->
