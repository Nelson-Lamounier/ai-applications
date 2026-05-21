// applications/shared/src/github/installationTokenProvider.test.ts
import { describe, it, expect, jest } from '@jest/globals';
import { createInstallationTokenProvider } from './installationTokenProvider.js';

function fakeMint(token: string, expiresAtMs: number) {
    return jest.fn(async () => ({ token, expiresAt: new Date(expiresAtMs) }));
}

function fakeSign(jwt = 'signed-jwt') {
    return jest.fn(() => jwt);
}

describe('createInstallationTokenProvider', () => {
    it('first call mints and caches; second call within window reuses', async () => {
        const t0 = 1_700_000_000_000;
        const mint = fakeMint('tok-1', t0 + 60 * 60_000);
        const sign = fakeSign();
        const get = createInstallationTokenProvider({
            appId:          '1',
            privateKeyPem:  'pem',
            installationId: 'inst-1',
            now:            () => t0,
            mint:           mint as unknown as typeof import('./mintInstallationToken.js').mintInstallationToken,
            sign:           sign as unknown as typeof import('./appJwt.js').signGitHubAppJwt,
        });

        expect(await get()).toBe('tok-1');
        expect(await get()).toBe('tok-1');
        expect(mint).toHaveBeenCalledTimes(1);
        expect(sign).toHaveBeenCalledTimes(1);
    });
});
