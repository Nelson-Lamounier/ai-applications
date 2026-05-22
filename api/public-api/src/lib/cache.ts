/**
 * @file cache.ts
 * @description Process-wide RedisReadCache singleton for public-api, wired to
 * the prom-client counter. Fail-open: if REDIS_CACHE_HOST is unset the cache
 * is a no-op pass-through (getOrCompute always computes).
 */
import {
  RedisReadCache,
  resolveRedisCacheConfig,
  createRedisClient,
  type CacheMetrics,
  type RedisLike,
} from '@bedrock/shared';
import { redisCacheRequestsTotal } from './metrics.js';

const metrics: CacheMetrics = {
  onHit:   (cache) => redisCacheRequestsTotal.inc({ cache, result: 'hit' }),
  onMiss:  (cache) => redisCacheRequestsTotal.inc({ cache, result: 'miss' }),
  onError: (cache) => redisCacheRequestsTotal.inc({ cache, result: 'error' }),
};

let _cache: RedisReadCache | undefined;

/** Lazy singleton — one ioredis connection per process, reused across requests. */
export function getReadCache(): RedisReadCache {
  if (!_cache) {
    const cfg = resolveRedisCacheConfig();
    if (!cfg.enabled) {
      // Disabled: a client whose every command rejects → fail-open compute path.
      const disabled: RedisLike = {
        get:  async () => { throw new Error('cache disabled'); },
        set:  async () => { throw new Error('cache disabled'); },
        del:  async () => 0,
        scan: async () => ['0', [] as string[]] as [string, string[]],
      };
      _cache = new RedisReadCache(disabled, cfg.defaultTtlSeconds, metrics);
    } else {
      _cache = new RedisReadCache(createRedisClient(cfg), cfg.defaultTtlSeconds, metrics);
    }
  }
  return _cache;
}

export const READ_CACHE_DEFAULT_TTL = resolveRedisCacheConfig().defaultTtlSeconds;
