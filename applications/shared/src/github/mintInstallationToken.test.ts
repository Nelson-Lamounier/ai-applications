// applications/shared/src/github/mintInstallationToken.test.ts
import { describe, it, expect, jest } from '@jest/globals';
import { mintInstallationToken, MintInstallationTokenError } from './mintInstallationToken.js';

function fakeFetch(response: { status: number; body: object | string | null }) {
    return jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
        const body = response.body === null
            ? null
            : typeof response.body === 'string'
                ? response.body
                : JSON.stringify(response.body);
        return new Response(body, { status: response.status }) as Response;
    });
}

describe('mintInstallationToken', () => {
    it('201 → { token, expiresAt } and uses the right URL + headers', async () => {
        const f = fakeFetch({
            status: 201,
            body: { token: 'ghs_abc', expires_at: '2026-01-01T01:00:00Z' },
        });
        const out = await mintInstallationToken({
            installationId: 'inst-42',
            jwt:            'jwt.payload.sig',
            fetch:          f as unknown as typeof globalThis.fetch,
        });
        expect(out.token).toBe('ghs_abc');
        expect(out.expiresAt.toISOString()).toBe('2026-01-01T01:00:00.000Z');

        expect(f).toHaveBeenCalledTimes(1);
        const [url, init] = f.mock.calls[0]!;
        expect(String(url)).toBe('https://api.github.com/app/installations/inst-42/access_tokens');
        expect((init as RequestInit).method).toBe('POST');
        const headers = (init as RequestInit).headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer jwt.payload.sig');
        expect(headers['Accept']).toBe('application/vnd.github+json');
        expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
        expect(headers['User-Agent']).toBe('ai-applications/installation-token-mint');
    });

    it('403 → throws MintInstallationTokenError with status + body', async () => {
        const f = fakeFetch({ status: 403, body: 'forbidden' });
        await expect(mintInstallationToken({
            installationId: 'x', jwt: 'x',
            fetch: f as unknown as typeof globalThis.fetch,
        })).rejects.toMatchObject({ status: 403, body: 'forbidden' });
    });

    it('500 → throws with status 500', async () => {
        const f = fakeFetch({ status: 500, body: 'boom' });
        await expect(mintInstallationToken({
            installationId: 'x', jwt: 'x',
            fetch: f as unknown as typeof globalThis.fetch,
        })).rejects.toMatchObject({ status: 500 });
    });

    it('honors a custom githubBaseUrl', async () => {
        const f = fakeFetch({
            status: 201,
            body: { token: 't', expires_at: '2026-01-01T01:00:00Z' },
        });
        await mintInstallationToken({
            installationId: 'inst-1', jwt: 'x',
            fetch:          f as unknown as typeof globalThis.fetch,
            githubBaseUrl:  'https://github.test',
        });
        const [url] = f.mock.calls[0]!;
        expect(String(url)).toBe('https://github.test/app/installations/inst-1/access_tokens');
    });

    it('aborts on timeout', async () => {
        const slowFetch = jest.fn((_url: string | URL | Request, init?: RequestInit) => {
            return new Promise<Response>((_, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    const err = new Error('aborted') as Error & { name: string };
                    err.name = 'AbortError';
                    reject(err);
                });
            });
        });
        await expect(mintInstallationToken({
            installationId: 'x', jwt: 'x',
            fetch:          slowFetch as unknown as typeof globalThis.fetch,
            timeoutMs:      50,
        })).rejects.toMatchObject({ name: 'AbortError' });
    });
});
