// api/public-api/__tests__/routes/github-webhook.test.ts
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { createHmac } from 'node:crypto';

import githubWebhook from '../../src/routes/github-webhook.js';
import { __resetGitHubAppSecretsCacheForTests } from '../../src/lib/githubAppSecrets.js';
import { __resetOAuthSingletonsForTests } from '../../src/lib/oauth.js';
import * as ghSecrets from '../../src/lib/githubAppSecrets.js';
import * as oauthLib from '../../src/lib/oauth.js';

const WEBHOOK_SECRET = 'whsec_test';
const SECRETS_FIXTURE = {
    appId:         '123',
    privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
    webhookSecret: WEBHOOK_SECRET,
};

function makeRepoMock(overrides: Partial<{
    getByInstallationId: (id: string) => Promise<unknown | null>;
    markRevoked:         (id: string, at: Date) => Promise<void>;
    markSuspended:       (id: string, at: Date) => Promise<void>;
}> = {}): {
    markRevoked:   jest.Mock;
    markSuspended: jest.Mock;
    getById:       jest.Mock;
} {
    const markRevoked   = jest.fn(async (..._args: unknown[]) => undefined);
    const markSuspended = jest.fn(async (..._args: unknown[]) => undefined);
    const getById       = jest.fn(async (..._args: unknown[]) => ({ id: 'row-1', installationId: 'inst-42' }));

    jest.spyOn(oauthLib, 'getOAuthConnectionsRepo').mockReturnValue({
        getByInstallationId: (overrides.getByInstallationId ?? getById) as unknown as never,
        markRevoked:         (overrides.markRevoked         ?? markRevoked) as unknown as never,
        markSuspended:       (overrides.markSuspended       ?? markSuspended) as unknown as never,
        upsert:              jest.fn() as unknown as never,
        getByUserAndProvider: jest.fn() as unknown as never,
    });
    return { markRevoked, markSuspended, getById };
}

function sign(body: Buffer, secret: string): string {
    return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
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
});

async function post(body: object, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const res = await githubWebhook.request('/webhooks/github', {
        method:  'POST',
        body:    raw,
        headers: {
            'content-type':         'application/json',
            'x-github-event':       'installation',
            'x-github-delivery':    'delivery-uuid',
            'x-hub-signature-256':  sign(raw, WEBHOOK_SECRET),
            ...headers,
        },
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

describe('POST /webhooks/github', () => {
    it('valid installation.deleted → 200 ok + markRevoked called', async () => {
        const repo = makeRepoMock();
        const out = await post({ action: 'deleted', installation: { id: 42 } });
        expect(out.status).toBe(200);
        expect(out.json).toMatchObject({ status: 'ok' });
        expect(repo.markRevoked).toHaveBeenCalledTimes(1);
        expect(repo.markRevoked.mock.calls[0]![0]).toBe('row-1');
        expect(repo.markSuspended).not.toHaveBeenCalled();
    });
});
