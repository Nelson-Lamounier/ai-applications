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
});
