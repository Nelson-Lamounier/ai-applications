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
