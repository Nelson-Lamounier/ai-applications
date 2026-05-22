/** @format */
import { resolveRedisCacheConfig, RedisReadCache, projectCaseStudyKey, type RedisLike } from './redis-read-cache.js';

function fakeRedis(): RedisLike & { store: Map<string, string> } {
    const store = new Map<string, string>();
    return {
        store,
        async get(k) { return store.get(k) ?? null; },
        async set(k, v) { store.set(k, v); return 'OK'; },
        async del(...keys) { let n = 0; for (const k of keys) { if (store.delete(k)) n++; } return n; },
        async scan(_cursor, _m, pattern) {
            const toRe = (g: string) => new RegExp('^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
            const re = toRe(pattern);
            return ['0', [...store.keys()].filter((k) => re.test(k))];
        },
    };
}

describe('resolveRedisCacheConfig', () => {
    const ENV = process.env;
    beforeEach(() => { process.env = { ...ENV }; });
    afterEach(() => { process.env = ENV; });

    it('is disabled (fail-open) when REDIS_CACHE_HOST is unset', () => {
        delete process.env.REDIS_CACHE_HOST;
        const cfg = resolveRedisCacheConfig();
        expect(cfg.enabled).toBe(false);
    });

    it('parses host/port/password and defaults', () => {
        process.env.REDIS_CACHE_HOST = 'redis-cache-master.redis-cache.svc.cluster.local';
        process.env.REDIS_CACHE_PASSWORD = 'secret';
        delete process.env.REDIS_CACHE_PORT;
        delete process.env.REDIS_CACHE_TLS;
        delete process.env.REDIS_CACHE_DEFAULT_TTL_SECONDS;
        const cfg = resolveRedisCacheConfig();
        expect(cfg).toMatchObject({
            enabled: true,
            host: 'redis-cache-master.redis-cache.svc.cluster.local',
            port: 6379,
            password: 'secret',
            tls: false,
            defaultTtlSeconds: 3600,
        });
    });

    it('parses REDIS_CACHE_TLS=true as tls:true', () => {
        process.env.REDIS_CACHE_HOST = 'h';
        process.env.REDIS_CACHE_TLS = 'true';
        expect(resolveRedisCacheConfig().tls).toBe(true);
    });
});

describe('RedisReadCache', () => {
    it('computes and stores on miss, then serves from cache on hit', async () => {
        const r = fakeRedis();
        const hits: string[] = []; const misses: string[] = [];
        const cache = new RedisReadCache(r, 3600, { onHit: (c) => hits.push(c), onMiss: (c) => misses.push(c) });
        let computed = 0;
        const compute = async () => { computed++; return { v: 42 }; };

        const a = await cache.getOrCompute('k1', 60, compute, 'proj');
        const b = await cache.getOrCompute('k1', 60, compute, 'proj');

        expect(a).toEqual({ v: 42 });
        expect(b).toEqual({ v: 42 });
        expect(computed).toBe(1);
        expect(misses).toEqual(['proj']);
        expect(hits).toEqual(['proj']);
    });

    it('invalidate deletes the key', async () => {
        const r = fakeRedis();
        const cache = new RedisReadCache(r, 3600, {});
        await cache.getOrCompute('k1', 60, async () => 1, 'proj');
        expect(r.store.has('k1')).toBe(true);
        const n = await cache.invalidate('k1');
        expect(n).toBe(1);
        expect(r.store.has('k1')).toBe(false);
    });

    it('fail-open: a throwing client degrades to compute, never throws', async () => {
        const broken: RedisLike = {
            get: async () => { throw new Error('down'); },
            set: async () => { throw new Error('down'); },
            del: async () => { throw new Error('down'); },
            scan: async () => { throw new Error('down'); },
        };
        const errors: string[] = [];
        const cache = new RedisReadCache(broken, 3600, { onError: (c) => errors.push(c) });
        const v = await cache.getOrCompute('k1', 60, async () => 'fresh', 'proj');
        expect(v).toBe('fresh');
        await expect(cache.invalidate('k1')).resolves.toBe(0);
        expect(errors.length).toBeGreaterThan(0);
    });

    it('invalidatePattern deletes only matching keys', async () => {
        const r = fakeRedis();
        const cache = new RedisReadCache(r, 3600, {});
        await cache.set('shared:project:case_study:a:v1', 1);
        await cache.set('shared:project:case_study:b:v1', 2);
        await cache.set('other:key', 3);
        const n = await cache.invalidatePattern('shared:project:case_study:*');
        expect(n).toBe(2);
        expect(r.store.has('other:key')).toBe(true);
        expect(r.store.has('shared:project:case_study:a:v1')).toBe(false);
    });

    it('fail-open on corrupt cached JSON: evicts, recomputes, fires onError', async () => {
        const r = fakeRedis();
        const errors: string[] = [];
        const cache = new RedisReadCache(r, 3600, { onError: (c) => errors.push(c) });
        r.store.set('k1', 'not-json{');
        const v = await cache.getOrCompute('k1', 60, async () => ({ ok: true }), 'proj');
        expect(v).toEqual({ ok: true });
        expect(errors).toContain('proj');
        // corrupt value was evicted then replaced with the fresh computed value
        expect(JSON.parse(r.store.get('k1')!)).toEqual({ ok: true });
    });
});

describe('projectCaseStudyKey (cross-repo contract)', () => {
  it('is shared:project:case_study:{id}:v1', () => {
    expect(projectCaseStudyKey('abc-123')).toBe('shared:project:case_study:abc-123:v1');
  });
});
