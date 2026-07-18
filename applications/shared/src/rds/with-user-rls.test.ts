/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { withUserRls } from './with-user-rls.js';

interface RecordedQuery {
    sql:     string;
    params?: unknown[];
}

function fakeClient(opts: { throwOn?: RegExp } = {}) {
    const calls: RecordedQuery[] = [];
    const client = {
        calls,
        query: jest.fn(async (sql: string, params?: unknown[]) => {
            calls.push({ sql, params });
            if (opts.throwOn && opts.throwOn.test(sql)) throw new Error('boom');
            return { rows: [] };
        }),
        release: jest.fn(),
    };
    return client;
}

function fakePool(client: ReturnType<typeof fakeClient>) {
    return { connect: jest.fn(async () => client) };
}

const USER_ID = '11111111-1111-1111-1111-111111111111';

describe('withUserRls', () => {
    it('wraps fn in BEGIN; SET LOCAL ROLE tucaken_app; set_config; COMMIT, in that order', async () => {
        const client = fakeClient();
        const pool = fakePool(client);

        const out = await withUserRls(pool as never, USER_ID, async (db) => {
            await db.query('SELECT 1');
            return 42;
        });

        expect(out).toBe(42);
        expect(client.calls[0].sql).toBe('BEGIN');
        expect(client.calls[1].sql).toBe('SET LOCAL ROLE tucaken_app');
        expect(client.calls[2].sql).toBe(`SELECT set_config('app.current_user_id', $1, true)`);
        expect(client.calls[2].params).toEqual([USER_ID]);
        expect(client.calls.map(c => c.sql)).toContain('SELECT 1');
        expect(client.calls.at(-1)!.sql).toBe('COMMIT');
        expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('passes the demoted client through to fn', async () => {
        const client = fakeClient();
        const pool = fakePool(client);

        await withUserRls(pool as never, USER_ID, async (db) => {
            expect(db).toBe(client);
            return null;
        });
    });

    it('ROLLBACK + rethrow on error, and still releases the client', async () => {
        const client = fakeClient();
        const pool = fakePool(client);

        await expect(
            withUserRls(pool as never, USER_ID, async () => {
                throw new Error('writer failed');
            }),
        ).rejects.toThrow('writer failed');

        const sqls = client.calls.map(c => c.sql);
        expect(sqls).toContain('ROLLBACK');
        expect(sqls).not.toContain('COMMIT');
        expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('ROLLBACK + rethrow when a statement inside fn fails', async () => {
        const client = fakeClient({ throwOn: /INSERT INTO doomed/ });
        const pool = fakePool(client);

        await expect(
            withUserRls(pool as never, USER_ID, async (db) => {
                await db.query('INSERT INTO doomed VALUES (1)');
            }),
        ).rejects.toThrow('boom');

        const sqls = client.calls.map(c => c.sql);
        expect(sqls).toContain('ROLLBACK');
        expect(sqls).not.toContain('COMMIT');
        expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('releases the client even when ROLLBACK itself fails', async () => {
        const client = fakeClient();
        client.query.mockImplementation(async (sql: string) => {
            client.calls.push({ sql });
            if (sql === 'SELECT 1') throw new Error('writer failed');
            if (sql === 'ROLLBACK') throw new Error('rollback failed');
            return { rows: [] };
        });
        const pool = fakePool(client);

        await expect(
            withUserRls(pool as never, USER_ID, async (db) => {
                await db.query('SELECT 1');
            }),
        ).rejects.toThrow('writer failed');

        expect(client.release).toHaveBeenCalledTimes(1);
    });
});
