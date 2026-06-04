import { describe, it, expect, jest } from '@jest/globals';
import { createSession, appendMessages, loadHistory, validateSession } from '../session.js';
import type { Pool, PoolClient } from 'pg';

// ── Mock pool factory ─────────────────────────────────────────────────────────

type MockClient = {
    query:   jest.Mock;
    release: jest.Mock;
};

function makeMockPool(queryResponses: Record<string, unknown> = {}): {
    pool: Pool;
    client: MockClient;
} {
    const client: MockClient = {
        query:   jest.fn<PoolClient['query']>(),
        release: jest.fn(),
    };

    client.query.mockImplementation(async (sql: unknown) => {
        const q = typeof sql === 'string' ? sql.trim() : '';
        if (q in queryResponses) return queryResponses[q];
        if (q.startsWith('INSERT INTO chat_sessions')) {
            return { rows: [{ id: 'session-uuid' }] };
        }
        if (q.startsWith('SELECT role, content FROM chat_messages')) {
            return { rows: [] };
        }
        return { rows: [], rowCount: 0 };
    });

    const pool = {
        connect: jest.fn<() => Promise<PoolClient>>().mockResolvedValue(client as unknown as PoolClient),
    } as unknown as Pool;

    return { pool, client };
}

// ── validateSession ───────────────────────────────────────────────────────────

describe('validateSession', () => {
    it('returns true when session exists for user', async () => {
        const client: MockClient = { query: jest.fn(), release: jest.fn() };
        client.query.mockImplementation(async (sql: unknown) => {
            const q = typeof sql === 'string' ? sql.trim() : '';
            if (q.startsWith('SELECT id FROM chat_sessions')) return { rows: [{ id: 'session-uuid' }] };
            return { rows: [], rowCount: 0 };
        });
        const pool = { connect: jest.fn<() => Promise<PoolClient>>().mockResolvedValue(client as unknown as PoolClient) } as unknown as Pool;
        expect(await validateSession(pool, 'user-1', 'session-uuid')).toBe(true);
    });

    it('returns false when session does not exist (RLS hides or missing)', async () => {
        const client: MockClient = { query: jest.fn(), release: jest.fn() };
        client.query.mockImplementation(async (sql: unknown) => {
            const q = typeof sql === 'string' ? sql.trim() : '';
            if (q.startsWith('SELECT id FROM chat_sessions')) return { rows: [] };
            return { rows: [], rowCount: 0 };
        });
        const pool = { connect: jest.fn<() => Promise<PoolClient>>().mockResolvedValue(client as unknown as PoolClient) } as unknown as Pool;
        expect(await validateSession(pool, 'user-1', 'missing-uuid')).toBe(false);
    });

    it('sets RLS user before select', async () => {
        const { pool, client } = makeMockPool({
            'SELECT id FROM chat_sessions WHERE id = $1': { rows: [] },
        });
        await validateSession(pool, 'user-1', 'session-uuid');
        const calls = client.query.mock.calls;
        const sqls = calls.map(c => c[0]);
        const rlsIdx    = sqls.findIndex(q => typeof q === 'string' && q.includes('app.current_user_id'));
        expect(calls[rlsIdx]).toEqual([
            "SELECT set_config('app.current_user_id', $1, true)",
            ['user-1'],
        ]);
        const selectIdx = sqls.findIndex(q => typeof q === 'string' && q.includes('SELECT id FROM chat_sessions'));
        expect(rlsIdx).toBeGreaterThan(-1);
        expect(rlsIdx).toBeLessThan(selectIdx);
    });
});

// ── createSession ─────────────────────────────────────────────────────────────

describe('createSession', () => {
    it('returns the new session UUID', async () => {
        const { pool } = makeMockPool();
        const id = await createSession(pool, 'user-1');
        expect(id).toBe('session-uuid');
    });

    it('sets RLS user before insert', async () => {
        const { pool, client } = makeMockPool();
        await createSession(pool, 'user-1');

        const calls = client.query.mock.calls;
        const sqls = calls.map(c => c[0]);
        const rlsIdx = sqls.findIndex(q => typeof q === 'string' && q.includes('app.current_user_id'));
        expect(calls[rlsIdx]).toEqual([
            "SELECT set_config('app.current_user_id', $1, true)",
            ['user-1'],
        ]);
        const insertIdx = sqls.findIndex(q => typeof q === 'string' && q.includes('INSERT INTO chat_sessions'));
        expect(rlsIdx).toBeGreaterThan(-1);
        expect(rlsIdx).toBeLessThan(insertIdx);
    });

    it('wraps in a transaction', async () => {
        const { pool, client } = makeMockPool();
        await createSession(pool, 'user-1');

        const sqls = client.query.mock.calls.map(c => c[0]);
        expect(sqls).toContain('BEGIN');
        expect(sqls).toContain('COMMIT');
    });

    it('rolls back and rethrows on error', async () => {
        const client: MockClient = {
            query:   jest.fn<PoolClient['query']>(),
            release: jest.fn(),
        };
        let callCount = 0;
        client.query.mockImplementation(async () => {
            callCount++;
            if (callCount === 3) throw new Error('db error'); // fail on INSERT
            return { rows: [], rowCount: 0 };
        });
        const pool = {
            connect: jest.fn<() => Promise<PoolClient>>().mockResolvedValue(client as unknown as PoolClient),
        } as unknown as Pool;

        await expect(createSession(pool, 'user-1')).rejects.toThrow('db error');
        const sqls = client.query.mock.calls.map(c => c[0]);
        expect(sqls).toContain('ROLLBACK');
        expect(client.release).toHaveBeenCalled();
    });
});

