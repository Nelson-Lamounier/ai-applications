import { describe, it, expect, jest } from '@jest/globals';
import { AiTopicResolver, RdsAiEvidenceRepository } from './ai-evidence.js';

describe('AiTopicResolver', () => {
  const r = new AiTopicResolver(new Set(['ai_prompt_caching', 'ai_mcp_integration']));
  it('resolves a known canonical', () => expect(r.resolve('ai_prompt_caching')).toBe('ai_prompt_caching'));
  it('drops an unknown hint (never invents)', () => expect(r.resolve('ai_made_up')).toBeNull());
});

describe('RdsAiEvidenceRepository.insertMany', () => {
  it('sets user scope and inserts each row', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    const client = { query, release: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = { connect: jest.fn(async () => client) } as any;
    const repo = new RdsAiEvidenceRepository(pool);
    await repo.insertMany('u1', [
      { repoFullName: 'o/r', commitSha: 'sha', aiTopic: 'ai_prompt_caching', signal: 'prompt_caching',
        rawName: 'cachePoint', filePath: 'bedrock.ts', lineStart: 3, confidence: 0.78 },
    ]);
    const sql = (query.mock.calls.map((c) => (c as unknown[])[0] as string));
    expect(sql.some((s) => /set_config\('app.current_user_id'/.test(s))).toBe(true);
    expect(sql.some((s) => /INSERT INTO ai_evidence/.test(s))).toBe(true);
  });
  it('no-ops on empty', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = { connect: jest.fn() } as any;
    await new RdsAiEvidenceRepository(pool).insertMany('u1', []);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('RdsAiEvidenceRepository scan marker (idempotency)', () => {
  it('hasAiScanForCommit true when a marker row exists', async () => {
    const query = jest.fn(async (sql: unknown) =>
      String(sql).includes('ai_scanned_commits') ? { rows: [{ '?column?': 1 }] } : { rows: [] });
    const client = { query, release: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = { connect: jest.fn(async () => client) } as any;
    const seen = await new RdsAiEvidenceRepository(pool).hasAiScanForCommit('u1', 'o/r', 'sha');
    expect(seen).toBe(true);
    const sql = query.mock.calls.map((c) => (c as unknown[])[0] as string);
    expect(sql.some((s) => /set_config\('app.current_user_id'/.test(s))).toBe(true);
    expect(sql.some((s) => /SELECT 1 FROM ai_scanned_commits/.test(s))).toBe(true);
  });
  it('hasAiScanForCommit false when no marker', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    const client = { query, release: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = { connect: jest.fn(async () => client) } as any;
    expect(await new RdsAiEvidenceRepository(pool).hasAiScanForCommit('u1', 'o/r', 'sha')).toBe(false);
  });
  it('recordAiScan upserts the marker with match count', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    const client = { query, release: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = { connect: jest.fn(async () => client) } as any;
    await new RdsAiEvidenceRepository(pool).recordAiScan('u1', 'o/r', 'sha', 3);
    const calls = query.mock.calls.map((c) => (c as unknown[])[0] as string);
    expect(calls.some((s) => /INSERT INTO ai_scanned_commits/.test(s) && /ON CONFLICT/.test(s))).toBe(true);
  });
});
