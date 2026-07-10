/**
 * @file oauth.test.ts
 * @description Verifies that getKmsEnvelope / getOAuthConnectionsRepo
 * cache their singletons and that __resetOAuthSingletonsForTests resets
 * the cache.
 */

import {
    getKmsEnvelope,
    getOAuthConnectionsRepo,
    __resetOAuthSingletonsForTests,
} from '../../src/lib/oauth.js';
import type { Config } from '../../src/lib/config.js';

// Minimal stub Config — only the fields oauth.ts reads.
function stubConfig(overrides: Partial<Config> = {}): Config {
    return {
        awsRegion:           'eu-west-1',
        pgHost:              'localhost',
        pgPort:              5432,
        pgDatabase:          'db',
        pgUser:              'u',
        pgPassword:          'p',
        port:                3001,
        allowedOrigins:      [],
        bedrockApiKeySecretArn: undefined,
        bedrockPublicApiUrl: undefined,
        bedrockAuthApiUrl:   undefined,
        oauthTokenKmsKeyArn: 'arn:aws:kms:eu-west-1:0:key/abc',
        ...overrides,
    } as Config;
}

beforeEach(() => __resetOAuthSingletonsForTests());

describe('lib/oauth singletons', () => {
    it('getKmsEnvelope returns the same instance across calls', () => {
        const cfg = stubConfig();
        const a = getKmsEnvelope(cfg);
        const b = getKmsEnvelope(cfg);
        expect(a).toBe(b);
    });

    it('getOAuthConnectionsRepo returns the same instance across calls', () => {
        const cfg = stubConfig();
        const a = getOAuthConnectionsRepo(cfg);
        const b = getOAuthConnectionsRepo(cfg);
        expect(a).toBe(b);
    });

    it('__resetOAuthSingletonsForTests clears the cache', () => {
        const cfg = stubConfig();
        const before = getOAuthConnectionsRepo(cfg);
        __resetOAuthSingletonsForTests();
        const after = getOAuthConnectionsRepo(cfg);
        expect(after).not.toBe(before);
    });
});
