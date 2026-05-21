// api/public-api/__tests__/lib/githubAppSecrets.test.ts
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
    getGitHubAppSecrets,
    __resetGitHubAppSecretsCacheForTests,
} from '../../src/lib/githubAppSecrets.js';
import type { Config } from '../../src/lib/config.js';

const smMock = mockClient(SecretsManagerClient);

function stubConfig(overrides: Partial<Config> = {}): Config {
    return {
        awsRegion:              'eu-west-1',
        pgHost:                 'localhost',
        pgPort:                 5432,
        pgDatabase:             'db',
        pgUser:                 'u',
        pgPassword:             'p',
        port:                   3001,
        allowedOrigins:         [],
        bedrockApiUrl:          undefined,
        bedrockApiKeySecretArn: undefined,
        bedrockPublicApiUrl:    undefined,
        bedrockAuthApiUrl:      undefined,
        oauthTokenKmsKeyArn:    'arn:aws:kms:eu-west-1:0:key/abc',
        githubAppSecretArn:     'arn:aws:secretsmanager:eu-west-1:0:secret/gh-app',
        ...overrides,
    } as Config;
}

const VALID_JSON = JSON.stringify({
    appId:            '123',
    privateKeyPem:    '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----',
    webhookSecret:    'whsec_test',
    internalApiToken: 'internal_test_token',
});

beforeEach(() => {
    smMock.reset();
    __resetGitHubAppSecretsCacheForTests();
    jest.useRealTimers();
});

describe('getGitHubAppSecrets', () => {
    it('parses a valid JSON secret into a frozen { appId, privateKeyPem, webhookSecret, internalApiToken }', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: VALID_JSON });
        const cfg = stubConfig();
        const out = await getGitHubAppSecrets(cfg);
        expect(out.appId).toBe('123');
        expect(out.privateKeyPem).toContain('BEGIN RSA PRIVATE KEY');
        expect(out.webhookSecret).toBe('whsec_test');
        expect(out.internalApiToken).toBe('internal_test_token');
        expect(Object.isFrozen(out)).toBe(true);
    });

    it('throws when internalApiToken is missing', async () => {
        smMock.on(GetSecretValueCommand).resolves({
            SecretString: JSON.stringify({
                appId:         '1',
                privateKeyPem: 'x',
                webhookSecret: 'y',
            }),
        });
        await expect(getGitHubAppSecrets(stubConfig())).rejects.toThrow(/internalApiToken/);
    });

    it('serves the cached value on a second call within TTL', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: VALID_JSON });
        const cfg = stubConfig();
        await getGitHubAppSecrets(cfg);
        await getGitHubAppSecrets(cfg);
        expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
    });

    it('re-fetches after the TTL expires', async () => {
        jest.useFakeTimers();
        try {
            jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
            smMock.on(GetSecretValueCommand).resolves({ SecretString: VALID_JSON });
            const cfg = stubConfig();
            await getGitHubAppSecrets(cfg);

            jest.setSystemTime(new Date('2026-01-01T00:11:00Z'));
            await getGitHubAppSecrets(cfg);

            expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(2);
        } finally {
            jest.useRealTimers();
        }
    });

    it('throws when SecretString is missing', async () => {
        smMock.on(GetSecretValueCommand).resolves({});
        await expect(getGitHubAppSecrets(stubConfig())).rejects.toThrow(/has no value/);
    });

    it('throws on invalid JSON', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: 'not json' });
        await expect(getGitHubAppSecrets(stubConfig())).rejects.toThrow(/is not valid JSON/);
    });

    it('throws when a required field is missing', async () => {
        smMock.on(GetSecretValueCommand).resolves({
            SecretString: JSON.stringify({ appId: '1', privateKeyPem: 'x' }),
        });
        await expect(getGitHubAppSecrets(stubConfig())).rejects.toThrow(/missing one of/);
    });

    it('accepts appId as a number and coerces to string', async () => {
        smMock.on(GetSecretValueCommand).resolves({
            SecretString: JSON.stringify({ appId: 123, privateKeyPem: 'x', webhookSecret: 'y', internalApiToken: 'z' }),
        });
        const out = await getGitHubAppSecrets(stubConfig());
        expect(out.appId).toBe('123');
    });

    it('__resetGitHubAppSecretsCacheForTests forces a fresh fetch', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: VALID_JSON });
        await getGitHubAppSecrets(stubConfig());
        __resetGitHubAppSecretsCacheForTests();
        await getGitHubAppSecrets(stubConfig());
        expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(2);
    });
});
