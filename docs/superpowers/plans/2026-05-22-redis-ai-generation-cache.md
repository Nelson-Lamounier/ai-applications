# Redis AI-Generation Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the misused `PgSemanticCache` on the case-study K8s job with an exact-key Redis cache, and add the same caching to the clustering job (which has none), backed by the cluster's existing `redis-cache` instance.

**Architecture:** New `RedisExactCache` implements the existing `ISemanticCache` interface using `ioredis` GET/SETEX on a content-hash key. Case-study needs only its injected implementation swapped (orchestrator already coded against the interface). Clustering gains an input hash plus get/put. Everything is fail-open: absent or unreachable Redis silently disables the cache and jobs run exactly as today.

**Tech Stack:** TypeScript 5.9 (ESM, `.js` import specifiers), Node 22, Yarn 4 workspaces, Jest + ts-jest, `ioredis`, `pg`, `prom-client`.

**Spec:** `docs/superpowers/specs/2026-05-22-redis-ai-generation-cache-design.md`

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `applications/shared/package.json` | Add `ioredis` dependency | Modify |
| `applications/shared/src/cache/redis-client.ts` | `ioredis` factory + `RedisLike` interface, fail-open connection tuning | Create |
| `applications/shared/src/cache/redis-client.test.ts` | Unit test for env→config mapping + disabled detection | Create |
| `applications/shared/src/cache/redis-exact-cache.ts` | `ISemanticCache` impl: exact key, GET/SETEX/SCAN+UNLINK, EMF metrics | Create |
| `applications/shared/src/cache/redis-exact-cache.test.ts` | Unit tests against an injected fake client | Create |
| `applications/shared/src/cache/index.ts` | Re-export the new symbols | Modify |
| `applications/shared/src/index.ts` | Re-export from the package barrel | Modify |
| `applications/shared/src/projects/clustering-orchestrator.ts` | Add `computeClusteringInputHash` + cache get/put | Modify |
| `applications/shared/src/projects/clustering-orchestrator.test.ts` | Test hash stability + cache hit/miss flow | Create (or extend) |
| `applications/job-strategist/src/run-case-study.ts` | Swap `PgSemanticCache` → `RedisExactCache` | Modify |
| `applications/job-strategist/src/run-clustering.ts` | Inject cache, add `cache_hit` outcome | Modify |

**Design notes that lock decisions:**

- **Key schema:** `${prefix}:${scope}:${kbTag}:${sha256hex(queryText)}`. `prefix` defaults to `aigen:v1`. `scope` and `kbTag` are kept literal so `invalidate` can `SCAN` by glob. `queryText` (already a content hash at the call sites) is re-hashed to bound key length uniformly.
- **Fail-open via injection:** `RedisExactCache` depends on a minimal `RedisLike` interface, not on `ioredis` directly. Unit tests inject an in-memory fake — no `ioredis-mock` dependency. Production injects a real `ioredis` client from `redis-client.ts`.
- **Disabled when unconfigured:** if `REDIS_CACHE_HOST` is empty, `fromEnvironment` returns a cache whose `get` always misses and `put`/`invalidate` are no-ops — never constructs a client, never logs connection spam.

---

## Task 1: Add the `ioredis` dependency

**Files:**
- Modify: `applications/shared/package.json`

- [ ] **Step 1: Add the dependency**

Edit the `"dependencies"` block of `applications/shared/package.json` to add `ioredis` (keep alphabetical-ish ordering near the other runtime deps such as `pg`):

```json
"ioredis": "^5.4.1",
```

- [ ] **Step 2: Install**

Run: `yarn install`
Expected: lockfile updates, `ioredis` resolves, no errors.

- [ ] **Step 3: Commit**

```bash
git add applications/shared/package.json yarn.lock
git commit -m "chore(cache): add ioredis dependency for redis cache"
```

---

## Task 2: Redis client factory + `RedisLike` interface

