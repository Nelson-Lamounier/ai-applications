// applications/shared/src/github/installationTokenProvider.ts
/**
 * @format
 * Builds a token provider for GitHubAdapter: returns () => Promise<string>
 * that caches the installation token and refreshes it when remaining
 * lifetime drops below `refreshThresholdMs` (default 5 min). Concurrent
 * refreshes are coalesced via a single in-flight Promise.
 */

import { signGitHubAppJwt } from './appJwt.js';
import {
    mintInstallationToken,
    type InstallationToken,
} from './mintInstallationToken.js';

export interface InstallationTokenProviderOpts {
    appId:               string | number;
    privateKeyPem:       string;
    installationId:      string;
    refreshThresholdMs?: number;
    now?:                () => number;
    mint?:               typeof mintInstallationToken;
    sign?:               typeof signGitHubAppJwt;
}

export type GitHubTokenProvider = () => Promise<string>;

const DEFAULT_REFRESH_THRESHOLD_MS = 5 * 60_000;

export function createInstallationTokenProvider(
    opts: InstallationTokenProviderOpts,
): GitHubTokenProvider {
    let cached:   { token: string; expiresAtMs: number } | undefined;
    let inFlight: Promise<InstallationToken> | undefined;

    return async function getToken(): Promise<string> {
        const now       = opts.now?.() ?? Date.now();
        const threshold = opts.refreshThresholdMs ?? DEFAULT_REFRESH_THRESHOLD_MS;

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
}
