/**
 * @format
 * Tests for public-api lib/pg.ts
 *
 * Regression guard for the PgBouncer SSL mismatch: the pool MUST connect with
 * `ssl: false`. PgBouncer runs `client_tls_sslmode=disable`, so a pool built
 * with an SSL object made every query fail with "The server does not support
 * SSL connections" — taking down the entire public articles surface. This test
 * asserts the driver is never handed an SSL config again.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const poolCtor = jest.fn();

jest.mock('pg', () => ({
    Pool: class {
        constructor(opts: unknown) {
            poolCtor(opts);
        }
    },
}));

import { getPool, _resetPool } from '../../src/lib/pg.js';
import type { Config } from '../../src/lib/config.js';

const CONFIG = {
    pgHost:     'pgbouncer.platform.svc.cluster.local',
    pgPort:     5432,
    pgDatabase: 'tucaken',
    pgUser:     'public_api',
    pgPassword: 'secret',
} as unknown as Config;

beforeEach(() => {
    jest.clearAllMocks();
    _resetPool();
});

describe('getPool', () => {
    it('builds the pool with ssl:false (PgBouncer does not support client SSL)', () => {
        getPool(CONFIG);
        expect(poolCtor).toHaveBeenCalledTimes(1);
        const opts = poolCtor.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(opts.ssl).toBe(false);
        expect(opts.host).toBe('pgbouncer.platform.svc.cluster.local');
    });

    it('reuses the singleton pool across calls', () => {
        const a = getPool(CONFIG);
        const b = getPool(CONFIG);
        expect(a).toBe(b);
        expect(poolCtor).toHaveBeenCalledTimes(1);
    });
});
