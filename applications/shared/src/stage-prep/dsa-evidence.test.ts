import { describe, it, expect, jest } from '@jest/globals';
import { DsaTopicResolver, RdsDsaEvidenceRepository } from './dsa-evidence.js';

describe('DsaTopicResolver', () => {
  const r = new DsaTopicResolver(new Set(['dsa_graph_traversal', 'dsa_heaps']));
  it('resolves a known canonical', () => expect(r.resolve('dsa_graph_traversal')).toBe('dsa_graph_traversal'));
  it('drops an unknown hint (never invents)', () => expect(r.resolve('dsa_made_up')).toBeNull());
});

describe('RdsDsaEvidenceRepository.insertMany', () => {
  it('sets user scope and inserts each row', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    const client = { query, release: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = { connect: jest.fn(async () => client) } as any;
    const repo = new RdsDsaEvidenceRepository(pool);
    await repo.insertMany('u1', [
      { repoFullName: 'o/r', commitSha: 'sha', dsaTopic: 'dsa_heaps', signal: 'heap',
        rawName: 'heapq', filePath: 'h.py', lineStart: 1, confidence: 0.78 },
    ]);
    const sql = (query.mock.calls.map((c) => (c as unknown[])[0] as string));
    expect(sql.some((s) => s === 'SET LOCAL ROLE tucaken_app')).toBe(true);
    expect(sql.some((s) => /set_config\('app.current_user_id'/.test(s))).toBe(true);
    expect(sql.some((s) => /INSERT INTO dsa_evidence/.test(s))).toBe(true);
  });
  it('no-ops on empty', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = { connect: jest.fn() } as any;
    await new RdsDsaEvidenceRepository(pool).insertMany('u1', []);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('RdsDsaEvidenceRepository scan marker (idempotency)', () => {
  it('hasDsaScanForCommit true when a marker row exists', async () => {
    const query = jest.fn(async (sql: unknown) =>
      String(sql).includes('dsa_scanned_commits') ? { rows: [{ '?column?': 1 }] } : { rows: [] });
    const client = { query, release: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = { connect: jest.fn(async () => client) } as any;
    const seen = await new RdsDsaEvidenceRepository(pool).hasDsaScanForCommit('u1', 'o/r', 'sha');
    expect(seen).toBe(true);
    const sql = query.mock.calls.map((c) => (c as unknown[])[0] as string);
    expect(sql.some((s) => /set_config\('app.current_user_id'/.test(s))).toBe(true);
    expect(sql.some((s) => /SELECT 1 FROM dsa_scanned_commits/.test(s))).toBe(true);
  });
  it('hasDsaScanForCommit false when no marker', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    const client = { query, release: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = { connect: jest.fn(async () => client) } as any;
    expect(await new RdsDsaEvidenceRepository(pool).hasDsaScanForCommit('u1', 'o/r', 'sha')).toBe(false);
  });
  it('recordDsaScan upserts the marker with match count', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    const client = { query, release: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = { connect: jest.fn(async () => client) } as any;
    await new RdsDsaEvidenceRepository(pool).recordDsaScan('u1', 'o/r', 'sha', 3);
    const calls = query.mock.calls.map((c) => (c as unknown[])[0] as string);
    expect(calls.some((s) => /INSERT INTO dsa_scanned_commits/.test(s) && /ON CONFLICT/.test(s))).toBe(true);
  });
});
