// applications/shared/src/github/revokeInstallation.test.ts
import { describe, it, expect, jest } from '@jest/globals';
import { revokeInstallation } from './revokeInstallation.js';

function fakeFetch(response: { status: number; bodyText?: string }) {
    return jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
        // 204 (and other null-body statuses) disallow a body in the Response constructor.
        const nullBodyStatus = response.status === 204 || response.status === 205 || response.status === 304;
        const body = nullBodyStatus ? null : (response.bodyText ?? '');
        return new Response(body, { status: response.status }) as Response;
    });
}

describe('revokeInstallation', () => {
    it('204 → { ok: true, status: 204, alreadyDeleted: false } and uses the right URL + headers', async () => {
        const f = fakeFetch({ status: 204 });
        const res = await revokeInstallation({
            installationId: 'inst-42',
            jwt:            'jwt.payload.sig',
            fetch:          f as unknown as typeof globalThis.fetch,
        });
        expect(res).toEqual({ ok: true, status: 204, alreadyDeleted: false });

        expect(f).toHaveBeenCalledTimes(1);
        const [url, init] = f.mock.calls[0]!;
        expect(String(url)).toBe('https://api.github.com/app/installations/inst-42');
        expect((init as RequestInit).method).toBe('DELETE');
        const headers = (init as RequestInit).headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer jwt.payload.sig');
        expect(headers['Accept']).toBe('application/vnd.github+json');
        expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
        expect(headers['User-Agent']).toBe('ai-applications/oauth-revoke');
    });

    it('404 → { ok: true, status: 404, alreadyDeleted: true }', async () => {
        const f = fakeFetch({ status: 404, bodyText: 'Not Found' });
        const res = await revokeInstallation({
            installationId: 'gone',
            jwt:            'x',
            fetch:          f as unknown as typeof globalThis.fetch,
        });
        expect(res).toEqual({ ok: true, status: 404, alreadyDeleted: true });
    });

    it('403 → { ok: false, status: 403, body: <truncated text> }', async () => {
        const f = fakeFetch({ status: 403, bodyText: 'Forbidden because reasons' });
        const res = await revokeInstallation({
            installationId: 'x',
            jwt:            'x',
            fetch:          f as unknown as typeof globalThis.fetch,
        });
        expect(res).toEqual({ ok: false, status: 403, body: 'Forbidden because reasons' });
    });

    it('500 → { ok: false, status: 500, body }', async () => {
        const f = fakeFetch({ status: 500, bodyText: 'boom' });
        const res = await revokeInstallation({
            installationId: 'x',
            jwt:            'x',
            fetch:          f as unknown as typeof globalThis.fetch,
        });
        expect(res).toEqual({ ok: false, status: 500, body: 'boom' });
    });

    it('truncates long error bodies to 500 chars', async () => {
        const big = 'x'.repeat(2000);
        const f = fakeFetch({ status: 502, bodyText: big });
        const res = await revokeInstallation({
            installationId: 'x',
            jwt:            'x',
            fetch:          f as unknown as typeof globalThis.fetch,
        });
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.body.length).toBe(500);
            expect(res.body).toBe('x'.repeat(500));
        }
    });

    it('honors a custom githubBaseUrl', async () => {
        const f = fakeFetch({ status: 204 });
        await revokeInstallation({
            installationId: 'inst-1',
            jwt:            'x',
            fetch:          f as unknown as typeof globalThis.fetch,
            githubBaseUrl:  'https://github.test',
        });
        const [url] = f.mock.calls[0]!;
        expect(String(url)).toBe('https://github.test/app/installations/inst-1');
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

        await expect(revokeInstallation({
            installationId: 'x',
            jwt:            'x',
            fetch:          slowFetch as unknown as typeof globalThis.fetch,
            timeoutMs:      50,
        })).rejects.toMatchObject({ name: 'AbortError' });
    });
});
