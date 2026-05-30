/**
 * @format
 * Thin Prometheus HTTP API client + a generic poller.
 *
 * Prometheus scrapes admin-api every ~30s and the pushgateway shortly after a
 * Job pushes, so a synthetic assertion must POLL the query API until the
 * expected sample lands (or a timeout) rather than reading once.
 */
import type { PromVectorResponse } from './assertions.js';

/** Run an instant PromQL query against /api/v1/query. */
export async function queryInstant(baseUrl: string, expr: string): Promise<PromVectorResponse> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/v1/query?query=${encodeURIComponent(expr)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`prometheus query ${res.status}: ${expr}`);
  return (await res.json()) as PromVectorResponse;
}

/**
 * Poll `produce` until `accept` returns true or the deadline passes.
 * Returns the last produced value (caller asserts on it for the final reason).
 */
export async function pollUntil<T>(
  produce: () => Promise<T>,
  accept: (v: T) => boolean,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<{ ok: boolean; last: T }> {
  const deadline = Date.now() + opts.timeoutMs;
  let last = await produce();
  while (!accept(last)) {
    if (Date.now() >= deadline) return { ok: false, last };
    await new Promise((r) => setTimeout(r, opts.intervalMs));
    last = await produce();
  }
  return { ok: true, last };
}
