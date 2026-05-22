/** @format */
import type { RedisLike } from './redis-client.js';
import { RedisExactCache } from './redis-exact-cache.js';

/** In-memory RedisLike with TTL ignored (TTL behaviour is ioredis's job). */
class FakeRedis implements RedisLike {
    store = new Map<string, string>();
    throwOnGet = false;
    throwOnSet = false;
    throwOnScan = false;
    async get(key: string): Promise<string | null> {
        if (this.throwOnGet) throw new Error('boom');
        return this.store.has(key) ? this.store.get(key)! : null;
    }
    async set(key: string, value: string, _mode: 'EX', _ttl: number): Promise<unknown> {
        if (this.throwOnSet) throw new Error('boom');
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
        if (this.throwOnScan) throw new Error('boom');
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

    it('fails open: put is a no-op when the client throws', async () => {
        const f = new FakeRedis();
        f.throwOnSet = true;
        const c = make(f);
        await expect(c.put({ scope: 's', kbTag: 'k', queryText: 'q', response: 1 })).resolves.toBeUndefined();
        expect(f.store.size).toBe(0);
    });

    it('fails open: invalidate returns 0 when scan throws', async () => {
        const f = new FakeRedis();
        f.throwOnScan = true;
        const c = make(f);
        await expect(c.invalidate({ scope: 's' })).resolves.toBe(0);
    });

    it('disabled cache always misses and never touches the client', async () => {
        const f = new FakeRedis();
        const c = new RedisExactCache(f, { ttlSeconds: 100, prefix: 'aigen:v1', enabled: false });
        await c.put({ scope: 's', kbTag: 'k', queryText: 'q', response: 1 });
        expect(f.store.size).toBe(0);
        expect((await c.get({ scope: 's', kbTag: 'k', queryText: 'q' })).hit).toBe(false);
    });
});
