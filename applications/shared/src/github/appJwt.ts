// applications/shared/src/github/appJwt.ts
/**
 * @format
 * Pure RS256 signer for GitHub App authentication.
 *
 * GitHub App JWTs are three claims (iat, exp, iss) signed with the App's
 * RSA private key. There's no need to pull in a JWT library — this file
 * fits in 60 lines using node:crypto.
 *
 * The helper is also reused by PR-2c (outbound DELETE /app/installations/{id})
 * which calls api.github.com with the JWT as Bearer auth.
 */

import {
    createSign,
    constants as cryptoConstants,
} from 'node:crypto';

export interface AppJwtOptions {
    appId:         string | number;
    privateKeyPem: string;
    /** Token lifetime in seconds; default 540 (9 min — GitHub caps at 10). */
    ttlSeconds?:   number;
    /** Test seam — returns current epoch ms; default Date.now. */
    now?:          () => number;
}

export class GitHubAppJwtError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'GitHubAppJwtError';
    }
}

function base64url(input: Buffer | string): string {
    const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
    return buf.toString('base64')
        .replace(/=+$/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

export function signGitHubAppJwt(opts: AppJwtOptions): string {
    const nowMs = opts.now?.() ?? Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
        iat: nowSec - 60,                                // 60s clock-skew slack
        exp: nowSec + (opts.ttlSeconds ?? 540),
        iss: String(opts.appId),
    };

    const h = base64url(JSON.stringify(header));
    const p = base64url(JSON.stringify(payload));
    const signingInput = `${h}.${p}`;

    try {
        const sig = createSign('RSA-SHA256')
            .update(signingInput)
            .sign({
                key:     opts.privateKeyPem,
                padding: cryptoConstants.RSA_PKCS1_PADDING,
            });
        return `${signingInput}.${base64url(sig)}`;
    } catch (err) {
        throw new GitHubAppJwtError('failed to sign GitHub App JWT', { cause: err });
    }
}
