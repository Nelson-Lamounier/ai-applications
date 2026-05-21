# GitHub Webhook + App JWT (PR-2b of 3)

**Date:** 2026-05-21
**Status:** Design, pending implementation
**Author:** Nelson Lamounier

## Context

PR-1 ([2026-05-20-oauth-token-envelope-encryption-design.md](2026-05-20-oauth-token-envelope-encryption-design.md))
landed envelope encryption for `oauth_connections.access_token` with
`markRevoked` / `markSuspended` / `getByInstallationId` methods already
on the repo.

PR-2a ([2026-05-20-oauth-app-revocation-foundation-design.md](2026-05-20-oauth-app-revocation-foundation-design.md))
provisioned the KMS CMK and wired lazy `getKmsEnvelope` /
`getOAuthConnectionsRepo` accessors into the public-api boot path. The
repo is instrumented with structured logs + an
`OAuthTokenDecryptFailures` EMF metric.

PR-2b — this spec — adds the first consumer: an inbound webhook handler
that listens for `installation.deleted` / `installation.suspended`
events from GitHub and calls `markRevoked` / `markSuspended` so the DB
reflects user-driven uninstalls performed outside our UI. The PR also
introduces a pure GitHub App JWT signing helper in
`@bedrock/shared/github/appJwt.ts`. The JWT helper is not used by PR-2b
itself (webhook auth uses HMAC, not JWT) but is shipped here so PR-2c
can use it without growing in scope.

## Goals

- Pure RS256 JWT signer for GitHub App authentication, reusable by
  PR-2c's outbound revoke flow.
- Pure HMAC-SHA256 webhook signature verifier with timing-safe compare.
- Secrets Manager fetcher that returns `{appId, privateKeyPem, webhookSecret}`
  from a single JSON secret, TTL-cached, shape-validated.
- `POST /webhooks/github` route mounted at `/webhooks/github` that
  verifies signatures, branches on `installation.deleted` /
  `installation.suspended`, and writes via
  `getOAuthConnectionsRepo`.
- Structured logs (`github.webhook.*`) covering every branch of the
  handler so a single GitHub delivery can be traced via
  `X-GitHub-Delivery` UUID.

## Non-Goals

- Installation-token exchange (App JWT → installation token via
  `POST /app/installations/{id}/access_tokens`). Tracked for PR-3.
- Outbound `DELETE /app/installations/{id}` on user soft-delete (PR-2c).
- Webhook delivery dedup table — PR-2a's repo writes are idempotent at
  the SQL layer (UPDATE by id with same timestamp).
- `UNIQUE` constraint on `oauth_connections.installation_id`. Tracked
  for a future migration once PR-2c writes installation_id consistently.
- New EMF metrics. Log-driven for now; revisit if delivery error rate
  becomes interesting.

## Architecture

```
applications/shared/src/github/                                       NEW
  appJwt.ts             pure RS256 JWT signer + GitHubAppJwtError
  appJwt.test.ts
  webhookSignature.ts   pure HMAC verifier
  webhookSignature.test.ts
  index.ts              barrel

applications/shared/src/index.ts                                      MODIFY
  + re-export github/* for public-api consumers

api/public-api/src/lib/githubAppSecrets.ts                            NEW
  getGitHubAppSecrets(config): Promise<GitHubAppSecrets>
  __resetGitHubAppSecretsCacheForTests()
  TTL-cached; mirrors lib/chatbot.ts:getApiKey pattern

api/public-api/__tests__/lib/githubAppSecrets.test.ts                 NEW

api/public-api/src/lib/config.ts                                      MODIFY
  + readonly githubAppSecretArn: string  (GITHUB_APP_SECRET_ARN env)

api/public-api/__tests__/lib/config.test.ts                           MODIFY
  + tests asserting GITHUB_APP_SECRET_ARN is required

api/public-api/src/routes/github-webhook.ts                           NEW
  POST /  (mounted under /webhooks/github by index.ts)
  Hono route — orchestration only; logic lives in the helpers above.

api/public-api/__tests__/routes/github-webhook.test.ts                NEW

api/public-api/src/index.ts                                           MODIFY
  + app.route('/webhooks/github', githubWebhook)
```

### Boundaries

- **`appJwt.ts`** — pure. Inputs `{appId, privateKeyPem, ttlSeconds?, now?}`.
  Output: signed JWT string. No HTTP, no AWS, no GitHub-API knowledge.
