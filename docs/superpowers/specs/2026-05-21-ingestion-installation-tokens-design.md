# Ingestion Installation Tokens (PR-3 of OAuth migration)

**Date:** 2026-05-21
**Status:** Design, pending implementation
**Author:** Nelson Lamounier

## Context

PR-1, PR-2a, PR-2b, PR-2c migrated `oauth_connections.access_token`
to envelope encryption, wired the foundation, added the inbound webhook
handler, and added the internal revoke endpoint. The ingestion path
still authenticates to GitHub with a static PAT (`GITHUB_TOKEN` env
var) shared across all users — see
`applications/shared/src/ingestion/implementations/GitHubAdapter.ts`
line 120 (`constructor(token: string)`) and the env parser at
`applications/ingestion/src/env.ts` line 35.

PR-3 replaces that PAT with per-installation GitHub App tokens:

- The App private key signs a short-lived JWT.
- The JWT exchanges (via `POST /app/installations/{id}/access_tokens`)
  for an installation token scoped to one user's installation.
- The token has ≤1hr TTL and is refreshed near expiry.
- Ingestion calls GitHub with that token.

PR-2c's `oauth_connections.installation_id` lookup is the link between
the ingestion-job-level `userId` env var and the GitHub App
installation.

## Goals

- Add `mintInstallationToken` helper in `@bedrock/shared/github` —
  pure HTTP client for `POST /app/installations/{id}/access_tokens`.
- Add `createInstallationTokenProvider` in
  `@bedrock/shared/github` — caching factory that returns
  `() => Promise<string>` and refreshes within ≤5min of expiry,
  coalescing concurrent refreshes.
- Move `getGitHubAppSecrets` from `api/public-api/src/lib/` to
  `applications/shared/src/aws/` so both public-api and ingestion can
  use it. Public-api keeps a thin Config-aware wrapper.
- Refactor `GitHubAdapter` to accept
  `tokenProvider: () => Promise<string>`. Add a `fromTokenString`
  static for the smoke script. Remove `fromEnvironment`.
- Add `getInstallationIdByUserAndProvider` on the OAuth repo so
  ingestion can read `installation_id` without taking a KMS
  dependency.
- Replace ingestion's `GITHUB_TOKEN` env with `GITHUB_APP_SECRET_ARN`.
  Boot looks up the user's `installation_id`, fetches the App secret,
  constructs the token provider, and passes it to `GitHubAdapter`.

## Non-Goals

- Retry-on-401 in `GitHubAdapter` (mid-run revocation handling).
  YAGNI; revocation mid-run is rare. Operator re-runs after the user
  re-installs.
- Removing `oauth_connections.access_token_*` columns. The OAuth
  callback path still writes plaintext tokens at initial connect; that
  flow lives outside this repo.
- Caching the App JWT itself. Re-signing is ≤25ms locally; the
  installation-token cache is what matters.
- Migrating the smoke script to App auth — it stays on `GITHUB_TOKEN`
  via `GitHubAdapter.fromTokenString`.

## Architecture

