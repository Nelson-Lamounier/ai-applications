/** @format */
import { resolveRedisCacheConfig } from './redis-read-cache.js';

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
