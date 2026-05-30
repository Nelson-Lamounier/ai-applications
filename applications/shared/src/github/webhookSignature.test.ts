import { describe, it, expect } from '@jest/globals';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature } from './webhookSignature.js';

function signed(body: Buffer, secret: string): string {
    return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifyWebhookSignature', () => {
    const secret = 'topsecret';
    const body   = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8');

    it('returns true for a valid signature', () => {
        expect(verifyWebhookSignature(body, signed(body, secret), secret)).toBe(true);
    });

    it('returns false when the body is tampered', () => {
        const sig = signed(body, secret);
        const tampered = Buffer.from(body);
        tampered[0] ^= 0xff;
        expect(verifyWebhookSignature(tampered, sig, secret)).toBe(false);
    });

    it('returns false when the signature header is tampered', () => {
        const sig = signed(body, secret);
        const t = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');
        expect(verifyWebhookSignature(body, t, secret)).toBe(false);
    });

    it('returns false when the secret is wrong', () => {
        const sig = signed(body, 'other-secret');
        expect(verifyWebhookSignature(body, sig, secret)).toBe(false);
    });

    it('returns false when header is undefined', () => {
        expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
    });

    it('returns false on empty string header', () => {
        expect(verifyWebhookSignature(body, '', secret)).toBe(false);
    });

    it('returns false when header is not sha256-prefixed (e.g. sha1=)', () => {
        const sha1 = 'sha1=' + createHmac('sha1', secret).update(body).digest('hex');
        expect(verifyWebhookSignature(body, sha1, secret)).toBe(false);
    });

    it('returns false when header hex is malformed', () => {
        expect(verifyWebhookSignature(body, 'sha256=not-hex', secret)).toBe(false);
    });

    it('returns false on truncated header (length mismatch, no throw)', () => {
        const sig = signed(body, secret);
        expect(verifyWebhookSignature(body, sig.slice(0, 20), secret)).toBe(false);
    });
});
