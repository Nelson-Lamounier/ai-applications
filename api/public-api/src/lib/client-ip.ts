/**
 * @file client-ip.ts
 * @description Derive the real client IP from `X-Forwarded-For` in a way that
 * cannot be spoofed by the caller.
 *
 * Why this exists: public-api sits behind the shared `public` ALB, whose
 * `routing.http.xff_header_processing.mode` is `append`. In append mode the ALB
 * *appends* the TCP peer's address as the RIGHTMOST entry of `X-Forwarded-For`,
 * leaving any caller-supplied entries to its left untouched. The trustworthy
 * value is therefore the **last** entry (written by our trusted proxy), never
 * the first — the leftmost entry is fully attacker-controlled.
 *
 * The Next.js BFF forwards a single, already-resolved client IP over the
 * in-cluster hop (`x-forwarded-for: <clientIp>`), so the rightmost entry is that
 * same value there too. Taking the rightmost entry is thus correct on both
 * paths and stays correct if the service is ever re-exposed publicly.
 *
 * Gotcha: this is only sound while exactly one trusted proxy appends to XFF
 * (the ALB, or the BFF forwarding a single value). If another appending proxy
 * is ever inserted in front of this service, revisit the trusted-hop count.
 */

/** Header lookup shape satisfied by Hono's `c.req` and the Fetch `Headers` API. */
export interface HeaderReader {
  header(name: string): string | undefined;
}

/**
 * Resolve the client IP from request headers, trusting only the value appended
 * by the immediate upstream proxy (the rightmost `X-Forwarded-For` entry).
 *
 * Caller-supplied `X-Forwarded-For` and `X-Real-IP` values are intentionally
 * ignored — they are trivially spoofable and must never drive rate limiting or
 * any other per-IP control.
 *
 * @param req - Anything exposing a case-insensitive `header(name)` getter.
 * @returns The trusted client IP, or `'unknown'` when no forwarded header is
 *   present (e.g. a direct in-cluster call that set no XFF).
 * @example
 *   // XFF: "1.2.3.4, 203.0.113.9"  (1.2.3.4 was spoofed by the client)
 *   clientIpFromRequest(c.req) // => "203.0.113.9" (ALB-appended, trusted)
 */
export function clientIpFromRequest(req: HeaderReader): string {
  const xff = req.header('x-forwarded-for');
  if (xff) {
    // Rightmost non-empty entry = address written by the trusted proxy.
    const parts = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const trusted = parts[parts.length - 1];
    if (trusted) return trusted;
  }
  return 'unknown';
}
