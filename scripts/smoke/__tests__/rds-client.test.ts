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
  it('resolves when status becomes complete', async () => {
    const pool = fakePool([{ rows: [{ status: 'researching' }] }, { rows: [{ status: 'complete' }] }]);
    const c = new RdsClient(pool as never, 'tucaken', U);
    expect(await c.waitForPipelineStatus('run-1', 50, 5)).toBe('complete');
  });
  it('selects error_message (not error) and reports it on failure', async () => {
    const pool = fakePool([{ rows: [{ status: 'failed', error_message: 'boom' }] }]);
    const c = new RdsClient(pool as never, 'tucaken', U);
    await expect(c.waitForPipelineStatus('run-1', 50, 5)).rejects.toThrow(/failed.*boom/s);
    expect(pool.calls[0].sql).toMatch(/SELECT status, error_message FROM pipeline_runs WHERE id = \$1/);
  });
  it('throws SmokeInfraError on timeout', async () => {
    const pool = fakePool([{ rows: [{ status: 'researching' }] }]);
    const c = new RdsClient(pool as never, 'tucaken', U);
    await expect(c.waitForPipelineStatus('run-1', 10, 5)).rejects.toThrow(/timed out/i);
  });
});

describe('RdsClient.waitForImportStatus', () => {
  it('resolves on ready_for_review by default; scopes to id + user', async () => {
    const pool = fakePool([{ rows: [{ status: 'parsing' }] }, { rows: [{ status: 'ready_for_review' }] }]);
    const c = new RdsClient(pool as never, 'tucaken', U);
    expect(await c.waitForImportStatus('imp-1', 50, 5)).toBe('ready_for_review');
    expect(pool.calls[0].sql).toMatch(/FROM resume_imports WHERE id = \$1 AND user_id = \$2/);
    expect(pool.calls[0].params).toEqual(['imp-1', U]);
  });
  it('honours an explicit okStatus override', async () => {
    const pool = fakePool([{ rows: [{ status: 'completed' }] }]);
    const c = new RdsClient(pool as never, 'tucaken', U);
    expect(await c.waitForImportStatus('imp-1', 50, 5, 'completed')).toBe('completed');
  });
  it('throws with error_code/error_details on failed', async () => {
    const pool = fakePool([{ rows: [{ status: 'failed', error_code: 'PARSE', error_details: { x: 1 } }] }]);
    const c = new RdsClient(pool as never, 'tucaken', U);
    await expect(c.waitForImportStatus('imp-1', 50, 5)).rejects.toThrow(/failed.*PARSE/s);
  });
});

describe('RdsClient.waitForRepoSync', () => {
  it('resolves on complete; scopes to user + repo', async () => {
    const pool = fakePool([{ rows: [{ sync_status: 'syncing' }] }, { rows: [{ sync_status: 'complete' }] }]);
    const c = new RdsClient(pool as never, 'tucaken', U);
    expect(await c.waitForRepoSync('o/r', 50, 5)).toBe('complete');
    expect(pool.calls[0].sql).toMatch(/FROM repo_sync_state WHERE user_id = \$1 AND repo_full_name = \$2/);
    expect(pool.calls[0].params).toEqual([U, 'o/r']);
  });
  it('throws when sync_status is error', async () => {
    const pool = fakePool([{ rows: [{ sync_status: 'error', error_message: 'nope' }] }]);
    const c = new RdsClient(pool as never, 'tucaken', U);
    await expect(c.waitForRepoSync('o/r', 50, 5)).rejects.toThrow(/error.*nope/s);
  });
});

describe('RdsClient.cleanupRun', () => {
  it('job-strategist: children before parents, app + user scoped', async () => {
    const pool = fakePool([{ rows: [] }]);
    const c = new RdsClient(pool as never, 'tucaken', U);
    await c.cleanupRun({ flow: 'job-strategist', applicationId: 'app-1', pipelineRunId: 'run-9', s3Keys: [] });
    const tables = pool.calls.map(x => x.sql.match(/DELETE FROM (\w+)/)?.[1]);
    expect(tables).toEqual(['coaching_content', 'resumes', 'job_applications', 'pipeline_runs']);
    for (const call of pool.calls) expect(call.params).toContain(U);
  });
  it('article-pipeline: deletes article by slug+author then pipeline_run', async () => {
    const pool = fakePool([{ rows: [] }]);
    const c = new RdsClient(pool as never, 'tucaken', U);
    await c.cleanupRun({ flow: 'article-pipeline', slug: 'my-post', pipelineRunId: 'run-2', s3Keys: [] });
    const tables = pool.calls.map(x => x.sql.match(/DELETE FROM (\w+)/)?.[1]);
    expect(tables).toEqual(['articles', 'pipeline_runs']);
    expect(pool.calls[0].sql).toMatch(/articles WHERE slug = \$1 AND author_id = \$2/);
    expect(pool.calls[0].params).toEqual(['my-post', U]);
  });
  it('resume-import: career history (cascades embeddings) then resume_imports', async () => {
    const pool = fakePool([{ rows: [] }]);
    const c = new RdsClient(pool as never, 'tucaken', U);
    await c.cleanupRun({ flow: 'resume-import', importId: 'imp-1', s3Keys: [] });
    const tables = pool.calls.map(x => x.sql.match(/DELETE FROM (\w+)/)?.[1]);
    expect(tables).toEqual(['user_career_history', 'resume_imports']);
    for (const call of pool.calls) expect(call.params).toEqual([U, 'imp-1']);
  });
  it('ingestion: deletes embeddings + sync state by user + repo', async () => {
    const pool = fakePool([{ rows: [] }]);
    const c = new RdsClient(pool as never, 'tucaken', U);
    await c.cleanupRun({ flow: 'ingestion', repoFullName: 'o/r', pipelineRunId: 'run-i', s3Keys: [] });
    const tables = pool.calls.map(x => x.sql.match(/DELETE FROM (\w+)/)?.[1]);
    expect(tables).toEqual(['document_embeddings', 'repo_sync_state', 'pipeline_runs']);
    expect(pool.calls[0].params).toEqual([U, 'o/r']);
    expect(pool.calls[1].params).toEqual([U, 'o/r']);
    expect(pool.calls[2].params).toEqual([U, 'run-i']);
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
  it('deletes messages then session, scoped to user + session, guard-checked', async () => {
    const pool = fakePool([{ rows: [] }]);
    const c = new RdsClient(pool as never, 'tucaken', U);
    await c.cleanupChatSession('sess-1');
    const tables = pool.calls.map(x => x.sql.match(/DELETE FROM (\w+)/)?.[1]);
    expect(tables).toEqual(['chat_messages', 'chat_sessions']);
    expect(pool.calls[0].params).toEqual([U, 'sess-1']);
    expect(pool.calls[1].params).toEqual([U, 'sess-1']);
  });
  it('refuses when the safety guard fails', async () => {
    const pool = fakePool([{ rows: [] }]);
    const c = new RdsClient(pool as never, 'prod_db', U);
    await expect(c.cleanupChatSession('s')).rejects.toThrow(/refusing.*database/i);
    expect(pool.calls).toHaveLength(0);
  });
});
