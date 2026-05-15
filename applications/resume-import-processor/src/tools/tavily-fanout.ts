/**
 * @format
 * Parallel role-research fan-out for gap analysis.
 *
 * Runs one cached Tavily search per experience role, concurrently, with two
 * timeouts and a pre-emptive recency cap. Designed so partial failure is the
 * default: every input role gets exactly one tagged outcome, joinable by
 * roleId, and no worker ever throws.
 *
 * B1 — budget math (the silent-truncation fix):
 *   With concurrency C and per-request timeout T, N roles take ceil(N/C)
 *   waves ≈ ceil(N/C)·T worst case. For N=10, C=5, T=6s that is 12s > the
 *   10s overall budget, so the old design cancelled wave 2 mid-flight and
 *   silently dropped roles. Instead we cap the searched set to the most
 *   recent MAX_SEARCHED_ROLES *before* fan-out and tag the rest
 *   'skipped_budget' — a deterministic, surfaced outcome rather than a race.
 *
 * B2 — metrics are inline, not bolt-on: per-outcome counter + tavily
 *   duration histogram + one structured summary log per fan-out.
 *
 * No p-limit dependency — a ~15-line semaphore keeps the Job image dep-free.
 */
import type { Logger } from 'pino';
import type { SearchResult, WebSearchTool } from './tavily.js';

export interface FanoutRole {
  roleId:  string;
  company: string;
  title:   string;
  period:  string;
}

export type RoleSearchOutcome =
  | { roleId: string; status: 'ok';             results: SearchResult[]; latencyMs: number }
  | { roleId: string; status: 'empty';          latencyMs: number }
  | { roleId: string; status: 'failed';         reason: string; latencyMs: number }
  | { roleId: string; status: 'skipped_budget' };

export interface FanoutResult {
  outcomes:       RoleSearchOutcome[];
  budgetExceeded: boolean;
}

export const MAX_SEARCHED_ROLES       = 6;
export const MAX_CONCURRENCY          = 5;
export const PER_REQUEST_TIMEOUT_MS   = 6_000;
export const OVERALL_BUDGET_MS        = 10_000;
const MAX_RESULTS_PER_ROLE            = 4;

/**
 * Recency key for a free-text period. Returns the latest year mentioned;
 * an open-ended end ("Present"/"Current"/"Now") sorts most-recent. Unparseable
 * periods get -Infinity so they sort last but keep input order among
 * themselves (stable sort).
 */
export function recencyKey(period: string): number {
  if (/\b(present|current|now|ongoing)\b/i.test(period)) return Number.MAX_SAFE_INTEGER;
  const years = period.match(/\b(19|20)\d{2}\b/g);
  if (!years || years.length === 0) return Number.NEGATIVE_INFINITY;
  return Math.max(...years.map((y) => Number.parseInt(y, 10)));
}

function buildQuery(role: FanoutRole): string {
  const year = role.period.match(/\b(19|20)\d{2}\b/)?.[0] ?? '';
  const company = role.company
    .replace(/\s*(Inc\.?|Ltd\.?|LLC|GmbH|S\.A\.?|Pty)$/i, '')
    .trim();
  return `${role.title} ${company} ${year} responsibilities`.replace(/\s+/g, ' ').trim();
}

/** Minimal counting semaphore — caps concurrent workers without a dependency. */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

