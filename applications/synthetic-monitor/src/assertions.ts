/**
 * @format
 * Pure assertion helpers for the synthetic monitor.
 *
 * These contain ZERO network/IO so they are exhaustively unit-tested. The
 * orchestrator (check.ts) does the network calls and feeds the raw Prometheus
 * responses through these to decide pass/fail. Keeping the decision logic pure
 * is what makes a synthetic check trustworthy — the part that says "the
 * dashboard reflects reality" must itself be tested.
 */

/** Shape of a Prometheus /api/v1/query instant (vector) response. */
export interface PromVectorResponse {
  status: string;
  data: { resultType: string; result: { metric: Record<string, string>; value: [number, string] }[] };
}

/** Sum the scalar values of every series in an instant vector. null if empty/error. */
export function sumVector(resp: PromVectorResponse): number | null {
  if (resp.status !== 'success' || resp.data.resultType !== 'vector') return null;
  if (resp.data.result.length === 0) return null;
  return resp.data.result.reduce((acc, s) => acc + Number(s.value[1]), 0);
}

/** Number of series in the vector (0 if empty/error). */
export function seriesCount(resp: PromVectorResponse): number {
  if (resp.status !== 'success') return 0;
  return resp.data.result.length;
}

/** A counter delta of at least `min` between two snapshots (treats null-before as 0). */
export function deltaAtLeast(before: number | null, after: number | null, min: number): boolean {
  if (after === null) return false;
  return after - (before ?? 0) >= min;
}

/**
 * Double-scrape guard: pushgateway series must NOT carry an exported_instance
 * label. A non-empty vector here means the honor_labels regression is back.
 */
export function hasNoDoubleScrape(resp: PromVectorResponse): boolean {
  return seriesCount(resp) === 0;
}

/** A histogram _sum must be strictly positive — catches "seeded but never observed". */
export function durationRecorded(resp: PromVectorResponse): boolean {
  const v = sumVector(resp);
  return v !== null && v > 0;
}

export type CheckName = 'auth' | 'resume_import';

export interface CheckResult {
  name: CheckName;
  ok: boolean;
  reason: string;
}