- **`webhookSignature.ts`** — pure. Inputs `(rawBody: Buffer, headerValue, secret)`.
  Output: `boolean`. No throwing on malformed network input.
- **`githubAppSecrets.ts`** — Secrets Manager fetcher with TTL cache
  and shape validation. Caller passes the resolved `Config`.
- **`github-webhook.ts`** — thin orchestration. Verify → JSON.parse →
  switch → call repo. Under ~80 LOC; every branch has a corresponding
  log line.

### Request flow

```
GitHub → POST /webhooks/github
  headers: X-Hub-Signature-256, X-GitHub-Event, X-GitHub-Delivery
  body:    { action: "deleted"|"suspended", installation: { id }, … }

Handler:
  1. raw     = Buffer.from(await c.req.arrayBuffer())
  2. secrets = await getGitHubAppSecrets(cfg)              # TTL-cached
  3. verifyWebhookSignature(raw, sig, secrets.webhookSecret) || 401
  4. event = X-GitHub-Event; if != 'installation' → 204 (ignored)
  5. payload = JSON.parse(raw.toString('utf8'))            # bad-JSON → 400
  6. installationId = String(payload.installation?.id)
     missing → 400
  7. action = payload.action
     if not in {deleted, suspended} → 204 (ignored)
  8. row = await repo.getByInstallationId(installationId)
     no row → 200 {status: 'no_match'}
  9. action === 'deleted'    → repo.markRevoked(row.id, new Date())
     action === 'suspended'  → repo.markSuspended(row.id, new Date())
  10. log 'github.webhook.processed' → 200 {status: 'ok'}
```

## App JWT helper

### Interface

```ts
export interface AppJwtOptions {
    appId:         string | number;
    privateKeyPem: string;          // PEM-encoded RSA private key
    ttlSeconds?:   number;          // default 540 (9 min)
    now?:          () => number;    // test seam — returns Date.now()-style ms
}

export function signGitHubAppJwt(opts: AppJwtOptions): string;

export class GitHubAppJwtError extends Error {
    constructor(msg: string, options?: { cause?: unknown });
}
```

### Algorithm

```ts
const header  = { alg: 'RS256', typ: 'JWT' };
const now     = Math.floor((opts.now?.() ?? Date.now()) / 1000);
const payload = {
    iat: now - 60,                              // 60s clock-skew slack — GitHub recommendation
    exp: now + (opts.ttlSeconds ?? 540),
    iss: String(opts.appId),
};
const h = base64url(JSON.stringify(header));
const p = base64url(JSON.stringify(payload));
const data = `${h}.${p}`;
const sig = crypto.createSign('RSA-SHA256')
    .update(data)
    .sign({ key: opts.privateKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING });
return `${data}.${base64url(sig)}`;
```

`base64url(buf|str)` strips `=` padding and substitutes `+`/`/` with
`-`/`_`. Inline helper, no library.

### Errors

Crypto failures wrap as `GitHubAppJwtError` with `cause` preserved.

### Tests (5)

1. **Roundtrip** — sign with injected `now`, decode header+payload,
   verify `alg=RS256`, `typ=JWT`, `iss=<appId>`, `iat=now-60`,
   `exp=now+540`.
2. **Custom TTL** — `ttlSeconds: 300` → `exp - iat === 360`.
3. **Default TTL** — omitted → `exp - iat === 600`.
4. **Signature verifies** — `crypto.createVerify('RSA-SHA256').verify(publicKey, sig)`
   returns true (proves algorithm + padding consistency).
5. **Malformed private key** — `'not-a-pem'` → throws
   `GitHubAppJwtError` with `cause`.

Tests generate an ephemeral RSA keypair at suite start; no fixture
management.

## Webhook signature verifier

### Interface

```ts
export function verifyWebhookSignature(
    rawBody:    Buffer,
    headerValue: string | undefined | null,
    secret:     string,
): boolean;
```

### Algorithm

```ts
if (!headerValue || !headerValue.startsWith('sha256=')) return false;
const expected = Buffer.from(headerValue.slice('sha256='.length), 'hex');
const actual   = crypto.createHmac('sha256', secret).update(rawBody).digest();
if (expected.length !== actual.length) return false;       // length-guard before timingSafeEqual
return crypto.timingSafeEqual(expected, actual);
```

### Tests (9)