async function searchOneRole(
  role: FanoutRole,
  searchTool: WebSearchTool,
  parentSignal: AbortSignal,
): Promise<RoleSearchOutcome> {
  const started = Date.now();
  const query = buildQuery(role);
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Per-request AbortController, also aborted when the overall budget fires.
    const ctl = new AbortController();
    const onParentAbort = () => ctl.abort();
    if (parentSignal.aborted) ctl.abort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), PER_REQUEST_TIMEOUT_MS);

    try {
      const results = await searchTool.search(query, MAX_RESULTS_PER_ROLE, ctl.signal);
      const latencyMs = Date.now() - started;
      return results.length === 0
        ? { roleId: role.roleId, status: 'empty', latencyMs }
        : { roleId: role.roleId, status: 'ok', results, latencyMs };
    } catch (err) {
      const isLast    = attempt === maxAttempts;
      const aborted   = parentSignal.aborted;
      const name      = err instanceof Error ? err.name : '';
      // AbortError from our own per-request timer is treated as transient
      // (worth one retry if budget remains); a 4xx is not.
      const transient = name === 'AbortError'
        || !/\b4\d\d\b/.test(err instanceof Error ? err.message : String(err));

      // Don't retry if the overall budget can't fit another attempt.
      const budgetSpent = Date.now() - started;
      const noBudgetLeft = OVERALL_BUDGET_MS - budgetSpent < PER_REQUEST_TIMEOUT_MS;

      if (aborted || isLast || !transient || noBudgetLeft) {
        return {
          roleId: role.roleId,
          status: 'failed',
          reason: err instanceof Error ? err.message : String(err),
          latencyMs: Date.now() - started,
        };
      }
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 400));
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }
  return { roleId: role.roleId, status: 'failed', reason: 'unreachable', latencyMs: Date.now() - started };
}

/**
 * Fan out role research. The most-recent MAX_SEARCHED_ROLES are searched
 * concurrently; older roles are returned as 'skipped_budget' (not searched)
 * so the gap-analysis prompt and the user-facing free-tier messaging can be
 * explicit about which roles lack external context.
 */
export async function fanOutRoleSearches(
  roles: FanoutRole[],
  searchTool: WebSearchTool,
  log: Pick<Logger, 'info'>,
): Promise<FanoutResult> {
  const { tavilyDurationSeconds, fanoutTotal } = await import('../metrics.js');

  if (roles.length === 0) return { outcomes: [], budgetExceeded: false };

  // Stable recency sort: index keeps original order among equal keys.
  const ranked = roles
    .map((role, index) => ({ role, index, key: recencyKey(role.period) }))
    .sort((a, b) => (b.key - a.key) || (a.index - b.index));

  const searched = ranked.slice(0, MAX_SEARCHED_ROLES);
  const skipped  = ranked.slice(MAX_SEARCHED_ROLES);

  const skippedOutcomes: RoleSearchOutcome[] = skipped.map(({ role }) => {
    fanoutTotal().inc({ outcome: 'skipped_budget' });
    return { roleId: role.roleId, status: 'skipped_budget' as const };
  });

  const overallCtl = new AbortController();
  const wall = Date.now();
  const budgetTimer = setTimeout(() => overallCtl.abort(), OVERALL_BUDGET_MS);
  const sem = new Semaphore(MAX_CONCURRENCY);

  let searchedOutcomes: RoleSearchOutcome[];
  try {
    searchedOutcomes = await Promise.all(
      searched.map(({ role }) =>
        sem.run(async () => {
          const outcome = await searchOneRole(role, searchTool, overallCtl.signal);
          fanoutTotal().inc({ outcome: outcome.status });
          if ('latencyMs' in outcome) {
            tavilyDurationSeconds().observe(
              { outcome: outcome.status === 'ok' ? 'success' : outcome.status },
              outcome.latencyMs / 1000,
            );
          }
          return outcome;
        }),
      ),
    );
  } finally {
    clearTimeout(budgetTimer);
  }

  const outcomes = [...searchedOutcomes, ...skippedOutcomes];
  const summary = {
    event:          'tavily_fanout.complete',
    total:          roles.length,
    searched:       searched.length,
    ok:             searchedOutcomes.filter((o) => o.status === 'ok').length,
    empty:          searchedOutcomes.filter((o) => o.status === 'empty').length,
    failed:         searchedOutcomes.filter((o) => o.status === 'failed').length,
    skipped_budget: skippedOutcomes.length,
    budgetExceeded: overallCtl.signal.aborted,
    wallClockMs:    Date.now() - wall,
  };
  log.info(summary, 'tavily fan-out complete');

  return { outcomes, budgetExceeded: overallCtl.signal.aborted };
}
