import type { Pool, PoolClient } from 'pg';
import type { Message } from '@aws-sdk/client-bedrock-runtime';

// ─── RLS helper ───────────────────────────────────────────────────────────────

async function setRlsUser(client: PoolClient, userId: string): Promise<void> {
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
}

// ─── Session management ───────────────────────────────────────────────────────

export async function validateSession(pool: Pool, userId: string, sessionId: string): Promise<boolean> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await setRlsUser(client, userId);
        const { rows } = await client.query<{ id: string }>(
            'SELECT id FROM chat_sessions WHERE id = $1',
            [sessionId],
        );
        await client.query('COMMIT');
        return rows.length > 0;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

export async function createSession(pool: Pool, userId: string): Promise<string> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await setRlsUser(client, userId);
        const { rows } = await client.query<{ id: string }>(
            'INSERT INTO chat_sessions (user_id) VALUES ($1) RETURNING id',
            [userId],
        );
        await client.query('COMMIT');
        return rows[0].id;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// ─── Message persistence ──────────────────────────────────────────────────────

export async function appendMessages(
    pool: Pool,
    userId: string,
    sessionId: string,
    userText: string,
    assistantText: string,
): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await setRlsUser(client, userId);
        await client.query(
            "INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ($1, $2, 'user', $3)",
            [sessionId, userId, userText],
        );
        await client.query(
            "INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ($1, $2, 'assistant', $3)",
            [sessionId, userId, assistantText],
        );
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// ─── History retrieval ────────────────────────────────────────────────────────

export async function loadHistory(
    pool: Pool,
    userId: string,
    sessionId: string,
): Promise<Message[]> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await setRlsUser(client, userId);
        const { rows } = await client.query<{ role: string; content: string }>(
            'SELECT role, content FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC',
            [sessionId],
        );
        await client.query('COMMIT');
        return rows.map(r => ({
            role: r.role as 'user' | 'assistant',
            content: [{ text: r.content }],
        }));
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}