```
applications/shared/src/aws/                                          NEW
  githubAppSecrets.ts            moved from api/public-api/src/lib/
                                 generic args: { secretArn, region? }
                                 cache keyed on secretArn
  githubAppSecrets.test.ts

applications/shared/src/github/                                       NEW
  mintInstallationToken.ts       POST /app/installations/{id}/access_tokens
  mintInstallationToken.test.ts
  installationTokenProvider.ts   refresh-near-expiry cache wrapper
  installationTokenProvider.test.ts
  index.ts                       + new exports

applications/shared/src/index.ts                                      MODIFY
  + re-export getGitHubAppSecrets, GitHubAppSecrets, mintInstallationToken,
    InstallationToken, MintInstallationTokenError,
    createInstallationTokenProvider, GitHubTokenProvider

applications/shared/src/ingestion/implementations/
  GitHubAdapter.ts                                                    MODIFY
  constructor(tokenProvider: GitHubTokenProvider)
  static fromTokenString(token: string): GitHubAdapter
  remove fromEnvironment()
  private get<T>() awaits this.tokenProvider() before each request

applications/shared/src/rds/interfaces/
  IOAuthConnectionsRepository.ts                                      MODIFY
  + getInstallationIdByUserAndProvider(userId, provider): Promise<string | null>

applications/shared/src/rds/implementations/
  RdsOAuthConnectionsRepository.ts                                    MODIFY
  + getInstallationIdByUserAndProvider implementation
  constructor `deps.envelope` becomes optional; decryptRow still requires
  it and throws a clear error if absent
  RdsOAuthConnectionsRepository.test.ts                               MODIFY
  + 2 tests for the new method

api/public-api/src/lib/                                               MODIFY
  githubAppSecrets-wrapper.ts    NEW — thin Config adapter
                                  re-exports __resetGitHubAppSecretsCacheForTests
  githubAppSecrets.ts            DELETED

api/public-api/src/routes/github-webhook.ts                           MODIFY
  + import path → '../lib/githubAppSecrets-wrapper.js'

api/public-api/src/routes/internal-revoke-github.ts                   MODIFY
  + import path → '../lib/githubAppSecrets-wrapper.js'

api/public-api/__tests__/lib/githubAppSecrets.test.ts                 RELOCATED
  moved to applications/shared/src/aws/githubAppSecrets.test.ts

applications/ingestion/src/env.ts                                     MODIFY
  - drop required GITHUB_TOKEN
  + add required GITHUB_APP_SECRET_ARN
  + add awsRegion (AWS_REGION / AWS_DEFAULT_REGION / 'eu-west-1')

applications/ingestion/src/run-ingestion.ts                           MODIFY
  + construct pool + oauthRepo (no envelope)
  + look up installationId; fail fast if null
  + fetch App secrets
  + build tokenProvider
  + new GitHubAdapter(tokenProvider)

scripts/smoke-test-github-adapter.ts                                  MODIFY
  new GitHubAdapter(token) → GitHubAdapter.fromTokenString(token)
```

### Boundaries