1. Valid signature → true.
2. Tampered body byte → false.
3. Tampered signature byte → false.
4. Wrong secret → false.
5. Missing header (`undefined`) → false.
6. Empty string header → false.
7. Header without `sha256=` prefix (e.g. `sha1=…`) → false.
8. Header with non-hex characters → false.
9. Truncated header (length mismatch with 32-byte HMAC) → false
   (confirms `timingSafeEqual` never throws).

## Secrets Manager fetcher

### Interface

```ts
export interface GitHubAppSecrets {
    readonly appId:          string;
    readonly privateKeyPem:  string;
    readonly webhookSecret:  string;
}

export async function getGitHubAppSecrets(config: Config): Promise<GitHubAppSecrets>;
export function __resetGitHubAppSecretsCacheForTests(): void;
```

### Implementation

- Module-scope `SecretsManagerClient({})`; credentials via EC2 node
  instance profile (matches `chatbot.ts`).
- TTL: 10 min.
- Cache layout: `{ value, expiresAt }` at module scope.
- `parseAndValidate`:
  - Reject non-JSON / non-object input with descriptive error.
  - Accept `appId` as string or number; coerce to string.
  - Require `privateKeyPem` and `webhookSecret` as non-empty strings.
  - Return `Object.freeze`d shape.
- Validation throws inside the fetcher so misconfiguration surfaces as
  "500 secret misconfigured" with a clear log, not "401 signature
  mismatch" downstream.

### Config addition

```ts
/** Secrets Manager ARN for the GitHub App JSON secret
 *  (`{appId, privateKeyPem, webhookSecret}`).
 *  Sourced from GITHUB_APP_SECRET_ARN env var (ConfigMap). */
readonly githubAppSecretArn: string;
```

Added to the `required` tuple in `loadConfig()`.

### Tests (8)

1. Happy path: mock returns valid JSON → frozen object with three fields.
2. TTL cache: two calls within TTL → only one `GetSecretValueCommand` sent.
3. TTL expiry: advance `Date.now`, second call re-fetches.
4. Missing `SecretString` → throws "has no value".
5. Invalid JSON → throws "is not valid JSON".
6. JSON missing a field → throws "missing one of: appId, privateKeyPem, webhookSecret".
7. `appId` as number → coerced to string, no throw.
8. `__resetGitHubAppSecretsCacheForTests` → post-reset call re-fetches.

## Webhook route handler

### Route file

`api/public-api/src/routes/github-webhook.ts` exports a Hono sub-app
mounted at `/webhooks/github` from `index.ts`. The sub-app handles
`POST /` (path relative to the mount).

```ts
const app = new Hono();

app.post('/', async (c) => {
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
    try { payload = JSON.parse(rawBody.toString('utf8')); }
    catch {
        log('WARN', 'github.webhook.bad_json', { deliveryId, event });
        return c.json({ error: 'bad json' }, 400);
    }

    const action         = payload.action;
    const installationId = payload.installation?.id != null ? String(payload.installation.id) : undefined;
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
    if (action === 'deleted') await repo.markRevoked(row.id, at);
    else                      await repo.markSuspended(row.id, at);

    log('INFO', 'github.webhook.processed', {
        deliveryId, event, action,
        installationId, oauthConnectionId: row.id,
    });
    return c.json({ status: 'ok' }, 200);
});

export default app;
```

### Status-code contract

| Outcome | Status |
|---|---|
| Signature invalid or missing | 401 |
| Body not JSON | 400 |
| Missing `installation.id` for an `installation` event | 400 |
| Event type not `installation` | 204 (ignored) |
| Action not `deleted`/`suspended` | 204 (ignored) |
| `installation_id` not found in DB | 200 `{status: 'no_match'}` |
| Success | 200 `{status: 'ok'}` |
| Repo error (DB / KMS) | 500 — uncaught, Hono default; GitHub retries |

`no_match` returns 200 (not 404) so GitHub stops retrying. 4xx/5xx
trigger GitHub's exponential retry — wanted only for transient
infrastructure failures, not for "we don't know this installation."

### Mounting

`api/public-api/src/index.ts`:

```ts
import githubWebhook from './routes/github-webhook.js';
// ...
app.route('/webhooks/github', githubWebhook);
```

