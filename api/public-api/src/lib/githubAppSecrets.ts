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
    readonly appId:            string;
    readonly privateKeyPem:    string;
    readonly webhookSecret:    string;
    readonly internalApiToken: string;
}

const TTL_MS = 10 * 60 * 1000; // 10 min
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
    const privateKeyPem    = typeof o['privateKeyPem']    === 'string' && (o['privateKeyPem']    as string).length > 0 ? o['privateKeyPem']    as string : undefined;
    const webhookSecret    = typeof o['webhookSecret']    === 'string' && (o['webhookSecret']    as string).length > 0 ? o['webhookSecret']    as string : undefined;
    const internalApiToken = typeof o['internalApiToken'] === 'string' && (o['internalApiToken'] as string).length > 0 ? o['internalApiToken'] as string : undefined;
    if (!appId || !privateKeyPem || !webhookSecret || !internalApiToken) {
        throw new Error(`[github-app] Secret ${arn} missing one of: appId, privateKeyPem, webhookSecret, internalApiToken`);
    }
    return Object.freeze({ appId, privateKeyPem, webhookSecret, internalApiToken });
}

/** Test seam — clears the cache. */
export function __resetGitHubAppSecretsCacheForTests(): void {
    cache = undefined;
}
