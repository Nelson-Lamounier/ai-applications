/**
 * @format
 * Cache — Public API.
 *
 * Two redis-backed caches share the redis-cache instance, distinguished by key
 * prefix:
 *   • RedisExactCache — AI-generation exact cache (`aigen:…`), ISemanticCache.
 *   • RedisReadCache  — BFF hot-key read cache (`shared:…`).
 * Plus PgSemanticCache (Postgres+pgvector semantic cache). Both redis caches
 * share the config/factory in redis-client.ts.
 */

export { PgSemanticCache } from './pg-semantic-cache.js';
export type { SemanticCacheConfig } from './pg-semantic-cache.js';
export type {
    ISemanticCache,
    SemanticCacheGetInput,
    SemanticCacheGetResult,
    SemanticCachePutInput,
    SemanticCacheInvalidateInput,
} from './cache-types.js';

// Shared redis client/config (used by both redis-backed caches).
export { resolveRedisCacheConfig, createRedisCacheClient } from './redis-client.js';
export type { RedisCacheConfig, RedisLike } from './redis-client.js';

// AI-generation exact cache.
export { RedisExactCache } from './redis-exact-cache.js';
export type { RedisExactCacheOptions } from './redis-exact-cache.js';

// BFF hot-key read cache.
export { RedisReadCache, projectCaseStudyKey } from './redis-read-cache.js';
export type { CacheMetrics } from './redis-read-cache.js';
