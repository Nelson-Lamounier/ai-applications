# Internal GitHub App Revoke Endpoint (PR-2c of 3)

**Date:** 2026-05-21
**Status:** Design, pending implementation
**Author:** Nelson Lamounier

## Context

PR-1, PR-2a, and PR-2b shipped envelope encryption for
`oauth_connections.access_token`, the KMS + boot foundation, the
inbound `POST /webhooks/github` route, and the
`@bedrock/shared/signGitHubAppJwt` helper. PR-2b's original "follow-up"
note framed PR-2c as **"user soft-delete handler + outbound
`DELETE /app/installations/{id}`"**.

The first scouting pass revealed:

- `public-api` (this repo) has **no authenticated routes** and **no
  auth middleware**.
- Account management — soft-delete, Cognito JWT extraction, and the
  authoritative write to `users.deleted_at` — lives in the **separate
  `tucaken-app` repository's admin-api**.
- `users.deleted_at` exists (migration 026) but nothing in this repo
  reads or writes it.

Trying to deliver the soft-delete endpoint here would mean duplicating
Cognito JWT auth that tucaken-app already owns. Out-of-scope.

PR-2c is therefore reframed: **public-api exposes an internal endpoint
that admin-api calls when a user soft-deletes**. The endpoint performs
the GitHub-side revoke and marks the row in `oauth_connections`.
Cross-repo coupling stays narrow (one HTTP call), and the boundary
matches each service's responsibility — tucaken-app owns user
lifecycle, this repo owns OAuth-connection material.

## Goals

- Pure `revokeInstallation` helper in `@bedrock/shared/github` that
  calls `DELETE /app/installations/{installationId}` with an injected
  App JWT, returns a discriminated union so the caller decides whether
  404 is a success or a failure.
- `POST /internal/revoke-github` route in public-api:
  - Authenticated via shared bearer token (timing-safe compare).
  - Body `{userId: string, reason?: string}`.
  - Looks up the GitHub `oauth_connections` row, signs an App JWT,
    calls `revokeInstallation`, marks the row revoked.
- Extend the existing GitHub App JSON secret with a new
  `internalApiToken` field. One Secrets Manager secret, one IAM grant,
  one cache.

## Non-Goals

- Building the user soft-delete handler / Cognito JWT verification in
  this repo — tucaken-app's admin-api keeps that responsibility.
- Multi-provider revoke (GitLab, Bitbucket). The route name is
  `/internal/revoke-github` by design.
- Async retry queue. Synchronous revoke; admin-api retries on 5xx.
- IRSA migration for public-api.
- `UNIQUE (installation_id)` constraint on `oauth_connections`.

## Architecture

```
applications/shared/src/github/                                       NEW
  revokeInstallation.ts            DELETE /app/installations/{id} client
  revokeInstallation.test.ts

applications/shared/src/github/index.ts                               MODIFY
  + export revokeInstallation, RevokeInstallationResult, RevokeInstallationOpts

applications/shared/src/index.ts                                      MODIFY
  + re-export revokeInstallation + types from github barrel

api/public-api/src/lib/githubAppSecrets.ts                            MODIFY
  GitHubAppSecrets now has internalApiToken: string
  parseAndValidate requires the new field

api/public-api/__tests__/lib/githubAppSecrets.test.ts                 MODIFY
  fixtures get internalApiToken; one new "missing" test added

api/public-api/src/routes/internal-revoke-github.ts                   NEW
  POST /internal/revoke-github
  - Authorization: Bearer <internalApiToken> (timing-safe)
  - body: {userId, reason?}
  - lookup → secrets → sign JWT → revoke → markRevoked

api/public-api/__tests__/routes/internal-revoke-github.test.ts        NEW

api/public-api/src/index.ts                                           MODIFY
  + app.route('/', internalRevoke)
```

### Boundaries

- **`revokeInstallation`** — pure HTTP. Inputs `{installationId, jwt, fetch?, githubBaseUrl?, timeoutMs?}`. Output: `{ok: true, status: 204|404, alreadyDeleted}` or `{ok: false, status, body}`. No throwing on HTTP error; the route decides the policy. Reusable.
- **Route handler** — thin orchestration: auth → DB → secrets → revoke → mark. Under ~80 LOC. One log line per branch.
- **Secrets** — extend the existing JSON. One fetcher, one cache, one IAM grant. PR-2b's TTL semantics apply unchanged.

### Request flow

