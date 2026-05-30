/**
 * @format
 * Pure HMAC-SHA256 verifier for GitHub webhook signatures.
 *
 * GitHub signs every webhook delivery with the secret you configure in
 * the App's settings and ships the digest in `X-Hub-Signature-256:
 * sha256=<hex>`. This helper compares the supplied digest to a freshly
 * computed one in constant time and returns false on every malformed-
 * input case — no throwing on bad headers.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhookSignature(
    rawBody:     Buffer,
    headerValue: string | undefined | null,
    secret:      string,
): boolean {
    if (!headerValue || !headerValue.startsWith('sha256=')) return false;

    const expected = Buffer.from(headerValue.slice('sha256='.length), 'hex');
    const actual   = createHmac('sha256', secret).update(rawBody).digest();

    if (expected.length !== actual.length) return false; // also catches malformed hex
    return timingSafeEqual(expected, actual);
}
