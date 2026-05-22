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

// Single config snapshot shared by both the TTL export and the lazy singleton.
const _cfg = resolveRedisCacheConfig();

export const READ_CACHE_DEFAULT_TTL = _cfg.defaultTtlSeconds;

let _cache: RedisReadCache | undefined;

/** Lazy singleton — one ioredis connection per process, reused across requests. */
export function getReadCache(): RedisReadCache {
  if (!_cache) {
    if (!_cfg.enabled) {
      // Disabled: always a miss (null) so result="miss" not result="error".
      // This keeps result="error" as a reliable real-fault signal on dashboards.
      const disabled: RedisLike = {
        get:  async () => null,                                   // disabled ⇒ always a miss
        set:  async () => undefined,                              // no-op write
        del:  async () => 0,
        scan: async () => ['0', [] as string[]] as [string, string[]],
      };
      _cache = new RedisReadCache(disabled, _cfg.defaultTtlSeconds, metrics);
    } else {
      _cache = new RedisReadCache(createRedisClient(_cfg), _cfg.defaultTtlSeconds, metrics);
    }
  }
  return _cache;
}
