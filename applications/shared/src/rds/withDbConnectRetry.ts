/**
 * @format
 * Transient DB-connection retry for the vector store's query path.
 *
 * A brief pooler outage — e.g. pgbouncer rolling on a deploy, an RDS failover,
 * a node dropping the connection — surfaces as a connection-CLASS error on
 * `pool.query`: the statement never reached Postgres (connection refused) or the
 * socket was reset before a result came back. Retrying such errors is safe and
 * idempotent, and rides through the ~seconds-long blip instead of failing the
 * whole (expensive, multi-minute) pipeline. This mirrors the Bedrock-throttle
 * retry already done inside runAgent: recover from transient infra in place.
 *
 * ONLY connection-class errors are retried. Query errors — syntax, constraint
 * violation, a statement timeout mid-execution — are deterministic and fail
 * fast, unchanged. Apply this only around idempotent statements (SELECTs and
 * idempotent DELETEs): a connection error means the statement did not commit, so
 * a retry cannot double-apply.
 */

/** errno-style codes for a refused/reset/unreachable connection. */
const CONNECTION_ERROR_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EPIPE',
    'EHOSTUNREACH',
    'ENETUNREACH',
]);

/** libpq / node-postgres connection-failure message fragments (lower-cased). */
const CONNECTION_ERROR_PATTERNS = [
    'econnrefused',
    'econnreset',
    'connection terminated',
    'terminating connection',
    'connection refused',
    'server closed the connection unexpectedly',
    'the database system is starting up',
    'the database system is shutting down',
    'timeout exceeded when trying to connect',
    'could not connect',
];

/**
 * True when `err` looks like a transient connection-establishment / reset
 * failure (never a query-level error). Checks the errno `code` first, then a
 * conservative set of libpq message fragments.
 */
export function isConnectionError(err: unknown): boolean {
    if (err === null || typeof err !== 'object') return false;
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && CONNECTION_ERROR_CODES.has(code)) return true;
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') {
        const lower = message.toLowerCase();
        return CONNECTION_ERROR_PATTERNS.some((p) => lower.includes(p));
    }
    return false;
}

export interface DbConnectRetryOptions {
    /** Total attempts including the first (default 3). */
    readonly maxAttempts?: number;
    /** Backoff base in ms; delay = base * 2^(attempt-1), capped (default 250). */
    readonly baseDelayMs?: number;
    /** Backoff cap in ms (default 4000). */
    readonly maxDelayMs?: number;
    /** Called before each retry sleep — surface the transient blip to logs. */
    readonly onRetry?: (info: { attempt: number; delayMs: number; err: unknown }) => void;
    /** Injectable sleep (tests pass a no-op / fake timer). */
    readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface ResolvedRetryOptions {
    readonly maxAttempts: number;
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
    readonly sleep: (ms: number) => Promise<void>;
    readonly onRetry?: DbConnectRetryOptions['onRetry'];
}

function resolveOptions(o: DbConnectRetryOptions): ResolvedRetryOptions {
    return {
        maxAttempts: o.maxAttempts ?? 3,
        baseDelayMs: o.baseDelayMs ?? 250,
        maxDelayMs: o.maxDelayMs ?? 4000,
        sleep: o.sleep ?? defaultSleep,
        onRetry: o.onRetry,
    };
}

/**
 * Run `fn`, retrying ONLY connection-class failures with capped exponential
 * backoff. Any non-connection error, or exhausting `maxAttempts`, rethrows the
 * original error so callers see the real failure.
 */
export async function withDbConnectRetry<T>(
    fn: () => Promise<T>,
    options: DbConnectRetryOptions = {},
): Promise<T> {
    const { maxAttempts, baseDelayMs, maxDelayMs, sleep, onRetry } = resolveOptions(options);

    let attempt = 0;
    for (;;) {
        attempt += 1;
        try {
            return await fn();
        } catch (err) {
            if (attempt >= maxAttempts || !isConnectionError(err)) throw err;
            const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
            onRetry?.({ attempt, delayMs, err });
            await sleep(delayMs);
        }
    }
}