- `mintInstallationToken` — pure HTTP. Throws on non-201 (no
  "soft success" case unlike revoke's 404).
- `createInstallationTokenProvider` — closure-over-state factory.
  Returns `() => Promise<string>`. Owns cache + in-flight Promise.
- `getGitHubAppSecrets` (shared) — Secrets Manager fetcher, TTL-cached
  per secretArn, validation at fetch time. Mirrors PR-2b semantics.
- `GitHubAdapter` — surface unchanged (`listFiles`, `fetchFile`,
  `listCommits`, `getRepoMeta`). Calls `await this.tokenProvider()`
  per request.
- Ingestion boot — the only place that wires everything together.

## `mintInstallationToken`

### Interface

```ts
export interface MintInstallationTokenOpts {
    installationId: string;
    jwt:            string;
    fetch?:         typeof globalThis.fetch;
    githubBaseUrl?: string;       // default 'https://api.github.com'
    timeoutMs?:     number;       // default 10_000
}

export interface InstallationToken {
    token:     string;
    expiresAt: Date;
}

export class MintInstallationTokenError extends Error {
    constructor(public readonly status: number, public readonly body: string);
}

export function mintInstallationToken(opts: MintInstallationTokenOpts): Promise<InstallationToken>;
```

### Algorithm

```ts
const url = `${opts.githubBaseUrl ?? 'https://api.github.com'}/app/installations/${encodeURIComponent(opts.installationId)}/access_tokens`;
const f   = opts.fetch ?? globalThis.fetch;
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
```

### Tests (5)

1. 201 → returns `{token, expiresAt}`; URL + headers + Bearer JWT
   verified via mock-call args.
2. 403 → throws `MintInstallationTokenError` with `status: 403` and
   the body text.
3. 500 → throws with `status: 500`.
4. Custom `githubBaseUrl` honored.
5. Timeout aborts; `AbortError` after `timeoutMs: 50`.

## `createInstallationTokenProvider`

### Interface

```ts
export interface InstallationTokenProviderOpts {
    appId:               string | number;
    privateKeyPem:       string;
    installationId:      string;
    refreshThresholdMs?: number;          // default 5 * 60_000
    now?:                () => number;    // test seam
    mint?:               typeof mintInstallationToken;
    sign?:               typeof signGitHubAppJwt;
}

export type GitHubTokenProvider = () => Promise<string>;

export function createInstallationTokenProvider(
    opts: InstallationTokenProviderOpts,
): GitHubTokenProvider;
```

### Internal state (per closure)

- `cached: { token: string; expiresAtMs: number } | undefined`
- `inFlight: Promise<InstallationToken> | undefined` — coalesces
  concurrent refreshes.

### Algorithm

```ts
return async function getToken(): Promise<string> {
    const now = (opts.now?.() ?? Date.now());
    const threshold = opts.refreshThresholdMs ?? 5 * 60_000;

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
```

### Tests (6)

`mint`, `sign`, `now` all injected.

1. First call mints + caches; `mint` called once.
2. Second call within window reuses cache; `mint` still called once.
3. Call near expiry refreshes; `mint` called twice.
4. Concurrent calls during a refresh coalesce; `mint` called once.
5. Custom `refreshThresholdMs` honored.
6. Mint failure surfaces; cache stays empty; retry mints again.

## `getGitHubAppSecrets` move to shared

`applications/shared/src/aws/githubAppSecrets.ts`:

```ts
export interface GitHubAppSecrets {
    readonly appId:            string;
    readonly privateKeyPem:    string;
    readonly webhookSecret:    string;
    readonly internalApiToken: string;
}

export interface GetGitHubAppSecretsOpts {
    secretArn: string;
    region?:   string;
    client?:   SecretsManagerClient;   // test seam
    ttlMs?:    number;                  // default 10 min
    now?:      () => number;            // test seam
}

const cache = new Map<string, { value: GitHubAppSecrets; expiresAt: number }>();

export async function getGitHubAppSecrets(opts: GetGitHubAppSecretsOpts): Promise<GitHubAppSecrets>;
export function __resetGitHubAppSecretsCacheForTests(): void;
```

`parseAndValidate` semantics unchanged from PR-2b/2c. Cache keyed on
`secretArn` so multiple consumers with the same ARN share a single
entry; different ARNs each get their own.

### Public-api wrapper

`api/public-api/src/lib/githubAppSecrets-wrapper.ts`:

```ts
import { getGitHubAppSecrets as getFromShared } from '@bedrock/shared';
import type { Config } from './config.js';

export async function getGitHubAppSecrets(config: Config) {
    return getFromShared({
        secretArn: config.githubAppSecretArn,
        region:    config.awsRegion,
    });
}
export { __resetGitHubAppSecretsCacheForTests } from '@bedrock/shared';
```

`github-webhook.ts` and `internal-revoke-github.ts` only change their
import path; route logic untouched.

## `GitHubAdapter` refactor

```ts
export type GitHubTokenProvider = () => Promise<string>;

export class GitHubAdapter implements IRepoAdapter {
    constructor(private readonly tokenProvider: GitHubTokenProvider) {}
    static fromTokenString(token: string): GitHubAdapter {
        return new GitHubAdapter(async () => token);
    }
    // fromEnvironment() removed
}
```

Internal `get<T>()` change:

```ts
const token = await this.tokenProvider();
const opts = {
    method:  'GET',
    headers: {
        'User-Agent':    'ai-applications/github-adapter',
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    },
};
```

One `await` added per request. Provider's cache means most calls are a
single map lookup. No retry-on-401.

### Tests

If `GitHubAdapter.test.ts` exists, update constructor calls. Add one
new test:

```ts
it('calls tokenProvider before each request and uses the returned token', async () => {
    const tokens = ['t1', 't2', 't3'];
    let i = 0;
    const provider = jest.fn(async () => tokens[i++]!);
    // Mock https.request via existing pattern; assert provider called 3 times
    // and each request carried the right token.
});
```

If no test file exists, create a minimal one with three cases:
constructor stores provider; `fromTokenString` returns adapter
returning the supplied token; provider called before each HTTP call.

## OAuth repo: `getInstallationIdByUserAndProvider`

Adds a method that skips envelope decryption — pure SQL — so ingestion
can read `installation_id` without taking a KMS dependency.

### Interface change

`applications/shared/src/rds/interfaces/IOAuthConnectionsRepository.ts`:

```ts
getInstallationIdByUserAndProvider(userId: string, provider: string): Promise<string | null>;
```

### Implementation

```ts
async getInstallationIdByUserAndProvider(userId: string, provider: string): Promise<string | null> {
    const res = await this.deps.pool.query<{ installation_id: string | null }>(
        `SELECT installation_id FROM oauth_connections WHERE user_id = $1 AND provider = $2`,
        [userId, provider],
    );
    return res.rows[0]?.installation_id ?? null;
}
```

### Constructor change

`deps.envelope` becomes optional:

```ts
constructor(deps: { pool: Pool; envelope?: KmsEnvelope }) { ... }
```

`decryptRow` still throws a clear error if `envelope` is undefined and
ciphertext columns are populated.

### Tests (2 new in `RdsOAuthConnectionsRepository.test.ts`)

1. Returns `installation_id` for an existing row.
2. Returns `null` when no row matches.

## Ingestion env + boot

### `applications/ingestion/src/env.ts`

```ts
export interface IngestionEnv {
    readonly userId:                  string;
    readonly repoFullName:            string;
    readonly forceReindex:            boolean;
    readonly githubAppSecretArn:      string;          // was: githubToken
    readonly awsRegion:               string;          // NEW
    readonly profileExtractorModelId: string;
    readonly pg:                      { ... };
}

export function parseEnv(): IngestionEnv {
    return {
        userId:                  required('USER_ID'),
        repoFullName:            required('REPO_FULL_NAME'),
        forceReindex:            (process.env['FORCE_REINDEX'] ?? 'false').toLowerCase() === 'true',
        githubAppSecretArn:      required('GITHUB_APP_SECRET_ARN'),
        awsRegion:               process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'eu-west-1',
        profileExtractorModelId: process.env['PROFILE_EXTRACTOR_MODEL_ID']
            ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
        pg: { /* unchanged */ },
    };
}
```

### `applications/ingestion/src/run-ingestion.ts`

```ts
import { Pool } from 'pg';
import {
    RdsOAuthConnectionsRepository,
    getGitHubAppSecrets,
    createInstallationTokenProvider,
    GitHubAdapter,
} from '@bedrock/shared';

const env  = parseEnv();
const pool = new Pool({
    host: env.pg.host, port: env.pg.port,
    database: env.pg.database, user: env.pg.user, password: env.pg.password,
});

const oauthRepo = new RdsOAuthConnectionsRepository({ pool });  // no envelope

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
// existing pipeline/orchestrator construction unchanged
```

Existing `Pool` construction may already exist for
`RdsSyncStateRepository`; combine if so.

### Smoke script

`scripts/smoke-test-github-adapter.ts` line 21:

```ts
const adapter = GitHubAdapter.fromTokenString(token);
```

Zero behaviour change for the smoke flow.

## Risks

| Risk | Mitigation |
|---|---|
| User has no `installation_id` | Fail-fast at boot with a clear error identifying the user. Operator runs SQL to find affected users; user reinstalls; re-run. |
| Run >1hr exceeds installation token TTL | Provider refreshes at ≤5min remaining. Coalescing prevents thundering herd. |
| GitHub rate limits on token mint | App installations have generous limits (5000 req/hr per installation). We mint ≤ once/hr per run. Negligible. |
| User uninstalls mid-run → 401 storm | Ingestion fails; operator notices; rerun after reinstall. YAGNI on retry-on-401 in this PR. |
| Secrets Manager outage at boot | Same as any other Secrets-Manager-dependent service. Job restart policy retries. |
| Shared-package move breaks PR-2b/2c routes | Wrapper file preserves the public-api import name. Tests verify the routes still pass. |
| Smoke script breaks | One-line change to `fromTokenString`; env var semantics preserved. |

## Rollback

- Revert the PR. Ingestion goes back to PAT auth (must re-add
  `GITHUB_TOKEN`). The shared-package move reverts cleanly — the
  wrapper goes away, original `githubAppSecrets.ts` is restored,
  routes' imports go back.
- No DB migration. The new repo method is additive; reverting drops it
  harmlessly.

## Operator runbook

1. Update the ingestion K8s Job manifest:
   - Add `GITHUB_APP_SECRET_ARN` env var pointing at the same secret
     PR-2b set up.
   - Optionally remove `GITHUB_TOKEN` (no longer read; tidier).
   - Confirm the EKS node IAM role has
     `secretsmanager:GetSecretValue` on the ARN (true if PR-2b is
     already deployed).
2. Confirm every user that ingestion will run for has a populated
   `oauth_connections.installation_id`:
   ```sql
   SELECT user_id FROM oauth_connections
   WHERE provider = 'github' AND installation_id IS NULL;
   ```
   Any rows returned → ask those users to reinstall the App before
   their next ingestion run.
3. Deploy this PR.
4. Trigger ingestion for a test user; expect normal completion.

## Verification before merge

- `yarn workspace @bedrock/shared run test src/github/ src/aws/ src/rds/ src/ingestion/`
  — all green.
- `yarn workspace @repo/public-api run test __tests__/` — all green
  (PR-2b/2c routes still working through the wrapper).
- `yarn workspace @bedrock/ingestion run test` — green.
- Typecheck across all four workspaces.
- `yarn workspace @bedrock/shared run build` — `dist/` refreshed.

## Out of scope

- Retry-on-401 in `GitHubAdapter`.
- Removing `oauth_connections.access_token_*` columns.
- Migrating the smoke script to App auth.
- Caching the App JWT itself.
- IRSA migration for the ingestion job.
