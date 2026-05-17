/** @format */
import { SmokeSetupError, SmokeAssertionError, SmokeInfraError } from './types.js';
import type { CleanupTarget } from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hard-aborts (no DB work) unless the resolved database is an allowed dev
 *  database AND the test user id is a UUID. The single most important guard
 *  in the harness — a cleanup bug here would delete real rows.
 *  The allowlist is read per-call (not frozen at module load) and uses `||`
 *  + `.filter(Boolean)` so an empty/blank SMOKE_ALLOWED_DBS fails closed. */
export function assertSafeToMutate(database: string, testUserId: string): void {
  const allowed = (process.env.SMOKE_ALLOWED_DBS || 'tucaken')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (!allowed.includes(database)) {
    throw new SmokeSetupError(
      `Refusing to touch database "${database}" — not in allowed dev set [${allowed.join(', ')}]`,
    );
  }
  if (!testUserId || !UUID_RE.test(testUserId)) {
    throw new SmokeSetupError(
      `Refusing to run: test user id "${testUserId}" is empty or not a UUID`,
    );
  }
}

const TERMINAL_OK = 'complete';
const TERMINAL_FAIL = 'failed';

export interface QueryablePool {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

export class RdsClient {
  constructor(
    private readonly pool: QueryablePool,
    private readonly database: string,
    private readonly testUserId: string,
  ) {}

  private guard(): void { assertSafeToMutate(this.database, this.testUserId); }

  async waitForPipelineStatus(runId: string, timeoutMs: number, intervalMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let last = 'unknown';
    while (Date.now() <= deadline) {
      const { rows } = await this.pool.query(
        'SELECT status, error FROM pipeline_runs WHERE id = $1 LIMIT 1', [runId]);
      const row = rows[0] as { status?: string; error?: unknown } | undefined;
      last = row?.status ?? 'missing';
      if (last === TERMINAL_OK) return last;
      if (last === TERMINAL_FAIL) {
        throw new SmokeAssertionError(`pipeline ${runId} failed: ${JSON.stringify(row?.error ?? {})}`);
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new SmokeInfraError(`pipeline ${runId} timed out (last status: ${last})`);
  }

  async assertRows(sql: string, params: unknown[], what: string): Promise<unknown[]> {
    const { rows } = await this.pool.query(sql, params);
    if (rows.length === 0) throw new SmokeAssertionError(`expected rows for ${what}, found none`);
    return rows;
  }

  async cleanupRun(t: CleanupTarget): Promise<void> {
    this.guard();
    const uid = this.testUserId;
    const rid = t.pipelineRunId ?? null;
    const stmts: Array<[string, unknown[]]> = [
      ['DELETE FROM coaching_content WHERE user_id = $1 AND ($2::text IS NULL OR pipeline_run_id = $2)', [uid, rid]],
      ['DELETE FROM resumes WHERE user_id = $1 AND source = $2 AND ($3::text IS NULL OR pipeline_run_id = $3)', [uid, 'tailored', rid]],
      ['DELETE FROM articles WHERE user_id = $1 AND ($2::text IS NULL OR pipeline_run_id = $2)', [uid, rid]],
      ['DELETE FROM pipeline_runs WHERE user_id = $1 AND ($2::text IS NULL OR id = $2)', [uid, rid]],
      ['DELETE FROM job_applications WHERE user_id = $1 AND ($2::text IS NULL OR pipeline_run_id = $2)', [uid, rid]],
    ];
    for (const [sql, params] of stmts) {
      try { await this.pool.query(sql, params); }
      catch (e) { console.warn(`[smoke] cleanup skip: ${(e as Error).message}`); }
    }
  }

  async cleanupUserScoped(): Promise<void> {
    this.guard();
    const uid = this.testUserId;
    const stmts: Array<[string, unknown[]]> = [
      ['DELETE FROM user_career_history WHERE user_id = $1', [uid]],
      ['DELETE FROM document_embeddings WHERE user_id = $1', [uid]],
      ['DELETE FROM repo_sync_state WHERE user_id = $1', [uid]],
    ];
    for (const [sql, params] of stmts) {
      try { await this.pool.query(sql, params); }
      catch (e) { console.warn(`[smoke] cleanup skip: ${(e as Error).message}`); }
    }
  }

  async close(): Promise<void> { await this.pool.end(); }
}

export async function connectRds(opts: {
  host: string; port: number; database: string; user: string; password: string; testUserId: string;
}): Promise<RdsClient> {
  assertSafeToMutate(opts.database, opts.testUserId);
  const { Pool } = await import('pg');
  const pool = new Pool({
    host: opts.host, port: opts.port, database: opts.database,
    user: opts.user, password: opts.password, max: 4,
    connectionTimeoutMillis: 10_000,
  });
  return new RdsClient(pool as unknown as QueryablePool, opts.database, opts.testUserId);
}
