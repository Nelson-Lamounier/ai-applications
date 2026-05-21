// applications/shared/src/github/appJwt.test.ts
import { describe, it, expect, beforeAll } from '@jest/globals';
import { generateKeyPairSync, constants as cryptoConstants } from 'node:crypto';
import { signGitHubAppJwt, GitHubAppJwtError } from './appJwt.js';

let privateKeyPem: string;
let publicKeyPem:  string;

beforeAll(() => {
    const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKeyPem = kp.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    publicKeyPem  = kp.publicKey.export({  type: 'spki',  format: 'pem' }).toString();
});

function decodeJwt(token: string): { header: unknown; payload: unknown; sig: Buffer; signingInput: string } {
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) throw new Error('bad jwt shape');
    const fromB64Url = (str: string): Buffer => Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return {
        header:       JSON.parse(fromB64Url(h).toString('utf8')),
        payload:      JSON.parse(fromB64Url(p).toString('utf8')),
        sig:          fromB64Url(s),
        signingInput: `${h}.${p}`,
    };
}

describe('signGitHubAppJwt', () => {
    it('produces RS256 JWT with iat=now-60, exp=now+540, iss=appId by default', () => {
        const fixedNow = 1_700_000_000_000; // ms
        const token = signGitHubAppJwt({
            appId:         42,
            privateKeyPem,
            now:           () => fixedNow,
        });
        const { header, payload } = decodeJwt(token);
        expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
        expect(payload).toEqual({
            iat: Math.floor(fixedNow / 1000) - 60,
            exp: Math.floor(fixedNow / 1000) + 540,
            iss: '42',
        });
    });
});
