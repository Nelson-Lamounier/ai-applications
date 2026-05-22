/**
 * @format
 * RedisReadCache — exact-key, fail-open read-through cache over redis-cache.
 *
 * Backs BFF hot-read paths (NOT the AI-generation semantic cache, which is
 * Postgres+pgvector; see CONTEXT.md). Fail-open: a missing host or any Redis
 * error degrades to a cache miss / no-op — the cache must never throw into a
 * host request. Cross-app entities use the unprefixed `shared:` key scheme so
 * the writing app can invalidate the reading app's entry.
 */
import Redis, { type RedisOptions } from 'ioredis';

export interface RedisCacheConfig {
    readonly enabled: boolean;
    readonly host: string;
    readonly port: number;
    readonly password: string | undefined;
    readonly tls: boolean;
    readonly defaultTtlSeconds: number;
}

/** Telemetry sink — apps inject adapters that bump their own counters. */
export interface CacheMetrics {
    onHit?(cache: string): void;
    onMiss?(cache: string): void;
    onError?(cache: string): void;
}

export function resolveRedisCacheConfig(): RedisCacheConfig {
    const host = process.env.REDIS_CACHE_HOST ?? '';
    return {
        enabled: host !== '',
        host,
        port: Number(process.env.REDIS_CACHE_PORT ?? '6379'),
        password: process.env.REDIS_CACHE_PASSWORD || undefined,
        tls: (process.env.REDIS_CACHE_TLS ?? 'false') === 'true',
        defaultTtlSeconds: Number(process.env.REDIS_CACHE_DEFAULT_TTL_SECONDS ?? '3600'),
    };
}

/** Subset of ioredis the cache depends on — lets tests inject a fake. */
export interface RedisLike {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
    del(...keys: string[]): Promise<number>;
    scan(cursor: string | number, matchToken: 'MATCH', pattern: string, countToken: 'COUNT', count: number): Promise<[string, string[]]>;
}

/**
 * Build an ioredis client tuned to fail fast / fail open: no offline queue,
 * a capped retry budget, and a bounded command timeout so a slow or down
 * Redis degrades to a miss instead of stalling the request.
 */
export function createRedisClient(cfg: RedisCacheConfig): RedisLike {
    const opts: RedisOptions = {
        host: cfg.host,
        port: cfg.port,
        password: cfg.password,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 1000,
        commandTimeout: 200,
        lazyConnect: false,
        ...(cfg.tls ? { tls: {} } : {}),
    };
    const client = new Redis(opts);
    client.on('error', () => { /* fail-open; surfaced via onError at call sites */ });
    return client as unknown as RedisLike;
}

export class RedisReadCache {
    constructor(
        private readonly client: RedisLike,
        private readonly defaultTtlSeconds: number,
        private readonly metrics: CacheMetrics = {},
    ) {}

    /**
     * Return the cached JSON value for `key`, or compute it, store it with
     * `ttlSeconds` (defaulting to the configured default), and return it.
     * Fail-open: any Redis error falls through to `compute()`.
     * `cacheName` is the metrics label (low cardinality, e.g. 'project_case_study').
     */
    async getOrCompute<T>(
        key: string,
        ttlSeconds: number,
        compute: () => Promise<T>,
        cacheName: string,
    ): Promise<T> {
        try {
            const cached = await this.client.get(key);
            if (cached !== null) {
                this.metrics.onHit?.(cacheName);
                return JSON.parse(cached) as T;
            }
            this.metrics.onMiss?.(cacheName);
        } catch {
            this.metrics.onError?.(cacheName);
            return compute();
        }
        const fresh = await compute();
        try {
            await this.client.set(key, JSON.stringify(fresh), 'EX', ttlSeconds || this.defaultTtlSeconds);
        } catch {
            this.metrics.onError?.(cacheName);
        }
        return fresh;
    }

    /** Explicit write. Fail-open. */
    async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
        try {
            await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds ?? this.defaultTtlSeconds);
        } catch { /* fail-open */ }
    }

    /** Delete one key. Returns count deleted (0 on error). */
    async invalidate(key: string): Promise<number> {
        try {
            return await this.client.del(key);
        } catch {
            return 0;
        }
    }

    /** Delete keys matching a glob via non-blocking SCAN. Returns count (0 on error). */
    async invalidatePattern(pattern: string): Promise<number> {
        try {
            let cursor = '0';
            let total = 0;
            do {
                const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
                cursor = next;
                if (keys.length > 0) total += await this.client.del(...keys);
            } while (cursor !== '0');
            return total;
        } catch {
            return 0;
        }
    }
}

/**
 * Canonical cross-app key for a project case study. Used identically by the
 * reader (public-api) and the writer (admin-api). See the shared-key ADR.
 */
export function projectCaseStudyKey(projectId: string): string {
    return `shared:project:case_study:${projectId}:v1`;
}