**Files:**
- Create: `applications/shared/src/cache/redis-client.ts`
- Test: `applications/shared/src/cache/redis-client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `applications/shared/src/cache/redis-client.test.ts`:

```typescript
/** @format */
import { resolveRedisCacheConfig } from './redis-client.js';

describe('resolveRedisCacheConfig', () => {
    const OLD = process.env;
    beforeEach(() => { process.env = { ...OLD }; });
    afterAll(() => { process.env = OLD; });

    it('returns enabled=false when host is unset', () => {
        delete process.env.REDIS_CACHE_HOST;
        expect(resolveRedisCacheConfig().enabled).toBe(false);
    });

    it('maps env vars to config when host is set', () => {
        process.env.REDIS_CACHE_HOST = 'redis-cache-master.redis-cache.svc.cluster.local';
        process.env.REDIS_CACHE_PORT = '6379';
        process.env.REDIS_CACHE_PASSWORD = 'secret';
        process.env.REDIS_CACHE_TLS = 'false';
        const cfg = resolveRedisCacheConfig();
        expect(cfg).toMatchObject({
            enabled: true,
            host: 'redis-cache-master.redis-cache.svc.cluster.local',
            port: 6379,
            password: 'secret',
            tls: false,
        });
    });

    it('parses REDIS_CACHE_TLS=true as tls:true', () => {
        process.env.REDIS_CACHE_HOST = 'h';
        process.env.REDIS_CACHE_TLS = 'true';
        expect(resolveRedisCacheConfig().tls).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @bedrock/shared exec jest src/cache/redis-client.test.ts`
Expected: FAIL — `resolveRedisCacheConfig` is not exported / module not found.

- [ ] **Step 3: Write the implementation**

Create `applications/shared/src/cache/redis-client.ts`:

```typescript
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
    readonly password: string;
    readonly tls: boolean;
}

export function resolveRedisCacheConfig(): RedisCacheConfig {
    const host = process.env.REDIS_CACHE_HOST ?? '';
    return {
        enabled: host.length > 0,
        host,
        port: Number(process.env.REDIS_CACHE_PORT ?? '6379'),
        password: process.env.REDIS_CACHE_PASSWORD ?? '',
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
        password: cfg.password || undefined,
        tls: cfg.tls ? {} : undefined,
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 2,
        connectTimeout: 1000,
        commandTimeout: 500,
        retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
    }) as unknown as RedisLike;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace @bedrock/shared exec jest src/cache/redis-client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/cache/redis-client.ts applications/shared/src/cache/redis-client.test.ts
git commit -m "feat(cache): add redis client factory and RedisLike interface"
```

---

## Task 3: `RedisExactCache` implementing `ISemanticCache`

**Files:**
- Create: `applications/shared/src/cache/redis-exact-cache.ts`
- Test: `applications/shared/src/cache/redis-exact-cache.test.ts`

- [ ] **Step 1: Write the failing test**

Create `applications/shared/src/cache/redis-exact-cache.test.ts`:

```typescript
/** @format */
import type { RedisLike } from './redis-client.js';
import { RedisExactCache } from './redis-exact-cache.js';

/** In-memory RedisLike with TTL ignored (TTL behaviour is ioredis's job). */
class FakeRedis implements RedisLike {
    store = new Map<string, string>();
    throwOnGet = false;
    async get(key: string): Promise<string | null> {
        if (this.throwOnGet) throw new Error('boom');
        return this.store.has(key) ? this.store.get(key)! : null;
    }
    async set(key: string, value: string): Promise<unknown> {
        this.store.set(key, value);
        return 'OK';
    }
    async scan(
        _cursor: string | number,
        _m: 'MATCH',
        pattern: string,
        _c: 'COUNT',
        _count: number,
    ): Promise<[string, string[]]> {
        const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        return ['0', [...this.store.keys()].filter((k) => re.test(k))];
    }
    async unlink(...keys: string[]): Promise<number> {
        let n = 0;
        for (const k of keys) if (this.store.delete(k)) n++;
        return n;
    }
}

describe('RedisExactCache', () => {
    function make(client: RedisLike): RedisExactCache {
        return new RedisExactCache(client, { ttlSeconds: 100, prefix: 'aigen:v1', enabled: true });
    }

    it('misses on an empty store', async () => {
        const c = make(new FakeRedis());
        const res = await c.get({ scope: 's', kbTag: 'k', queryText: 'q' });
        expect(res.hit).toBe(false);
    });

    it('round-trips a put then get with similarity 1.0', async () => {
        const c = make(new FakeRedis());
        await c.put({ scope: 's', kbTag: 'k', queryText: 'q', response: { a: 1 } });
        const res = await c.get({ scope: 's', kbTag: 'k', queryText: 'q' });
        expect(res).toEqual({ hit: true, response: { a: 1 }, similarity: 1.0 });
    });

    it('keys are deterministic for identical inputs', async () => {
        const f = new FakeRedis();
        const c = make(f);
        await c.put({ scope: 's', kbTag: 'k', queryText: 'q', response: 1 });
        const firstKey = [...f.store.keys()][0];
        await c.put({ scope: 's', kbTag: 'k', queryText: 'q', response: 2 });
        expect([...f.store.keys()]).toEqual([firstKey]);
    });

    it('different queryText yields a different key (natural invalidation)', async () => {
        const f = new FakeRedis();
        const c = make(f);
        await c.put({ scope: 's', kbTag: 'k', queryText: 'q1', response: 1 });
        await c.put({ scope: 's', kbTag: 'k', queryText: 'q2', response: 2 });
        expect(f.store.size).toBe(2);
    });

    it('invalidate by scope deletes matching keys', async () => {
        const f = new FakeRedis();
        const c = make(f);
        await c.put({ scope: 'proj:1', kbTag: 'k', queryText: 'q', response: 1 });
        await c.put({ scope: 'proj:2', kbTag: 'k', queryText: 'q', response: 1 });
        const deleted = await c.invalidate({ scope: 'proj:1' });
        expect(deleted).toBe(1);
        expect(f.store.size).toBe(1);
    });

    it('fails open: get returns miss when the client throws', async () => {
        const f = new FakeRedis();
        f.throwOnGet = true;
        const c = make(f);
        await expect(c.get({ scope: 's', kbTag: 'k', queryText: 'q' })).resolves.toEqual({ hit: false });
    });

    it('disabled cache always misses and never touches the client', async () => {
        const f = new FakeRedis();
        const c = new RedisExactCache(f, { ttlSeconds: 100, prefix: 'aigen:v1', enabled: false });
        await c.put({ scope: 's', kbTag: 'k', queryText: 'q', response: 1 });
        expect(f.store.size).toBe(0);
        expect((await c.get({ scope: 's', kbTag: 'k', queryText: 'q' })).hit).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @bedrock/shared exec jest src/cache/redis-exact-cache.test.ts`
Expected: FAIL — `RedisExactCache` not found.

- [ ] **Step 3: Write the implementation**

Create `applications/shared/src/cache/redis-exact-cache.ts`:

```typescript
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

import { emitEmfMetric } from '../emf.js';
import type {
    ISemanticCache,
    SemanticCacheGetInput,
    SemanticCacheGetResult,
    SemanticCachePutInput,
    SemanticCacheInvalidateInput,
} from './cache-types.js';
import {
    createRedisCacheClient,
    resolveRedisCacheConfig,
    type RedisLike,
} from './redis-client.js';

const NS = 'BedrockSharedSafety';
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
    ) {}

    static fromEnvironment(extra?: Partial<RedisExactCacheOptions>): RedisExactCache {
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
        return new RedisExactCache(client, { ttlSeconds, prefix, enabled });
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
                emitEmfMetric(NS, { Module: 'cache' }, [{ name: 'CacheMiss', value: 1, unit: 'Count' }]);
                return { hit: false };
            }
            emitEmfMetric(NS, { Module: 'cache' }, [{ name: 'CacheHit', value: 1, unit: 'Count' }]);
            return { hit: true, response: JSON.parse(raw), similarity: 1.0 };
        } catch (e) {
            emitEmfMetric(NS, { Module: 'cache' }, [{ name: 'CacheError', value: 1, unit: 'Count' }]);
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
            emitEmfMetric(NS, { Module: 'cache' }, [{ name: 'CacheError', value: 1, unit: 'Count' }]);
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
            emitEmfMetric(NS, { Module: 'cache' }, [{ name: 'CacheError', value: 1, unit: 'Count' }]);
            console.warn('[redis-exact-cache] invalidate failed — no-op:', (e as Error).message);
            return 0;
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace @bedrock/shared exec jest src/cache/redis-exact-cache.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/cache/redis-exact-cache.ts applications/shared/src/cache/redis-exact-cache.test.ts
git commit -m "feat(cache): add RedisExactCache implementing ISemanticCache"
```

---

## Task 4: Export the new symbols from the barrels

**Files:**
- Modify: `applications/shared/src/cache/index.ts`
- Modify: `applications/shared/src/index.ts:354-362`

- [ ] **Step 1: Extend the cache barrel**

Edit `applications/shared/src/cache/index.ts` — after the existing `PgSemanticCache` export add:

```typescript
export { RedisExactCache } from './redis-exact-cache.js';
export type { RedisExactCacheOptions } from './redis-exact-cache.js';
export {
    resolveRedisCacheConfig,
    createRedisCacheClient,
} from './redis-client.js';
export type { RedisCacheConfig, RedisLike } from './redis-client.js';
```

- [ ] **Step 2: Extend the package barrel**

Edit `applications/shared/src/index.ts` in the Cache section (around line 355). After `export { PgSemanticCache } from './cache/index.js';` add:

```typescript
export { RedisExactCache } from './cache/index.js';
```

And add `RedisExactCacheOptions` to the adjacent `export type { ... } from './cache/index.js';` block.

- [ ] **Step 3: Type-check the package**

Run: `yarn workspace @bedrock/shared exec tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 4: Commit**

```bash
git add applications/shared/src/cache/index.ts applications/shared/src/index.ts
git commit -m "feat(cache): export RedisExactCache from shared barrels"
```

---

## Task 5: Swap the case-study job to Redis

**Files:**
- Modify: `applications/job-strategist/src/run-case-study.ts:24-33,127-133`

The orchestrator is unchanged — only the injected implementation and the import.

- [ ] **Step 1: Update the import**

In `applications/job-strategist/src/run-case-study.ts`, in the `@bedrock/shared` import block (lines 24-33), replace `PgSemanticCache,` with `RedisExactCache,` (keep alphabetical position; it sits before `bedrockCaseStudyAgent`).

- [ ] **Step 2: Swap the cache construction**

Replace lines 127-133:

```typescript
        const cache    = PgSemanticCache.fromEnvironment({
            host:     env.pg.host,
            port:     env.pg.port,
            database: env.pg.database,
            user:     env.pg.user,
            password: env.pg.password,
        });
```

with:

```typescript
        // Exact-key Redis cache. Reads REDIS_CACHE_* from env; disabled (and
        // therefore a no-op) when REDIS_CACHE_HOST is unset, so the job is
        // safe to deploy ahead of the cluster-side Redis wiring.
        const cache = RedisExactCache.fromEnvironment();
```

- [ ] **Step 3: Build the workspace**

Run: `yarn workspace job-strategist exec tsc --noEmit`
Expected: PASS — `cache` still satisfies the orchestrator's `ISemanticCache` parameter.

- [ ] **Step 4: Run the existing case-study test suite**

Run: `yarn workspace @bedrock/shared exec jest src/projects/`
Expected: PASS — orchestrator behaviour is unchanged (it was always interface-typed).

- [ ] **Step 5: Commit**

```bash
git add applications/job-strategist/src/run-case-study.ts
git commit -m "feat(job-strategist): use RedisExactCache for case-study cache"
```

---

## Task 6: Add caching to the clustering orchestrator

**Files:**
- Modify: `applications/shared/src/projects/clustering-orchestrator.ts`
- Test: `applications/shared/src/projects/clustering-orchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

Create (or extend) `applications/shared/src/projects/clustering-orchestrator.test.ts`:

```typescript
/** @format */
import { computeClusteringInputHash } from './clustering-orchestrator.js';
import type { RepoClusteringDigest, ClusteringSignals } from './types.js';

function digest(id: string, stack: string[]): RepoClusteringDigest {
    return {
        repositoryId: id,
        fullName: `owner/${id}`,
        shortName: id,
        primaryLanguage: 'TypeScript',
        topics: ['web'],
        firstSeenAt: null,
        lastSyncedAt: null,
        techStack: stack,
        classification: 'single_repo',
    };
}

const emptySignals: ClusteringSignals = {
    namingPrefixes: new Map(),
    sharedTopics: new Map(),
    sharedTechStack: new Map(),
    embeddingPairs: [],
};

describe('computeClusteringInputHash', () => {
    it('is stable for identical inputs regardless of digest order', () => {
        const a = computeClusteringInputHash([digest('a', ['react']), digest('b', ['node'])], emptySignals);
        const b = computeClusteringInputHash([digest('b', ['node']), digest('a', ['react'])], emptySignals);
        expect(a).toBe(b);
    });

    it('changes when a digest tech stack changes', () => {
        const a = computeClusteringInputHash([digest('a', ['react'])], emptySignals);
        const b = computeClusteringInputHash([digest('a', ['vue'])], emptySignals);
        expect(a).not.toBe(b);
    });

    it('changes when an embedding pair changes', () => {
        const a = computeClusteringInputHash([digest('a', ['react'])], emptySignals);
        const b = computeClusteringInputHash([digest('a', ['react'])], {
            ...emptySignals,
            embeddingPairs: [{ repoA: 'owner/a', repoB: 'owner/b', score: 0.9 }],
        });
        expect(a).not.toBe(b);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @bedrock/shared exec jest src/projects/clustering-orchestrator.test.ts`
Expected: FAIL — `computeClusteringInputHash` not exported.

- [ ] **Step 3: Implement the hash + cache wiring**

Edit `applications/shared/src/projects/clustering-orchestrator.ts`:

3a. Add imports at the top (after the existing `import type { Pool }`):

```typescript
import { createHash } from 'node:crypto';

import type { ISemanticCache } from '../cache/cache-types.js';
import { ClusteringResultSchema } from './types.js';
```

(Adjust the existing `import type { ClusteringResult, RepoClusteringDigest } from './types.js';` to also pull `ClusteringSignals` if not already imported, and import the runtime `ClusteringResultSchema` value as shown.)

3b. Add the exported hash function (after the imports, before `runClusteringOrchestration`):

```typescript
const CACHE_SCOPE_PREFIX = 'clustering';

/**
 * Stable hash over the exact inputs the clustering agent sees: the per-repo
 * digests (sorted by id) and the deterministic signal block. Identical
 * inputs hash identically so we can serve the prior result from the cache
 * instead of re-invoking Haiku.
 */
export function computeClusteringInputHash(
    digests: readonly RepoClusteringDigest[],
    signals: ClusteringSignals,
): string {
    const h = createHash('sha256');
    const sorted = [...digests].sort((a, b) => a.repositoryId.localeCompare(b.repositoryId));
    for (const d of sorted) {
        h.update(d.repositoryId);
        h.update(d.fullName);
        h.update(d.primaryLanguage ?? '');
        h.update([...d.topics].sort().join(','));
        h.update([...d.techStack].sort().join(','));
        h.update(d.classification ?? '');
    }
    const pairs = [...signals.embeddingPairs]
        .map((p) => `${p.repoA}|${p.repoB}|${p.score.toFixed(4)}`)
        .sort();
    for (const p of pairs) h.update(p);
    return h.digest('hex');
}
```

3c. Extend `RunClusteringInput` with optional cache fields:

```typescript
export interface RunClusteringInput {
    readonly userId:        string;
    readonly pipelineRunId: string;
    readonly agent:         ClusteringAgent;
    readonly ctx:           BasePipelineContext;
    readonly cache?:        ISemanticCache;
    readonly kbTag?:        string;
}
```

3d. Extend `RunClusteringOutput`:

```typescript
export interface RunClusteringOutput {
    readonly digests:    readonly RepoClusteringDigest[];
    readonly result:     ClusteringResult;
    readonly persisted:  PersistClusteringSummary;
    readonly cacheHit:   boolean;
    readonly inputHash:  string;
}
```

3e. In the `< 2 digests` short-circuit branch, add `cacheHit: false` and `inputHash: ''` to the returned object.

3f. Replace the agent-invocation section (currently `const { data: result } = await input.agent.invoke(...)` through persistence) with cache-aware logic:

```typescript
    const embeddings = await loadDescriptionEmbeddings(pool, input.userId);
    const signals    = buildClusteringSignals(digests, embeddings);

    const inputHash  = computeClusteringInputHash(digests, signals);
    const cacheScope = `${CACHE_SCOPE_PREFIX}:${input.userId}`;
    const kbTag      = input.kbTag ?? 'default';

    // 1. Try the cache.
    let result: ClusteringResult | undefined;
    let cacheHit = false;
    if (input.cache) {
        try {
            const hit = await input.cache.get({ scope: cacheScope, kbTag, queryText: inputHash });
            if (hit.hit && hit.response) {
                const parsed = ClusteringResultSchema.safeParse(hit.response);
                if (parsed.success) {
                    result = parsed.data;
                    cacheHit = true;
                }
            }
        } catch {
            // Cache failures are non-fatal — fall through to a fresh run.
        }
    }

    // 2. Run the agent if the cache missed.
    if (!result) {
        const agentResult = await input.agent.invoke(digests, signals, input.ctx);
        result = agentResult.data;
    }

    const client = await pool.connect();
    let persisted: PersistClusteringSummary;
    try {
        persisted = await persistClusteringResult(client, {
            userId:        input.userId,
            pipelineRunId: input.pipelineRunId,
            result,
        });
    } finally {
        client.release();
    }

    // 3. Update the cache. Fail-open — never throw on a cache put.
    if (input.cache && !cacheHit) {
        try {
            await input.cache.put({ scope: cacheScope, kbTag, queryText: inputHash, response: result });
        } catch {
            // ignore
        }
    }

    return { digests, result, persisted, cacheHit, inputHash };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn workspace @bedrock/shared exec jest src/projects/clustering-orchestrator.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Type-check**

Run: `yarn workspace @bedrock/shared exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add applications/shared/src/projects/clustering-orchestrator.ts applications/shared/src/projects/clustering-orchestrator.test.ts
git commit -m "feat(projects): add exact-key caching to clustering orchestrator"
```

---

## Task 7: Wire the cache into the clustering job

**Files:**
- Modify: `applications/job-strategist/src/run-clustering.ts:25-32,60-64,87-92,108-117`

- [ ] **Step 1: Update imports**

In the `@bedrock/shared` import block, add `RedisExactCache,` (alphabetically before `bedrockClusteringAgent`).

- [ ] **Step 2: Widen the outcome union**

Change line 64:

```typescript
    let outcome: 'success' | 'skipped' | 'failed' | 'cache_hit' = 'failed';
```

- [ ] **Step 3: Construct + inject the cache**

In the orchestration call (lines 87-92), construct the cache just above it and pass it through:

```typescript
        const cache = RedisExactCache.fromEnvironment();

        const out = await runClusteringOrchestration(pool, {
            userId:        env.userId,
            pipelineRunId: env.pipelineRunId,
            agent:         bedrockClusteringAgent,
            ctx,
            cache,
            kbTag:         env.environment,
        });
```

- [ ] **Step 4: Record cache outcome + metadata**

After the orchestration call, set the outcome from `out.cacheHit` (replace the unconditional `outcome = 'success'` at line 109):

```typescript
        outcome = out.cacheHit ? 'cache_hit' : 'success';
```

And add `cacheHit` + `inputHash` to the `updatePipelineRunMetadata` object (lines 96-106):

```typescript
            cacheHit:               out.cacheHit,
            inputHash:              out.inputHash,
```

- [ ] **Step 5: Type-check**

Run: `yarn workspace job-strategist exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add applications/job-strategist/src/run-clustering.ts
git commit -m "feat(job-strategist): wire RedisExactCache into clustering job"
```

---

## Task 8: Workspace-wide verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `yarn workspaces foreach -A run test`
Expected: PASS across `@bedrock/shared` and `job-strategist`.

- [ ] **Step 2: Type-check all**

Run: `yarn workspaces foreach -A exec tsc --noEmit` (or the repo's `tsc -b`)
Expected: PASS.

- [ ] **Step 3: Lint changed files**

Run the repo's lint command on the changed paths (see `applications/ai-applications-lint-debt` context — locate the eslint config first if no `lint` script exists).
Expected: zero new errors.

---

## Task 9: End-to-end verification against live cluster Redis

**Files:** none (manual / scripted verification). Run after Tasks 1-8 land.

- [ ] **Step 1: Port-forward the cluster cache**

Run: `kubectl port-forward svc/redis-cache-master -n redis-cache 6379:6379`
Expected: `Forwarding from 127.0.0.1:6379 -> 6379`. Leave running in a second terminal.

- [ ] **Step 2: Fetch the Redis password**

Run:
```bash
kubectl get secret redis-cache-auth -n redis-cache -o jsonpath='{.data.redis-password}' | base64 -d
```
Expected: the password string (no newline).

- [ ] **Step 3: Run the case-study E2E twice**

Set env: `REDIS_CACHE_HOST=127.0.0.1 REDIS_CACHE_PORT=6379 REDIS_CACHE_PASSWORD=<from step 2> REDIS_CACHE_TLS=false` plus the existing PG/GitHub env the script needs.

Run `scripts/test-projects-case-study.ts` twice for the same project.
Expected: run 1 generates (`cacheHit: false`); run 2 returns `cacheHit: true` and makes no Bedrock call.

- [ ] **Step 4: Run the clustering E2E twice**

Same Redis env. Run `scripts/test-projects-clustering.ts` twice for the same user.
Expected: run 2 returns `cacheHit: true`, no Bedrock call.

- [ ] **Step 5: Confirm keys in Redis**

Run: `redis-cli -h 127.0.0.1 -a <password> KEYS 'aigen:v1:*'`
Expected: keys for both `aigen:v1:casestudy:...` and `aigen:v1:clustering:...`.

---

## Cluster wiring handoff (separate repo — not in this plan)

These changes land in `kubernetes-bootstrap` (`charts/job-strategist/`), not this repo. Document and hand off:

- `ExternalSecret` in the `job-strategist` namespace → SSM `/k8s/development/redis-cache-auth` (key `password`) → K8s secret `redis-cache-auth` / `redis-password`.
- Job env: `REDIS_CACHE_HOST=redis-cache-master.redis-cache.svc.cluster.local`, `REDIS_CACHE_PORT=6379`, `REDIS_CACHE_TLS=false`, `REDIS_CACHE_PASSWORD` from the secret.
- NetworkPolicy egress `job-strategist → redis-cache:6379` if NetworkPolicies are enforced.

Until this lands, the jobs run with the cache disabled (no-op) — no behaviour change, no errors.
