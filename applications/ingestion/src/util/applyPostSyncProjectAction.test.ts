/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { applyPostSyncProjectAction } from './applyPostSyncProjectAction.js';

function poolFrom(rows: Record<string, unknown>[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/SELECT .*post_sync_action/i.test(sql)) return { rows, rowCount: rows.length };
    return { rows: [], rowCount: 1 };
  });
  const release = jest.fn();
  // The function acquires ONE client from the pool and runs the whole
  // transaction on it (BEGIN/set_config/queries/COMMIT share a connection).
  const connect = jest.fn(async () => ({ query, release }));
  return { pool: { connect } as never, calls, release };
}

describe('applyPostSyncProjectAction', () => {
  it('build: confirms the default project + sets case_study_status pending + clears the action', async () => {
    const { pool, calls, release } = poolFrom([{ id: 'proj-1', post_sync_action: 'build', post_sync_target_project_id: null }]);
    const out = await applyPostSyncProjectAction(pool, 'u1', 'Owner/Repo');
    expect(out).toBe('build');
    // RLS context is set on the same client before any read/write.
    expect(calls[0].sql).toMatch(/BEGIN/i);
    expect(calls[1].sql).toMatch(/set_config\('app\.current_user_id'/i);
    const upd = calls.find(c => /UPDATE projects/i.test(c.sql) && /is_user_confirmed\s*=\s*TRUE/i.test(c.sql))!;
    expect(upd.sql).toMatch(/case_study_status\s*=\s*'pending'/i);
    expect(upd.sql).toMatch(/post_sync_action\s*=\s*NULL/i);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('none: no-op when there is no pending action', async () => {
    const { pool } = poolFrom([{ id: 'proj-1', post_sync_action: null, post_sync_target_project_id: null }]);
    expect(await applyPostSyncProjectAction(pool, 'u1', 'Owner/Repo')).toBe('none');
  });
  it('never throws -- a query error resolves to none and releases the client', async () => {
    const release = jest.fn();
    const client = { query: jest.fn(async () => { throw new Error('boom'); }), release };
    const pool = { connect: jest.fn(async () => client) } as never;
    await expect(applyPostSyncProjectAction(pool, 'u1', 'Owner/Repo')).resolves.toBe('none');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
