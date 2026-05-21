// applications/shared/src/github/mintInstallationToken.ts
/**
 * @format
 * Exchanges a GitHub App JWT for an installation access token.
 *
 * POST /app/installations/{installation_id}/access_tokens with the JWT in
 * Authorization. Returns the minted token plus its absolute expiry.
 *
 * Throws MintInstallationTokenError on any non-201 response — there is no
 * "soft success" case for this endpoint.
 */

export interface MintInstallationTokenOpts {
    installationId: string;
    jwt:            string;
    fetch?:         typeof globalThis.fetch;
    githubBaseUrl?: string;
    timeoutMs?:     number;
}

export interface InstallationToken {
    token:     string;
    expiresAt: Date;
}

export class MintInstallationTokenError extends Error {
    constructor(public readonly status: number, public readonly body: string) {
        super(`mintInstallationToken failed: HTTP ${status} ${body.slice(0, 200)}`);
        this.name = 'MintInstallationTokenError';
    }
}

export async function mintInstallationToken(opts: MintInstallationTokenOpts): Promise<InstallationToken> {
    const base = opts.githubBaseUrl ?? 'https://api.github.com';
    const url  = `${base}/app/installations/${encodeURIComponent(opts.installationId)}/access_tokens`;
    const f    = opts.fetch ?? globalThis.fetch;

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
}
