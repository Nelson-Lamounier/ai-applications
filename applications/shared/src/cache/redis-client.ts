/**
 * @format
 * Redis client factory for the AI-generation cache. Reads REDIS_CACHE_*
 * env, returns a fail-open ioredis client. When REDIS_CACHE_HOST is unset
 * the cache is considered disabled and no client is constructed.
 */
import Redis from 'ioredis';

/** The subset of ioredis RedisExactCache depends on — lets tests inject a fake. */
export interface RedisLike {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
    scan(
        cursor: string | number,
        matchToken: 'MATCH',
        pattern: string,
        countToken: 'COUNT',
        count: number,
    ): Promise<[string, string[]]>;
    unlink(...keys: string[]): Promise<number>;
}

export interface RedisCacheConfig {
    readonly enabled: boolean;
    readonly host: string;
    readonly port: number;
    readonly password: string | undefined;
    readonly tls: boolean;
}

export function resolveRedisCacheConfig(): RedisCacheConfig {
    const host = process.env.REDIS_CACHE_HOST ?? '';
    const parsedPort = Number(process.env.REDIS_CACHE_PORT ?? '6379');
    return {
        enabled: host.length > 0,
        host,
        port: Number.isFinite(parsedPort) ? parsedPort : 6379,
        password: process.env.REDIS_CACHE_PASSWORD || undefined,
        tls: (process.env.REDIS_CACHE_TLS ?? 'false') === 'true',
    };
}

/**
 * Build an ioredis client tuned to fail fast / fail open: no offline queue,
 * a capped retry budget, and a bounded command timeout so a slow or down
 * Redis degrades to a cache miss instead of stalling the job.
 */
export function createRedisCacheClient(cfg: RedisCacheConfig): RedisLike {
    return new Redis({
        host: cfg.host,
        port: cfg.port,
        password: cfg.password,
        tls: cfg.tls ? {} : undefined,
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 2,
        connectTimeout: 1000,
        commandTimeout: 500,
        retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
    }) as unknown as RedisLike;
}
