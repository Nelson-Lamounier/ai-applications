// api/public-api/__tests__/routes/internal-revoke-github.test.ts
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { generateKeyPairSync } from 'node:crypto';

import internalRevoke from '../../src/routes/internal-revoke-github.js';
import { __resetGitHubAppSecretsCacheForTests } from '../../src/lib/githubAppSecrets-wrapper.js';
import { __resetOAuthSingletonsForTests } from '../../src/lib/oauth.js';
import * as ghSecrets from '../../src/lib/githubAppSecrets-wrapper.js';
import * as oauthLib from '../../src/lib/oauth.js';
import * as sharedLib from '@bedrock/shared';

const INTERNAL_TOKEN = 'internal_test_token';

const { privateKey: TEST_PRIVATE_KEY_PEM } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const SECRETS_FIXTURE = {
    appId:            '123',
    privateKeyPem:    TEST_PRIVATE_KEY_PEM,
    webhookSecret:    'whsec_test',
    internalApiToken: INTERNAL_TOKEN,
};

function makeRepoMock(overrides: Partial<{
    getByUserAndProvider: (userId: string, provider: string) => Promise<unknown>;
    markRevoked:          (id: string, at: Date) => Promise<void>;
}> = {}): {
    getByUserAndProvider: jest.Mock;
    markRevoked:          jest.Mock;
} {
    const getByUserAndProvider = jest.fn(async (..._args: unknown[]) => ({
        id: 'row-1', installationId: 'inst-42',
    }));
    const markRevoked = jest.fn(async (..._args: unknown[]) => undefined);

    jest.spyOn(oauthLib, 'getOAuthConnectionsRepo').mockReturnValue({
        getByUserAndProvider: (overrides.getByUserAndProvider ?? getByUserAndProvider) as unknown as never,
        markRevoked:          (overrides.markRevoked          ?? markRevoked) as unknown as never,
        markSuspended:        jest.fn() as unknown as never,
        upsert:               jest.fn() as unknown as never,
        getByInstallationId:  jest.fn() as unknown as never,
        getInstallationIdByUserAndProvider: jest.fn() as unknown as never,
    });
    return { getByUserAndProvider, markRevoked };
}

beforeEach(() => {
    __resetGitHubAppSecretsCacheForTests();
    __resetOAuthSingletonsForTests();
    jest.restoreAllMocks();

    process.env['PG_HOST']                  = 'localhost';
    process.env['PG_DATABASE']              = 'db';
    process.env['PG_USER']                  = 'u';
    process.env['PG_PASSWORD']              = 'p';
    process.env['OAUTH_TOKEN_KMS_KEY_ARN']  = 'arn:aws:kms:eu-west-1:0:key/abc';
    process.env['GITHUB_APP_SECRET_ARN']    = 'arn:aws:secretsmanager:eu-west-1:0:secret/gh-app';

    jest.spyOn(ghSecrets, 'getGitHubAppSecrets').mockResolvedValue(SECRETS_FIXTURE);
    jest.spyOn(sharedLib, 'revokeInstallation').mockResolvedValue({
        ok: true, status: 204, alreadyDeleted: false,
    });
});