// ── appendMessages ────────────────────────────────────────────────────────────

describe('appendMessages', () => {
    it('inserts user and assistant rows in a single transaction', async () => {
        const { pool, client } = makeMockPool();
        await appendMessages(pool, 'user-1', 'session-uuid', 'hello', 'hi there');

        const sqls = client.query.mock.calls.map(c => (typeof c[0] === 'string' ? c[0] : ''));
        const inserts = sqls.filter(q => q.includes('INSERT INTO chat_messages'));
        expect(inserts).toHaveLength(2);
        expect(sqls).toContain('BEGIN');
        expect(sqls).toContain('COMMIT');
    });

    it('sets RLS user before inserts', async () => {
        const { pool, client } = makeMockPool();
        await appendMessages(pool, 'user-1', 'session-uuid', 'hello', 'hi');

        const calls = client.query.mock.calls;
        const sqls = calls.map(c => c[0]);
        const rlsIdx   = sqls.findIndex(q => typeof q === 'string' && q.includes('app.current_user_id'));
        expect(calls[rlsIdx]).toEqual([
            "SELECT set_config('app.current_user_id', $1, true)",
            ['user-1'],
        ]);
        const insertIdx = sqls.findIndex(q => typeof q === 'string' && q.includes('INSERT INTO chat_messages'));
        expect(rlsIdx).toBeGreaterThan(-1);
        expect(rlsIdx).toBeLessThan(insertIdx);
    });

    it('rolls back and rethrows on error', async () => {
        const client: MockClient = { query: jest.fn(), release: jest.fn() };
        let n = 0;
        client.query.mockImplementation(async () => {
            n++;
            if (n === 3) throw new Error('insert failed');
            return { rows: [], rowCount: 0 };
        });
        const pool = { connect: jest.fn<() => Promise<PoolClient>>().mockResolvedValue(client as unknown as PoolClient) } as unknown as Pool;
        await expect(appendMessages(pool, 'u', 's', 'q', 'a')).rejects.toThrow('insert failed');
        expect(client.query.mock.calls.map(c => c[0])).toContain('ROLLBACK');
        expect(client.release).toHaveBeenCalled();
    });
});

// ── loadHistory ───────────────────────────────────────────────────────────────

describe('loadHistory', () => {
    it('returns empty array for a new session', async () => {
        const { pool } = makeMockPool();
        const history = await loadHistory(pool, 'user-1', 'session-uuid');
        expect(history).toEqual([]);
    });

    it('maps DB rows to Bedrock Message shape', async () => {
        const client: MockClient = { query: jest.fn(), release: jest.fn() };
        client.query.mockImplementation(async (sql: unknown) => {
            const q = typeof sql === 'string' ? sql.trim() : '';
            if (q.startsWith('SELECT role, content')) {
                return {
                    rows: [
                        { role: 'user',      content: 'hello' },
                        { role: 'assistant', content: 'hi'    },
                    ],
                };
            }
            return { rows: [], rowCount: 0 };
        });
        const pool = { connect: jest.fn<() => Promise<PoolClient>>().mockResolvedValue(client as unknown as PoolClient) } as unknown as Pool;
        const history = await loadHistory(pool, 'user-1', 'session-uuid');
        expect(history).toEqual([
            { role: 'user',      content: [{ text: 'hello' }] },
            { role: 'assistant', content: [{ text: 'hi'    }] },
        ]);
    });

    it('returns rows in chronological order (ORDER BY created_at ASC)', async () => {
        const client: MockClient = { query: jest.fn(), release: jest.fn() };
        client.query.mockImplementation(async (sql: unknown) => {
            const q = typeof sql === 'string' ? sql : '';
            if (typeof q === 'string' && q.includes('SELECT role, content')) {
                expect(q).toContain('ORDER BY created_at ASC');
                return {
                    rows: [
                        { role: 'user',      content: 'first'  },
                        { role: 'assistant', content: 'second' },
                        { role: 'user',      content: 'third'  },
                    ],
                };
            }
            return { rows: [], rowCount: 0 };
        });
        const pool = { connect: jest.fn<() => Promise<PoolClient>>().mockResolvedValue(client as unknown as PoolClient) } as unknown as Pool;
        const history = await loadHistory(pool, 'user-1', 'session-uuid');
        expect(history[0].content![0]).toEqual({ text: 'first' });
        expect(history[2].content![0]).toEqual({ text: 'third' });
    });

    it('sets RLS user before select', async () => {
        const { pool, client } = makeMockPool();
        await loadHistory(pool, 'user-1', 'session-uuid');

        const calls = client.query.mock.calls.map(c => c[0]);
        const rlsIdx    = calls.findIndex(q => typeof q === 'string' && q.includes('app.current_user_id'));
        const selectIdx = calls.findIndex(q => typeof q === 'string' && q.includes('SELECT role, content'));
        expect(rlsIdx).toBeGreaterThan(-1);
        expect(rlsIdx).toBeLessThan(selectIdx);
    });

    it('releases the client even if query throws', async () => {
        const client: MockClient = { query: jest.fn(), release: jest.fn() };
        let n = 0;
        client.query.mockImplementation(async () => {
            n++;
            if (n === 3) throw new Error('select failed');
            return { rows: [], rowCount: 0 };
        });
        const pool = { connect: jest.fn<() => Promise<PoolClient>>().mockResolvedValue(client as unknown as PoolClient) } as unknown as Pool;
        await expect(loadHistory(pool, 'u', 's')).rejects.toThrow('select failed');
        expect(client.release).toHaveBeenCalled();
    });
});
