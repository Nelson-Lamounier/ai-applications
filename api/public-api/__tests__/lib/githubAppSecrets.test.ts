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
    appId:          '123',
    privateKeyPem:  '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----',
    webhookSecret:  'whsec_test',
});

beforeEach(() => {
    smMock.reset();
    __resetGitHubAppSecretsCacheForTests();
    jest.useRealTimers();
});

describe('getGitHubAppSecrets', () => {
    it('parses a valid JSON secret into a frozen { appId, privateKeyPem, webhookSecret }', async () => {
        smMock.on(GetSecretValueCommand).resolves({ SecretString: VALID_JSON });
        const cfg = stubConfig();
        const out = await getGitHubAppSecrets(cfg);
        expect(out.appId).toBe('123');
        expect(out.privateKeyPem).toContain('BEGIN RSA PRIVATE KEY');
        expect(out.webhookSecret).toBe('whsec_test');
        expect(Object.isFrozen(out)).toBe(true);
    });
});