```
admin-api (tucaken-app)
  → POST /internal/revoke-github
    Authorization: Bearer <internalApiToken>
    Content-Type:  application/json
    Body:          { "userId": "<uuid>", "reason": "user_soft_delete" }

public-api:
  1. secrets = await getGitHubAppSecrets(cfg)                # TTL-cached
  2. timingSafeEqual(Bearer body, secrets.internalApiToken)  # 401 on mismatch
  3. body = await c.req.json()                               # 400 on parse fail
  4. require body.userId; truncate body.reason to 200 chars  # 400 if missing
  5. row = await repo.getByUserAndProvider(userId, 'github')
     → null → 200 {status: 'no_match'}
  6. row.installationId null → markRevoked + 200 {status: 'no_installation'}
  7. jwt = signGitHubAppJwt({appId, privateKeyPem})
  8. result = await revokeInstallation({installationId, jwt})
     - 204 → ok, alreadyDeleted: false
     - 404 → ok, alreadyDeleted: true
     - other 4xx/5xx → !ok → 500
  9. markRevoked(row.id, now)
  10. 200 {status: 'ok', alreadyDeleted}
```

## `revokeInstallation` helper

### Interface

```ts
export interface RevokeInstallationOpts {
    installationId: string;
    jwt:            string;
    fetch?:         typeof globalThis.fetch;
    githubBaseUrl?: string;       // default 'https://api.github.com'
    timeoutMs?:     number;       // default 10_000
}

export type RevokeInstallationResult =
    | { ok: true;  status: 204 | 404; alreadyDeleted: boolean }
    | { ok: false; status: number;    body: string };

export function revokeInstallation(opts: RevokeInstallationOpts): Promise<RevokeInstallationResult>;
```

### Algorithm

```ts
const url = `${opts.githubBaseUrl ?? 'https://api.github.com'}/app/installations/${encodeURIComponent(opts.installationId)}`;
const f   = opts.fetch ?? globalThis.fetch;
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
    if (res.status === 204) return { ok: true,  status: 204, alreadyDeleted: false };
    if (res.status === 404) return { ok: true,  status: 404, alreadyDeleted: true  };
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, body: body.slice(0, 500) };
} finally {
    clearTimeout(t);
}
```

### Design rationale

- 204 and 404 both `ok: true`; `alreadyDeleted` distinguishes for
  logging.
- No throw on HTTP error — caller logs `{status, body}` directly.
- 10-second abort upper bound; admin-api request stays snappy.
- Body truncated to 500 chars; logs don't blow up on weird responses.
- `X-GitHub-Api-Version` pins per GitHub's recommendation.

### Tests (7)

1. 204 → `{ok, status: 204, alreadyDeleted: false}`; URL + headers via mock-call assertion.
2. 404 → `{ok, status: 404, alreadyDeleted: true}`.
3. 403 → `{!ok, status: 403, body}`.
4. 500 → `{!ok, status: 500, body}`.
5. `Authorization: Bearer <jwt>` explicit-value check.
6. Custom `githubBaseUrl` honored.
7. Timeout aborts; rejection on `AbortError` after `timeoutMs: 50`.

## Secrets schema extension

```ts
export interface GitHubAppSecrets {
    readonly appId:            string;
    readonly privateKeyPem:    string;
    readonly webhookSecret:    string;
    readonly internalApiToken: string;   // NEW
}
```

`parseAndValidate` adds `internalApiToken` to the required fields. The
PR-2b error message extends to include the new field name. PR-2b's
existing 8 tests update their `VALID_JSON` fixture; one new test
asserts the "missing internalApiToken" error.

## Internal revoke route

### Route