async function call(body: object, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
    const res = await internalRevoke.request('/internal/revoke-github', {
        method:  'POST',
        body:    JSON.stringify(body),
        headers: {
            'content-type':  'application/json',
            'authorization': `Bearer ${INTERNAL_TOKEN}`,
            ...headers,
        },
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

describe('POST /internal/revoke-github', () => {
    it('happy path: GitHub 204 → 200 ok, markRevoked called, JWT shape verified', async () => {
        const repo = makeRepoMock();
        const out = await call({ userId: 'user-uuid-1', reason: 'user_soft_delete' });

        expect(out.status).toBe(200);
        expect(out.json).toMatchObject({ status: 'ok', alreadyDeleted: false });
        expect(repo.markRevoked).toHaveBeenCalledTimes(1);
        expect(repo.markRevoked.mock.calls[0]![0]).toBe('row-1');

        const calls = (sharedLib.revokeInstallation as jest.Mock).mock.calls;
        expect(calls).toHaveLength(1);
        const passed = calls[0]![0] as { installationId: string; jwt: string };
        expect(passed.installationId).toBe('inst-42');
        const parts = passed.jwt.split('.');
        expect(parts).toHaveLength(3);
        const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
        expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    });

    it('GitHub 404 → 200 ok with alreadyDeleted=true; markRevoked still called', async () => {
        const repo = makeRepoMock();
        (sharedLib.revokeInstallation as unknown as jest.Mock<() => Promise<unknown>>).mockResolvedValue({
            ok: true, status: 404, alreadyDeleted: true,
        });
        const out = await call({ userId: 'user-uuid-1' });
        expect(out.status).toBe(200);
        expect(out.json).toMatchObject({ status: 'ok', alreadyDeleted: true });
        expect(repo.markRevoked).toHaveBeenCalledTimes(1);
    });

    it('no oauth_connections row → 200 no_match; no revoke, no mark', async () => {
        const repo = makeRepoMock({ getByUserAndProvider: async () => null });
        const out = await call({ userId: 'unknown' });
        expect(out.status).toBe(200);
        expect(out.json).toMatchObject({ status: 'no_match' });
        expect(repo.markRevoked).not.toHaveBeenCalled();
        expect(sharedLib.revokeInstallation).not.toHaveBeenCalled();
    });

    it('row with null installationId → 200 no_installation; markRevoked called; revokeInstallation NOT called', async () => {
        const repo = makeRepoMock({
            getByUserAndProvider: async () => ({ id: 'row-2', installationId: null }),
        });
        const out = await call({ userId: 'user-uuid-2' });
        expect(out.status).toBe(200);
        expect(out.json).toMatchObject({ status: 'no_installation' });
        expect(repo.markRevoked).toHaveBeenCalledTimes(1);
        expect(sharedLib.revokeInstallation).not.toHaveBeenCalled();
    });

    it('GitHub 5xx → 500; markRevoked NOT called', async () => {
        const repo = makeRepoMock();
        (sharedLib.revokeInstallation as unknown as jest.Mock<() => Promise<unknown>>).mockResolvedValue({
            ok: false, status: 502, body: 'bad gateway',
        });
        const out = await call({ userId: 'user-uuid-1' });
        expect(out.status).toBe(500);
        expect(repo.markRevoked).not.toHaveBeenCalled();
    });

    it('GitHub 403 → 500; markRevoked NOT called', async () => {
        const repo = makeRepoMock();
        (sharedLib.revokeInstallation as unknown as jest.Mock<() => Promise<unknown>>).mockResolvedValue({
            ok: false, status: 403, body: 'forbidden',
        });
        const out = await call({ userId: 'user-uuid-1' });
        expect(out.status).toBe(500);
        expect(repo.markRevoked).not.toHaveBeenCalled();
    });

    it('missing Authorization header → 401; no DB lookup attempted', async () => {
        const repo = makeRepoMock();
        const res = await internalRevoke.request('/internal/revoke-github', {
            method: 'POST',
            body: JSON.stringify({ userId: 'x' }),
            headers: { 'content-type': 'application/json' },
        });
        expect(res.status).toBe(401);
        expect(repo.getByUserAndProvider).not.toHaveBeenCalled();
    });

    it('wrong Bearer token → 401', async () => {
        const repo = makeRepoMock();
        const out = await call({ userId: 'x' }, { authorization: 'Bearer wrong-token-xyz' });
        expect(out.status).toBe(401);
        expect(repo.getByUserAndProvider).not.toHaveBeenCalled();
    });

    it('same-length but different Bearer token → 401 (timing-safe path)', async () => {
        const repo = makeRepoMock();
        const sameLen = 'A'.repeat(INTERNAL_TOKEN.length);
        const out = await call({ userId: 'x' }, { authorization: `Bearer ${sameLen}` });
        expect(out.status).toBe(401);
        expect(repo.getByUserAndProvider).not.toHaveBeenCalled();
    });

    it('body not JSON → 400', async () => {
        makeRepoMock();
        const res = await internalRevoke.request('/internal/revoke-github', {
            method: 'POST',
            body: 'not-json',
            headers: {
                'content-type':  'application/json',
                'authorization': `Bearer ${INTERNAL_TOKEN}`,
            },
        });
        expect(res.status).toBe(400);
    });

    it('body missing userId → 400', async () => {
        const repo = makeRepoMock();
        const out = await call({ reason: 'nope' } as unknown as { userId: string });
        expect(out.status).toBe(400);
        expect(repo.getByUserAndProvider).not.toHaveBeenCalled();
    });

    it('reason longer than 200 chars is truncated in the logged payload', async () => {
        makeRepoMock();
        const logSpy = jest.spyOn(sharedLib, 'log').mockImplementation(() => undefined);
        try {
            const longReason = 'x'.repeat(500);
            const out = await call({ userId: 'user-uuid-1', reason: longReason });
            expect(out.status).toBe(200);

            const processedCall = logSpy.mock.calls.find(c => c[1] === 'internal.revoke_github.processed');
            expect(processedCall).toBeDefined();
            const payload = processedCall![2] as Record<string, unknown>;
            expect((payload['reason'] as string).length).toBe(200);
        } finally {
            logSpy.mockRestore();
        }
    });
});
