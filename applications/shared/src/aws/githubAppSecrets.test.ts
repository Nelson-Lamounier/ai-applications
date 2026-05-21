/**
 * @file githubAppSecrets.test.ts
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
    getGitHubAppSecrets,
    __resetGitHubAppSecretsCacheForTests,
} from './githubAppSecrets.js';

const smMock = mockClient(SecretsManagerClient);

const ARN = 'arn:aws:secretsmanager:eu-west-1:0:secret/gh-app';

const VALID_JSON = JSON.stringify({
    appId:            '123',
    privateKeyPem:    '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----',
    webhookSecret:    'whsec_test',
    internalApiToken: 'internal_test_token',
});

beforeEach(() => {
    smMock.reset();
    __resetGitHubAppSecretsCacheForTests();
});

describe('getGitHubAppSecrets', () => {
    it('parses a valid JSON secret into a frozen four-field object', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: VALID_JSON });
        const out = await getGitHubAppSecrets({ secretArn: ARN });
        expect(out.appId).toBe('123');
        expect(out.privateKeyPem).toContain('BEGIN RSA PRIVATE KEY');
        expect(out.webhookSecret).toBe('whsec_test');
        expect(out.internalApiToken).toBe('internal_test_token');
        expect(Object.isFrozen(out)).toBe(true);
    });

    it('serves the cached value on a second call within TTL (same secretArn)', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: VALID_JSON });
        await getGitHubAppSecrets({ secretArn: ARN });
        await getGitHubAppSecrets({ secretArn: ARN });
        expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
    });

    it('re-fetches after the TTL expires (uses injected now)', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: VALID_JSON });
        const t0 = 1_700_000_000_000;
        await getGitHubAppSecrets({ secretArn: ARN, now: () => t0 });
        await getGitHubAppSecrets({ secretArn: ARN, now: () => t0 + 11 * 60_000 });
        expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(2);
    });

    it('caches independently per secretArn', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: VALID_JSON });
        await getGitHubAppSecrets({ secretArn: ARN });
        await getGitHubAppSecrets({ secretArn: ARN + '-other' });
        expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(2);
    });

    it('throws when SecretString is missing', async () => {
        smMock.on(GetSecretValueCommand).resolves({});
        await expect(getGitHubAppSecrets({ secretArn: ARN })).rejects.toThrow(/has no value/);
    });

    it('throws on invalid JSON', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: 'not json' });
        await expect(getGitHubAppSecrets({ secretArn: ARN })).rejects.toThrow(/is not valid JSON/);
    });

    it('throws when a required field is missing', async () => {
        smMock.on(GetSecretValueCommand).resolves({
            SecretString: JSON.stringify({
                appId: '1', privateKeyPem: 'x', webhookSecret: 'y',
            }),
        });
        await expect(getGitHubAppSecrets({ secretArn: ARN })).rejects.toThrow(/internalApiToken/);
    });

    it('accepts appId as number and coerces to string', async () => {
        smMock.on(GetSecretValueCommand).resolves({
            SecretString: JSON.stringify({
                appId: 123, privateKeyPem: 'x', webhookSecret: 'y', internalApiToken: 'z',
            }),
        });
        const out = await getGitHubAppSecrets({ secretArn: ARN });
        expect(out.appId).toBe('123');
    });

    it('__resetGitHubAppSecretsCacheForTests forces a fresh fetch', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: VALID_JSON });
        await getGitHubAppSecrets({ secretArn: ARN });
        __resetGitHubAppSecretsCacheForTests();
        await getGitHubAppSecrets({ secretArn: ARN });
        expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(2);
    });
});
