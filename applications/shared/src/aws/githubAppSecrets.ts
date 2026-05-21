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
