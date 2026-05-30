/**
 * @format
 * RedisExactCache — exact-key response cache implementing ISemanticCache.
 *
 * For deterministic inputs (a content hash as queryText) an exact GET is the
 * right primitive: no embedding call, no pgvector query. Key embeds the
 * content hash so an input change rotates the key — invalidation for free.
 * Fail-open: every error path degrades to miss / no-op and emits CacheError.
 */
import { createHash } from 'node:crypto';

import type {
    ISemanticCache,
    SemanticCacheGetInput,
    SemanticCacheGetResult,
    SemanticCachePutInput,
    SemanticCacheInvalidateInput,
    CacheMetrics,
} from './cache-types.js';
import {
    createRedisCacheClient,
    resolveRedisCacheConfig,
    type RedisLike,
} from './redis-client.js';

const SCAN_COUNT = 256;

export interface RedisExactCacheOptions {
    readonly ttlSeconds: number;
    readonly prefix: string;
    readonly enabled: boolean;
}

export class RedisExactCache implements ISemanticCache {
    constructor(
        private readonly client: RedisLike,
        private readonly opts: RedisExactCacheOptions,
        // Telemetry sink — caller bumps its own Prometheus counters. `cache` is
        // the metric label; we pass the entry's scope so the caller can keep or
        // override it with a stable cache name.
        private readonly metrics: CacheMetrics = {},
    ) {}

    /** Whether the cache is wired to a live Redis (false = fail-open no-op). */
    get enabled(): boolean { return this.opts.enabled; }

    static fromEnvironment(
        extra?: Partial<RedisExactCacheOptions> & { metrics?: CacheMetrics },
    ): RedisExactCache {
        const cfg = resolveRedisCacheConfig();
        const ttlSeconds = extra?.ttlSeconds
            ?? Number(process.env.REDIS_AIGEN_TTL_SECONDS ?? '2592000');
        const prefix = extra?.prefix ?? 'aigen:v1';
        const enabled = extra?.enabled ?? cfg.enabled;
        // When disabled we still need a client object to satisfy the field,
        // but no command is ever issued (guarded by `enabled`).
        const client: RedisLike = enabled
            ? createRedisCacheClient(cfg)
            : ({} as RedisLike);
        if (!enabled) {
            console.warn('[redis-exact-cache] REDIS_CACHE_HOST unset — cache disabled (jobs run uncached)');
        }
        return new RedisExactCache(client, { ttlSeconds, prefix, enabled }, extra?.metrics ?? {});
    }

    private key(scope: string, kbTag: string, queryText: string): string {
        const hash = createHash('sha256').update(queryText).digest('hex');
        return `${this.opts.prefix}:${scope}:${kbTag}:${hash}`;
    }

    async get(input: SemanticCacheGetInput): Promise<SemanticCacheGetResult> {
        if (!this.opts.enabled) return { hit: false };
        try {
            const raw = await this.client.get(this.key(input.scope, input.kbTag, input.queryText));
            if (raw === null) {
                this.metrics.onMiss?.(input.scope);
                return { hit: false };
            }
            this.metrics.onHit?.(input.scope);
            return { hit: true, response: JSON.parse(raw), similarity: 1 };
        } catch (e) {
            this.metrics.onError?.(input.scope);
            console.warn('[redis-exact-cache] get failed — treating as miss:', (e as Error).message);
            return { hit: false };
        }
    }

    async put(input: SemanticCachePutInput): Promise<void> {
        if (!this.opts.enabled) return;
        try {
            await this.client.set(
                this.key(input.scope, input.kbTag, input.queryText),
                JSON.stringify(input.response),
                'EX',
                this.opts.ttlSeconds,
            );
        } catch (e) {
            this.metrics.onError?.(input.scope);
            console.warn('[redis-exact-cache] put failed — skipping store:', (e as Error).message);
        }
    }

    async invalidate(input: SemanticCacheInvalidateInput): Promise<number> {
        if (!this.opts.enabled) return 0;
        try {
            const pattern = `${this.opts.prefix}:${input.scope ?? '*'}:${input.kbTag ?? '*'}:*`;
            let cursor = '0';
            let deleted = 0;
            do {
                const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
                cursor = next;
                if (keys.length > 0) deleted += await this.client.unlink(...keys);
            } while (cursor !== '0');
            return deleted;
        } catch (e) {
            this.metrics.onError?.(input.scope ?? '*');
            console.warn('[redis-exact-cache] invalidate failed — no-op:', (e as Error).message);
            return 0;
        }
    }
}
