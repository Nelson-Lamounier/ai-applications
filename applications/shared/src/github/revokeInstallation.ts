// applications/shared/src/github/revokeInstallation.ts
/**
 * @format
 * Calls GitHub's `DELETE /app/installations/{id}` to revoke a GitHub App
 * installation.
 *
 * Pure HTTP client. The caller signs the App JWT (see signGitHubAppJwt)
 * and passes it in. The helper returns a discriminated union so the caller
 * decides whether 404 is a success or a real failure — for our revoke flow,
 * 404 means "already gone" which is a success.
 *
 * Reusable by any path that needs to revoke an installation (PR-3 ingestion
 * could too).
 */

export interface RevokeInstallationOpts {
    installationId: string;
    jwt:            string;
    /** Test seam — defaults to globalThis.fetch. */
    fetch?:         typeof globalThis.fetch;
    /** Test seam — defaults to 'https://api.github.com'. */
    githubBaseUrl?: string;
    /** Abort the request after this many ms; default 10_000. */
    timeoutMs?:     number;
}

export type RevokeInstallationResult =
    | { ok: true;  status: 204 | 404; alreadyDeleted: boolean }
    | { ok: false; status: number;    body: string };

export async function revokeInstallation(opts: RevokeInstallationOpts): Promise<RevokeInstallationResult> {
    const base = opts.githubBaseUrl ?? 'https://api.github.com';
    const url  = `${base}/app/installations/${encodeURIComponent(opts.installationId)}`;
    const f    = opts.fetch ?? globalThis.fetch;

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

        if (res.status === 204) return { ok: true, status: 204, alreadyDeleted: false };
        if (res.status === 404) return { ok: true, status: 404, alreadyDeleted: true  };

        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, body: body.slice(0, 500) };
    } finally {
        clearTimeout(t);
    }
}
