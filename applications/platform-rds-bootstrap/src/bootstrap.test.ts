/**
 * @format
 */

import { describe, it, expect, jest } from '@jest/globals';

import { migrationChecksum, runBootstrap } from './bootstrap.js';

function makePool(existingRows: Array<{ checksum: string }> = []) {
    const query = jest.fn(async (sql: unknown) => {
        const text = String(sql);
        if (text.includes('SELECT checksum FROM schema_migrations')) {
            return { rows: existingRows, rowCount: existingRows.length };
        }
        return { rows: [], rowCount: 0 };
    });
    const client = { query, release: jest.fn() };
    const pool = { connect: jest.fn(async () => client) };
    return { pool, client, query };
}

describe('migrationChecksum', () => {
    it('is deterministic for a migration body', () => {
        expect(migrationChecksum('SELECT 1;')).toBe(migrationChecksum('SELECT 1;'));
        expect(migrationChecksum('SELECT 1;')).not.toBe(migrationChecksum('SELECT 2;'));
    });
});

describe('runBootstrap migration ledger', () => {
    it('records a migration checksum after applying a new migration', async () => {
        const { pool, query } = makePool();
        await runBootstrap(pool as never, [{ name: '001_test.sql', sql: 'SELECT 1;' }]);

        expect(query.mock.calls.some((c) => String(c[0]).includes('CREATE TABLE IF NOT EXISTS schema_migrations'))).toBe(true);
        expect(query.mock.calls.some((c) => String(c[0]) === 'SELECT 1;')).toBe(true);
        expect(query.mock.calls.some((c) => String(c[0]).includes('INSERT INTO schema_migrations'))).toBe(true);
    });

    it('skips a migration when the recorded checksum matches', async () => {
        const checksum = migrationChecksum('SELECT 1;');
        const { pool, query } = makePool([{ checksum }]);
        await runBootstrap(pool as never, [{ name: '001_test.sql', sql: 'SELECT 1;' }]);

        expect(query.mock.calls.some((c) => String(c[0]) === 'SELECT 1;')).toBe(false);
    });

    it('throws before applying a changed migration with the same name', async () => {
        const { pool, query } = makePool([{ checksum: migrationChecksum('SELECT old;') }]);

        await expect(
            runBootstrap(pool as never, [{ name: '001_test.sql', sql: 'SELECT new;' }]),
        ).rejects.toThrow(/checksum mismatch/i);

        expect(query.mock.calls.some((c) => String(c[0]) === 'SELECT new;')).toBe(false);
    });
});
