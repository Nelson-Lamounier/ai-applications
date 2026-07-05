/**
 * @format
 * RedisReadCache — exact-key, fail-open read-through cache over redis-cache.
 *
 * Backs BFF hot-read paths (e.g. public-api project case studies). Shares the
 * redis-cache instance with the AI-generation exact cache (RedisExactCache),
 * distinguished by key prefix: read-cache keys are `shared:…`, AI-gen keys are
 * `aigen:…`. Reuses the shared client/config from redis-client.ts.
 *
 * Fail-open: a missing host or any Redis error degrades to a cache miss / no-op
 * — the cache must never throw into a host request. Cross-app entities use the
 * unprefixed `shared:` key scheme so the writing app can invalidate the reading
 * app's entry.
 */
import { type RedisLike } from './redis-client.js';
import type { CacheMetrics } from './cache-types.js';

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
                try {
                    const parsed = JSON.parse(cached) as T;
                    this.metrics.onHit?.(cacheName);
                    return parsed;
                } catch (err) {
                    // Corrupt cached value — evict and fall through to recompute.
                    console.warn('[redis-read-cache] corrupt cached value — evicting:', err);
                    this.metrics.onError?.(cacheName);
                    await this.client.unlink(key).catch(() => { /* fail-open */ });
                }
            }
            this.metrics.onMiss?.(cacheName);
        } catch (err) {
            console.warn('[redis-read-cache] get failed — treating as miss:', err);
            this.metrics.onError?.(cacheName);
            return compute();
        }
        const fresh = await compute();
        try {
            await this.client.set(key, JSON.stringify(fresh), 'EX', ttlSeconds > 0 ? ttlSeconds : this.defaultTtlSeconds);
        } catch (err) {
            console.warn('[redis-read-cache] set failed — value not cached:', err);
            this.metrics.onError?.(cacheName);
        }
        return fresh;
    }

    /** Explicit write. Fail-open. */
    async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
        try {
            await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds !== undefined && ttlSeconds > 0 ? ttlSeconds : this.defaultTtlSeconds);
        } catch { /* fail-open */ }
    }

    /** Delete one key (non-blocking UNLINK). Returns count removed (0 on error). */
    async invalidate(key: string): Promise<number> {
        try {
            return await this.client.unlink(key);
        } catch (err) {
            console.warn('[redis-read-cache] invalidate failed:', err);
            return 0;
        }
    }

    /** Delete keys matching a glob via non-blocking SCAN + UNLINK. Returns count (0 on error). */
    async invalidatePattern(pattern: string): Promise<number> {
        let cursor = '0';
        let total = 0;
        try {
            do {
                const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
                cursor = next;
                if (keys.length > 0) total += await this.client.unlink(...keys);
            } while (cursor !== '0');
            return total;
        } catch (err) {
            console.warn('[redis-read-cache] invalidatePattern failed:', err);
            return total;
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

/**
 * Canonical key for a user's PUBLIC project list (the portfolio /projects
 * grid). Keyed by github username rather than user id because the reader
 * (public-api) resolves identity through oauth_connections.username and
 * never touches the internal id. Writers that flip project visibility
 * should invalidate this alongside projectCaseStudyKey; until they do,
 * staleness is bounded by the read-cache TTL (5 minutes), which matches
 * the route's s-maxage.
 */
export function projectPublicListKey(username: string): string {
    return `shared:project:public_list:${username.toLowerCase()}:v1`;
}
