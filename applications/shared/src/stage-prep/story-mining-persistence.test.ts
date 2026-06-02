/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { RdsStoryCandidateRepository } from './story-mining-persistence.js';

describe('RdsStoryCandidateRepository.upsertMany', () => {
  it('sets user scope and upserts each candidate with ON CONFLICT', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    const client = { query, release: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = { connect: jest.fn(async () => client) } as any;
    await new RdsStoryCandidateRepository(pool).upsertMany('u1', 'o/r', [
      { storyType: 'incident', anchorKey: 'sha1', anchors: { revertSha: 'sha1' }, confidence: 0.85 },
    ]);
    const sql = query.mock.calls.map((c) => (c as unknown[])[0] as string);
    expect(sql.some((s) => /set_config\('app.current_user_id'/.test(s))).toBe(true);
    expect(sql.some((s) => /INSERT INTO story_candidates/.test(s) && /ON CONFLICT/.test(s))).toBe(true);
  });

  it('no-ops on empty (never connects)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = { connect: jest.fn() } as any;
    await new RdsStoryCandidateRepository(pool).upsertMany('u1', 'o/r', []);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('RdsStoryCandidateRepository reads are RLS-scoped', () => {
  it('readCommits selects repo_commits under the user scope', async () => {
    const query = jest.fn(async (sql: unknown) =>
      String(sql).includes('repo_commits')
        ? { rows: [{ sha: 's', message: 'm' }] }
        : { rows: [] });
    const client = { query, release: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = { connect: jest.fn(async () => client) } as any;
    const rows = await new RdsStoryCandidateRepository(pool).readCommits('u1', 'o/r');
    expect(rows).toEqual([{ sha: 's', message: 'm' }]);
    const sql = query.mock.calls.map((c) => (c as unknown[])[0] as string);
    expect(sql.some((s) => /set_config\('app.current_user_id'/.test(s))).toBe(true);
    expect(sql.some((s) => /FROM repo_commits/.test(s))).toBe(true);
  });

  it('readPulls selects repo_pull_requests under the user scope', async () => {
    const query = jest.fn(async (sql: unknown) =>
      String(sql).includes('repo_pull_requests')
        ? { rows: [{ number: 1, body: 'b', state: 'merged', html_url: 'u' }] }
        : { rows: [] });
    const client = { query, release: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = { connect: jest.fn(async () => client) } as any;
    const rows = await new RdsStoryCandidateRepository(pool).readPulls('u1', 'o/r');
    expect(rows).toEqual([{ number: 1, body: 'b', state: 'merged', htmlUrl: 'u' }]);
    const sql = query.mock.calls.map((c) => (c as unknown[])[0] as string);
    expect(sql.some((s) => /set_config\('app.current_user_id'/.test(s))).toBe(true);
    expect(sql.some((s) => /FROM repo_pull_requests/.test(s))).toBe(true);
  });
});
