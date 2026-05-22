/**
 * @format
 * Cache — Public API. Semantic response cache (RAG checklist §9).
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

export { RedisExactCache } from './redis-exact-cache.js';
export type { RedisExactCacheOptions } from './redis-exact-cache.js';
export {
    resolveRedisCacheConfig,
    createRedisCacheClient,
} from './redis-client.js';
export type { RedisCacheConfig, RedisLike } from './redis-client.js';