CORS is harmless on this path (GitHub doesn't send `Origin`); the
existing global middleware needs no changes.

### Tests (10)

Use Hono's `app.request()` to drive the route in-process. Sign test
payloads with the real `verifyWebhookSignature` algorithm so we test
end-to-end, not just mocks. Use the `__reset*ForTests` seams to inject
fake secrets + fake repo into the singletons.

1. Valid `installation.deleted` → 200 ok, `markRevoked` called with row id.
2. Valid `installation.suspended` → 200 ok, `markSuspended` called.
3. Valid `installation.created` → 204 ignored, no repo call.
4. Event `push` with valid signature → 204 ignored.
   (Important: signature is still validated for non-handled events; an
   attacker cannot dump arbitrary unsigned payloads at any event type.)
5. Bad signature → 401, no repo call.
6. Missing `X-Hub-Signature-256` → 401.
7. Body not JSON (signature valid over the raw bytes) → 400.
8. `installation.deleted` with missing `installation.id` → 400.
9. `installation.deleted` with unknown installation_id → 200 `no_match`,
   no repo write.
10. Repo `markRevoked` throws → handler propagates → Hono 500.

## Observability

Structured logs only — no EMF metrics in this PR. Every code path emits
exactly one of:

| Log message | Level | Context fields |
|---|---|---|
| `github.webhook.invalid_signature` | WARN  | deliveryId, event |
| `github.webhook.bad_json` | WARN  | deliveryId, event |
| `github.webhook.missing_installation_id` | WARN  | deliveryId, event, action |
| `github.webhook.ignored` | INFO  | deliveryId, event, action?, reason |
| `github.webhook.no_match` | INFO  | deliveryId, event, action, installationId |
| `github.webhook.processed` | INFO  | deliveryId, event, action, installationId, oauthConnectionId |

`deliveryId` (X-GitHub-Delivery UUID) is the join key from GitHub's
"Recent Deliveries" UI to our logs.

What is NEVER logged: webhook secret, App private key, signature
header values, full payload, plaintext access token. `installationId`
is fine — it's a public GitHub identifier.

## Risks

| Risk | Mitigation |
|---|---|
| Webhook secret leaks | Lives only in Secrets Manager; never logged; rotation supported. |
| Private key leaks | Same. GitHub also supports independent private-key regeneration. |
| Body-consuming middleware breaks HMAC | Only CORS + Hono `logger` are global today; neither reads the body. New middleware that consumes the body must mount AFTER `/webhooks/github` or use `c.req.raw.clone()`. Document inline. |
| GitHub retries on transient 5xx | UPDATE is fast and idempotent. GitHub backs off exponentially; nothing else to do. |
| Stale secret after rotation | 10-min TTL bounds the drift window. |
| Two rows share `installation_id` | Index returns one arbitrarily. Out of scope; tracked. |

## Rollback

- App: revert the PR. No DB migration, no infra change, no consumer
  outside GitHub's webhook delivery system.
- Operator: disable the webhook URL in GitHub App settings. The
  endpoint becomes inert.

## Operator runbook (after merging this PR)

1. Create a Secrets Manager secret containing JSON `{appId, privateKeyPem, webhookSecret}`.
   Record the ARN.
2. Update the public-api Helm ConfigMap to add `GITHUB_APP_SECRET_ARN`
   pointing at the ARN. Confirm the EKS node IAM role has
   `secretsmanager:GetSecretValue` on the ARN.
3. Roll the public-api pod. Boot now requires the env var; missing
   value fails fast at startup.
4. In the GitHub App settings: set webhook URL to
   `https://<public-api host>/webhooks/github`, paste the same
   `webhookSecret` value, subscribe to the "Installation" event.
5. Trigger a test webhook delivery from the GitHub UI. Verify a
   matching `github.webhook.processed` (or `no_match` if no real
   installation exists yet) log line.

## Verification before merge

- `yarn workspace @bedrock/shared run test src/github/ src/rds/ src/crypto/` — all green.
- `yarn workspace @repo/public-api run test __tests__/lib/ __tests__/routes/` — all green; 10 new webhook cases.
- `yarn workspace @bedrock/shared run typecheck` and `yarn workspace @repo/public-api run typecheck` — exit 0.

## Follow-up

- **PR-2c:** user soft-delete handler at the public-api layer with an
  outbound `DELETE /app/installations/{id}` call using
  `signGitHubAppJwt` from this PR.
- **PR-3:** ingestion `GitHubAdapter` migration to installation tokens.
- Future: webhook delivery dedup table if duplicate deliveries become a
  problem in practice; UNIQUE constraint on
  `oauth_connections.installation_id` once PR-2c writes it
  consistently.

## Out of scope

- Migration from EC2 instance profile to IRSA for public-api.
- CloudTrail / metric alarms on webhook signature failures (revisit if
  the WARN log volume grows).
