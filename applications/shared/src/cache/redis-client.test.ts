/** @format */
import Redis from 'ioredis';
import { resolveRedisCacheConfig, createRedisCacheClient } from './redis-client.js';

jest.mock('ioredis', () => jest.fn());

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

describe('createRedisCacheClient', () => {
    beforeEach(() => { (Redis as unknown as jest.Mock).mockClear(); });

    it('passes password:undefined when password is undefined', () => {
        createRedisCacheClient({ enabled: true, host: 'h', port: 6379, password: undefined, tls: false });
        expect(Redis).toHaveBeenCalledWith(expect.objectContaining({ password: undefined }));
    });

    it('sets tls:{} only when tls is true', () => {
        createRedisCacheClient({ enabled: true, host: 'h', port: 6379, password: undefined, tls: true });
        expect(Redis).toHaveBeenCalledWith(expect.objectContaining({ tls: {} }));
    });

    it('sets tls:undefined when tls is false', () => {
        createRedisCacheClient({ enabled: true, host: 'h', port: 6379, password: undefined, tls: false });
        expect(Redis).toHaveBeenCalledWith(expect.objectContaining({ tls: undefined }));
    });
});