```ts
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
    try { body = await c.req.json(); }
    catch {
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

### Status-code contract

| Outcome | Status | Body |
|---|---|---|
| Missing/wrong Bearer | 401 | `{error: 'unauthorized'}` |
| Body not JSON | 400 | `{error: 'bad json'}` |
| Missing `userId` | 400 | `{error: 'missing userId'}` |
| No `oauth_connections` row | 200 | `{status: 'no_match'}` |
| Row exists, no installation_id | 200 | `{status: 'no_installation'}` (also markRevoked) |
| GitHub 204 | 200 | `{status: 'ok', alreadyDeleted: false}` |
| GitHub 404 | 200 | `{status: 'ok', alreadyDeleted: true}` |
| GitHub other | 500 | `{error: 'github error', status: <n>}` |
| Repo throws | 500 | Hono default |

### Mounting

```ts
import internalRevoke from './routes/internal-revoke-github.js';
// ...
app.route('/', internalRevoke);
```

### Tests (12)

`getGitHubAppSecrets`, `getOAuthConnectionsRepo`, and `revokeInstallation`
all mocked via `jest.spyOn`. No real DB, KMS, AWS, or GitHub.

1. Happy path: GitHub 204 → 200 ok; `markRevoked` called; `revokeInstallation` called with correct `installationId` and JWT.
2. GitHub 404 → 200 `alreadyDeleted: true`; `markRevoked` called.
3. No row → 200 `no_match`; no revoke, no mark.
4. Row with null installation_id → 200 `no_installation`; markRevoked called; revokeInstallation NOT called.
5. GitHub 5xx → 500; markRevoked NOT called.
6. GitHub 403 → 500; markRevoked NOT called.
7. Missing Authorization → 401; no DB lookup.
8. Wrong Bearer token → 401.
9. Same-length wrong token (timing-safe path) → 401.
10. Body not JSON → 400.
11. Body missing `userId` → 400.
12. `reason` longer than 200 chars → 200 happy path; log captures truncated 200-char `reason`.

Test 1 also verifies the JWT path:

```ts
const { installationId, jwt } = (revokeInstallation as jest.Mock).mock.calls[0]![0];
expect(installationId).toBe('inst-42');
expect(jwt.split('.')).toHaveLength(3);
const header = JSON.parse(Buffer.from(jwt.split('.')[0]!, 'base64url').toString('utf8'));
expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
```

This catches the rare regression where someone passes the PEM as the
JWT by mistake.

## Observability

| Log | Level | Context fields |
|---|---|---|
| `internal.revoke_github.unauthorized` | WARN | ip |
| `internal.revoke_github.bad_json` | WARN | — |
| `internal.revoke_github.missing_userId` | WARN | — |
| `internal.revoke_github.no_match` | INFO | userId, reason |
| `internal.revoke_github.no_installation` | INFO | userId, reason, oauthConnectionId |
| `internal.revoke_github.github_error` | ERROR | userId, reason, oauthConnectionId, installationId, githubStatus, githubBody (truncated) |
| `internal.revoke_github.processed` | INFO | userId, reason, oauthConnectionId, installationId, alreadyDeleted |

What is NEVER logged: webhook secret, App private key, the Bearer
token, full GitHub response body (truncated to 500 chars), plaintext
access token.

## Risks

| Risk | Mitigation |
|---|---|
| Secret-rotation drift breaks `/webhooks/github` AND `/internal/revoke-github` | Both share the same TTL-cached JSON. Operator updates secret first, waits ≥10 min OR rolls pod, then updates admin-api's token. Recovery is automatic. |
| `internalApiToken` leaks | Worst case: attacker can revoke GitHub installations. They cannot read encrypted tokens or impersonate users. Rotate via Secrets Manager; both services pick up within 10 min. |
| Admin-api retries on 5xx → duplicate `markRevoked` | UPDATE is idempotent; GitHub returns 404 on repeat DELETE which we treat as `alreadyDeleted: true`. Safe. |
| GitHub rate limits during a batch sweep | App JWT auth gives 15k/hr; comfortable for account-deletion volume. If we ever batch this, add a queue. |
| Public-api pod boots before the secret JSON gains `internalApiToken` | Cache holds previous value as long as the pod hasn't restarted. **Operator runbook: update the secret first, then deploy this PR.** First fetch after rollout sees the new field. |

## Rollback

- Revert the PR. `/internal/revoke-github` returns 404. Admin-api
  should treat 404 as "revoke deferred" and not block soft-delete
  (graceful degradation).
- No DB migration in this PR. No schema rollback needed.
- Leaving `internalApiToken` set in the Secrets Manager JSON after a
  rollback is harmless.

## Operator runbook

1. **Add `internalApiToken`** to the existing GitHub App Secrets
   Manager JSON. Pick a strong random token (≥32 chars). Save it
   somewhere admin-api can read.
2. **Wait ≥10 min OR force-roll** the public-api pod with the existing
   image. Either way, the next `getGitHubAppSecrets` fetch pulls the
   new field. Until that happens, `/webhooks/github` continues to work
   because the previous cached value didn't need the new field — the
   parser only runs on fetch.
3. **Deploy this PR** to public-api.
4. **In tucaken-app's admin-api:** wire the soft-delete handler to
   `POST https://<public-api host>/internal/revoke-github` with the
   bearer token + `{userId, reason: 'user_soft_delete'}` body. Treat
   404 as "endpoint not deployed yet → skip but don't fail
   soft-delete"; treat 5xx as retryable.
5. **Smoke test:** soft-delete a test user; expect
   `internal.revoke_github.processed` log line and the GitHub
   installation to disappear from the App's installations list.

## Verification before merge

- `yarn workspace @bedrock/shared run test src/github/` — `revokeInstallation` tests green; PR-2b's webhook/JWT tests still green.
- `yarn workspace @repo/public-api run test __tests__/` — new internal-revoke tests + updated githubAppSecrets tests green; PR-2b's webhook tests still green.
- `yarn workspace @bedrock/shared run typecheck`; `yarn workspace @repo/public-api run typecheck` — exit 0.

## Follow-up

- PR-3: ingestion `GitHubAdapter` migration to installation tokens.
- Admin-api side (separate repo) hooks soft-delete handler to this
  endpoint.
- If unauthorized-rate alarms become useful, add an EMF metric in a
  follow-up.

## Out of scope

- Account soft-delete handler / Cognito JWT verification (tucaken-app
  owns these).
- Multi-provider revoke.
- Queue-based async retry.
- IRSA migration.
- `UNIQUE (installation_id)` constraint.
