/** @format */
import { assertSafeToMutate } from '../rds-client';

describe('assertSafeToMutate', () => {
  const okUser = '31f4686a-979b-4765-a17c-22a1e71cec59';

  it('passes for the dev db + a uuid test user', () => {
    expect(() => assertSafeToMutate('tucaken', okUser)).not.toThrow();
  });
  it('aborts when the db is not the dev database', () => {
    expect(() => assertSafeToMutate('tucaken_prod', okUser)).toThrow(/refusing.*database/i);
  });
  it('aborts when the test user id is empty', () => {
    expect(() => assertSafeToMutate('tucaken', '')).toThrow(/test user/i);
  });
  it('aborts when the test user id is not a uuid', () => {
    expect(() => assertSafeToMutate('tucaken', 'admin')).toThrow(/test user/i);
  });

  it('fails closed when SMOKE_ALLOWED_DBS is set empty (no [""] bypass)', () => {
    const prev = process.env.SMOKE_ALLOWED_DBS;
    process.env.SMOKE_ALLOWED_DBS = '';
    try {
      expect(() => assertSafeToMutate('', okUser)).toThrow(/refusing.*database/i);
      expect(() => assertSafeToMutate('tucaken', okUser)).not.toThrow(); // '' falls back to default 'tucaken' via || operator
    } finally {
      if (prev === undefined) delete process.env.SMOKE_ALLOWED_DBS;
      else process.env.SMOKE_ALLOWED_DBS = prev;
    }
  });

  it('ignores blank entries from a trailing comma', () => {
    const prev = process.env.SMOKE_ALLOWED_DBS;
    process.env.SMOKE_ALLOWED_DBS = 'tucaken,';
    try {
      expect(() => assertSafeToMutate('', okUser)).toThrow(/refusing.*database/i);
      expect(() => assertSafeToMutate('tucaken', okUser)).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.SMOKE_ALLOWED_DBS;
      else process.env.SMOKE_ALLOWED_DBS = prev;
    }
  });

  it('respects a runtime SMOKE_ALLOWED_DBS override (read per-call)', () => {
    const prev = process.env.SMOKE_ALLOWED_DBS;
    process.env.SMOKE_ALLOWED_DBS = 'tucaken_dev2';
    try {
      expect(() => assertSafeToMutate('tucaken_dev2', okUser)).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.SMOKE_ALLOWED_DBS;
      else process.env.SMOKE_ALLOWED_DBS = prev;
    }
  });

  it('aborts when the db name has leading/trailing whitespace', () => {
    expect(() => assertSafeToMutate(' tucaken', okUser)).toThrow(/refusing.*database/i);
  });
});

import { RdsClient } from '../rds-client';

function fakePool(responses: Array<{ rows: unknown[] }>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let i = 0;
  return {
    calls,
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return responses[Math.min(i++, responses.length - 1)] ?? { rows: [] };
    },
    end: async () => {},
  };
}
const U = '31f4686a-979b-4765-a17c-22a1e71cec59';

describe('RdsClient.waitForPipelineStatus', () => {
  it('resolves when status becomes terminal', async () => {
    const pool = fakePool([{ rows: [{ status: 'researching' }] }, { rows: [{ status: 'complete' }] }]);
    const c = new RdsClient(pool as never, 'tucaken', U);
    expect(await c.waitForPipelineStatus('run-1', 50, 5)).toBe('complete');
  });
  it('throws SmokeAssertionError when status is failed', async () => {
    const pool = fakePool([{ rows: [{ status: 'failed', error: { msg: 'boom' } }] }]);
    const c = new RdsClient(pool as never, 'tucaken', U);
    await expect(c.waitForPipelineStatus('run-1', 50, 5)).rejects.toThrow(/failed.*boom/s);
  });
  it('throws SmokeInfraError on timeout', async () => {
    const pool = fakePool([{ rows: [{ status: 'researching' }] }]);
    const c = new RdsClient(pool as never, 'tucaken', U);
    await expect(c.waitForPipelineStatus('run-1', 10, 5)).rejects.toThrow(/timed out/i);
  });
});

describe('RdsClient.cleanupRun', () => {
  it('deletes children before parents, test-user scoped, guard-checked', async () => {
    const pool = fakePool([{ rows: [] }]);
    const c = new RdsClient(pool as never, 'tucaken', U);
    await c.cleanupRun({ flow: 'job-strategist', pipelineRunId: 'run-9', s3Keys: [] });
    const tables = pool.calls.map(x => x.sql.match(/DELETE FROM (\w+)/)?.[1]);
    expect(tables).toEqual(['coaching_content', 'resumes', 'articles', 'pipeline_runs', 'job_applications']);
    for (const call of pool.calls) expect(call.params).toContain(U);
  });
  it('refuses cleanup when the safety guard fails', async () => {
    const pool = fakePool([{ rows: [] }]);
    const c = new RdsClient(pool as never, 'prod_db', U);
    await expect(c.cleanupRun({ flow: 'job-strategist', pipelineRunId: 'r', s3Keys: [] }))
      .rejects.toThrow(/refusing.*database/i);
    expect(pool.calls).toHaveLength(0);
  });
});

describe('RdsClient.cleanupChatSession', () => {
  it('deletes chat history scoped to user + session, guard-checked', async () => {
    const pool = fakePool([{ rows: [] }]);
    const c = new RdsClient(pool as never, 'tucaken', U);
    await c.cleanupChatSession('sess-1');
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].sql).toMatch(/DELETE FROM \w+ WHERE user_id = \$1 AND session_id = \$2/);
    expect(pool.calls[0].params).toEqual([U, 'sess-1']);
  });
  it('refuses when the safety guard fails', async () => {
    const pool = fakePool([{ rows: [] }]);
    const c = new RdsClient(pool as never, 'prod_db', U);
    await expect(c.cleanupChatSession('s')).rejects.toThrow(/refusing.*database/i);
    expect(pool.calls).toHaveLength(0);
  });
});
