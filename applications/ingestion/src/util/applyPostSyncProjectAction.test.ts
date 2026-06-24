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
  return { pool: { query } as never, calls };
}

describe('applyPostSyncProjectAction', () => {
  it('build: confirms the default project + sets case_study_status pending + clears the action', async () => {
    const { pool, calls } = poolFrom([{ id: 'proj-1', post_sync_action: 'build', post_sync_target_project_id: null }]);
    const out = await applyPostSyncProjectAction(pool, 'u1', 'Owner/Repo');
    expect(out).toBe('build');
    const upd = calls.find(c => /UPDATE projects/i.test(c.sql) && /is_user_confirmed\s*=\s*TRUE/i.test(c.sql))!;
    expect(upd.sql).toMatch(/case_study_status\s*=\s*'pending'/i);
    expect(upd.sql).toMatch(/post_sync_action\s*=\s*NULL/i);
  });
  it('none: no-op when there is no pending action', async () => {
    const { pool } = poolFrom([{ id: 'proj-1', post_sync_action: null, post_sync_target_project_id: null }]);
    expect(await applyPostSyncProjectAction(pool, 'u1', 'Owner/Repo')).toBe('none');
  });
  it('never throws -- a query error resolves to none', async () => {
    const pool = { query: jest.fn(async () => { throw new Error('boom'); }) } as never;
    await expect(applyPostSyncProjectAction(pool, 'u1', 'Owner/Repo')).resolves.toBe('none');
  });
});
