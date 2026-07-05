/**
 * @format
 * Tests for public-api lib/client-ip.ts — trusted-proxy client IP resolution.
 *
 * The security property under test: a caller can never influence the resolved
 * IP by pre-seeding X-Forwarded-For, because only the rightmost (proxy-appended)
 * entry is trusted.
 */

import { describe, it, expect } from '@jest/globals';
import { clientIpFromRequest, type HeaderReader } from '../../src/lib/client-ip.js';

/** Build a HeaderReader from a plain header map (case-insensitive keys). */
function reqWith(headers: Record<string, string | undefined>): HeaderReader {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { header: (name: string) => lower.get(name.toLowerCase()) };
}

describe('clientIpFromRequest', () => {
  it('returns the sole XFF entry (single trusted hop, e.g. BFF forward)', () => {
    expect(clientIpFromRequest(reqWith({ 'x-forwarded-for': '203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('returns the RIGHTMOST entry — the ALB-appended address', () => {
    // Client spoofed "1.2.3.4"; the ALB appended the real peer on the right.
    expect(
      clientIpFromRequest(reqWith({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' })),
    ).toBe('203.0.113.9');
  });

  it('ignores a spoofed chain and still trusts only the last hop', () => {
    expect(
      clientIpFromRequest(reqWith({ 'x-forwarded-for': '9.9.9.9, 8.8.8.8, 203.0.113.9' })),
    ).toBe('203.0.113.9');
  });

  it('never trusts a client-supplied X-Real-IP', () => {
    // Only X-Real-IP is present (no proxy-appended XFF) → treated as unknown,
    // not as the client's chosen value.
    expect(clientIpFromRequest(reqWith({ 'x-real-ip': '1.2.3.4' }))).toBe('unknown');
  });

  it('tolerates whitespace and trailing commas from odd proxies', () => {
    expect(
      clientIpFromRequest(reqWith({ 'x-forwarded-for': '1.2.3.4 , 203.0.113.9 ,' })),
    ).toBe('203.0.113.9');
  });

  it('returns "unknown" when no forwarded header is present', () => {
    expect(clientIpFromRequest(reqWith({}))).toBe('unknown');
  });
});
