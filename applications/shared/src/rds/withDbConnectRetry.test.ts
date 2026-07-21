/** @format */
import { describe, it, expect, jest } from '@jest/globals';

import { isConnectionError, withDbConnectRetry } from './withDbConnectRetry.js';

const connErr = (over: Record<string, unknown>): Error => Object.assign(new Error(String(over.message ?? 'boom')), over);

describe('isConnectionError', () => {
    it('is true for connection-class errno codes', () => {
        for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH']) {
            expect(isConnectionError(connErr({ code }))).toBe(true);
        }
    });

    it('is true for libpq connection-failure messages (no code)', () => {
        expect(isConnectionError(new Error('connect ECONNREFUSED 172.20.224.77:5432'))).toBe(true);
        expect(isConnectionError(new Error('Connection terminated unexpectedly'))).toBe(true);
        expect(isConnectionError(new Error('the database system is starting up'))).toBe(true);
        expect(isConnectionError(new Error('timeout exceeded when trying to connect'))).toBe(true);
    });

    it('is false for query-level errors and non-errors', () => {
        expect(isConnectionError(connErr({ code: '23505', message: 'duplicate key value' }))).toBe(false);
        expect(isConnectionError(new Error('syntax error at or near "SELCT"'))).toBe(false);
        expect(isConnectionError(new Error('canceling statement due to statement timeout'))).toBe(false);
        expect(isConnectionError(null)).toBe(false);
        expect(isConnectionError('ECONNREFUSED')).toBe(false);
        expect(isConnectionError(undefined)).toBe(false);
    });
});

describe('withDbConnectRetry', () => {
    const noopSleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const opts = (over = {}) => ({ sleep: noopSleep, ...over });

    it('returns the result without retrying on success', async () => {
        noopSleep.mockClear();
        const fn = jest.fn<() => Promise<string>>().mockResolvedValue('ok');
        await expect(withDbConnectRetry(fn, opts())).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
        expect(noopSleep).not.toHaveBeenCalled();
    });

    it('retries a connection error then succeeds', async () => {
        noopSleep.mockClear();
        const fn = jest.fn<() => Promise<string>>()
            .mockRejectedValueOnce(connErr({ code: 'ECONNREFUSED' }))
            .mockResolvedValue('recovered');
        await expect(withDbConnectRetry(fn, opts({ baseDelayMs: 100 }))).resolves.toBe('recovered');
        expect(fn).toHaveBeenCalledTimes(2);
        expect(noopSleep).toHaveBeenCalledTimes(1);
        expect(noopSleep).toHaveBeenCalledWith(100);
    });

    it('does NOT retry a non-connection (query) error', async () => {
        noopSleep.mockClear();
        const fn = jest.fn<() => Promise<string>>().mockRejectedValue(connErr({ code: '23505', message: 'duplicate key' }));
        await expect(withDbConnectRetry(fn, opts())).rejects.toThrow('duplicate key');
        expect(fn).toHaveBeenCalledTimes(1);
        expect(noopSleep).not.toHaveBeenCalled();
    });

    it('exhausts maxAttempts on a persistent connection error and rethrows', async () => {
        noopSleep.mockClear();
        const fn = jest.fn<() => Promise<string>>().mockRejectedValue(connErr({ code: 'ECONNRESET', message: 'ECONNRESET' }));
        await expect(withDbConnectRetry(fn, opts({ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 4000 })))
            .rejects.toThrow('ECONNRESET');
        expect(fn).toHaveBeenCalledTimes(3);
        // capped exponential backoff between the 3 attempts: 100, 200
        expect(noopSleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
    });

    it('caps the backoff delay at maxDelayMs', async () => {
        noopSleep.mockClear();
        const fn = jest.fn<() => Promise<string>>().mockRejectedValue(connErr({ code: 'ECONNREFUSED' }));
        await expect(withDbConnectRetry(fn, opts({ maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 2000 })))
            .rejects.toBeDefined();
        // 1000, 2000, 2000(capped), 2000(capped)
        expect(noopSleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000, 2000, 2000]);
    });

    it('invokes onRetry with attempt metadata', async () => {
        noopSleep.mockClear();
        const onRetry = jest.fn();
        const fn = jest.fn<() => Promise<string>>()
            .mockRejectedValueOnce(connErr({ code: 'ECONNREFUSED' }))
            .mockResolvedValue('ok');
        await withDbConnectRetry(fn, opts({ baseDelayMs: 50, onRetry }));
        expect(onRetry).toHaveBeenCalledTimes(1);
        expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, delayMs: 50 }));
    });
});
