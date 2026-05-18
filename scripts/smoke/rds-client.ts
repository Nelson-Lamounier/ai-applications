/** @format */
import { Pool } from 'pg';
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

export interface QueryablePool {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

/** Generic terminal-status poller. `okValue` resolves, `failValue` throws a
 *  SmokeAssertionError with whatever diagnostic columns the row carries. */
async function pollStatus(
  pool: QueryablePool,
  opts: {
    sql: string; params: unknown[]; statusCol: string;
    okValue: string; failValue: string; what: string;
    timeoutMs: number; intervalMs: number;
  },
): Promise<string> {
  const deadline = Date.now() + opts.timeoutMs;
  let last = 'unknown';
  while (Date.now() <= deadline) {
    const { rows } = await pool.query(opts.sql, opts.params);
    const row = rows[0] as Record<string, unknown> | undefined;
    last = (row?.[opts.statusCol] as string | undefined) ?? 'missing';
    if (last === opts.okValue) return last;
    if (last === opts.failValue) {
      const diag = { ...row };
      delete diag[opts.statusCol];
      throw new SmokeAssertionError(`${opts.what} ${last}: ${JSON.stringify(diag)}`);
    }
    await new Promise(r => setTimeout(r, opts.intervalMs));
  }
  throw new SmokeInfraError(`${opts.what} timed out (last status: ${last})`);
}

export class RdsClient {
  constructor(
    private readonly pool: QueryablePool,
    private readonly database: string,
    private readonly testUserId: string,
  ) {}

  private guard(): void { assertSafeToMutate(this.database, this.testUserId); }

  /** pipeline_runs (job-strategist / article-pipeline). OK 'complete', FAIL 'failed'. */
  async waitForPipelineStatus(runId: string, timeoutMs: number, intervalMs: number): Promise<string> {
    return pollStatus(this.pool, {
      sql: 'SELECT status, error_message FROM pipeline_runs WHERE id = $1 LIMIT 1',
      params: [runId], statusCol: 'status', okValue: 'complete', failValue: 'failed',
      what: `pipeline ${runId}`, timeoutMs, intervalMs,
    });
  }

  /** resume_imports. OK 'completed', FAIL 'failed'. Scoped to id + test user. */
  async waitForImportStatus(importId: string, timeoutMs: number, intervalMs: number): Promise<string> {
    return pollStatus(this.pool, {
      sql: 'SELECT status, error_code, error_details FROM resume_imports WHERE id = $1 AND user_id = $2 LIMIT 1',
      params: [importId, this.testUserId], statusCol: 'status',
      okValue: 'completed', failValue: 'failed',
      what: `resume-import ${importId}`, timeoutMs, intervalMs,
    });
  }

  /** repo_sync_state (ingestion). OK 'complete', FAIL 'error'. Scoped to user + repo. */
  async waitForRepoSync(repoFullName: string, timeoutMs: number, intervalMs: number): Promise<string> {
    return pollStatus(this.pool, {
      sql: 'SELECT sync_status, error_message FROM repo_sync_state WHERE user_id = $1 AND repo_full_name = $2 LIMIT 1',
      params: [this.testUserId, repoFullName], statusCol: 'sync_status',
      okValue: 'complete', failValue: 'error',
      what: `repo-sync ${repoFullName}`, timeoutMs, intervalMs,
    });
  }

  async assertRows(sql: string, params: unknown[], what: string): Promise<unknown[]> {
    const { rows } = await this.pool.query(sql, params);
    if (rows.length === 0) throw new SmokeAssertionError(`expected rows for ${what}, found none`);
    return rows;
  }

  /** Non-throwing read for optional preconditions (e.g. an optional seed
   *  row). Returns [] when nothing matches. */
  async maybeRows(sql: string, params: unknown[]): Promise<unknown[]> {
    const { rows } = await this.pool.query(sql, params);
    return rows;
  }

  private async runStmts(stmts: Array<[string, unknown[]]>): Promise<void> {
    for (const [sql, params] of stmts) {
      try { await this.pool.query(sql, params); }
      catch (e) { console.warn(`[smoke] cleanup skip: ${(e as Error).message}`); }
    }
  }

  /** Run-scoped cleanup, dispatched per flow. Always children → parents,
   *  always test-user scoped. There are no pipeline_run_id FKs in the
   *  schema — linkage is by applicationId / slug / importId / repo. */
  async cleanupRun(t: CleanupTarget): Promise<void> {
    this.guard();
    const uid = this.testUserId;
    const rid = t.pipelineRunId ?? null;
    if (t.flow === 'job-strategist') {
      const app = t.applicationId ?? null;
      await this.runStmts([
        // coaching_content/resumes are FK-bound to job_applications; delete
        // children first so the parent delete cannot be blocked.
        ['DELETE FROM coaching_content WHERE job_application_id IN (SELECT id FROM job_applications WHERE user_id = $1 AND ($2::uuid IS NULL OR id = $2))', [uid, app]],
        ['DELETE FROM resumes WHERE user_id = $1 AND ($2::uuid IS NULL OR job_application_id = $2)', [uid, app]],
        ['DELETE FROM job_applications WHERE user_id = $1 AND ($2::uuid IS NULL OR id = $2)', [uid, app]],
        ['DELETE FROM pipeline_runs WHERE user_id = $1 AND ($2::uuid IS NULL OR id = $2)', [uid, rid]],
      ]);
    } else if (t.flow === 'article-pipeline') {
      const slug = t.slug ?? null;
      await this.runStmts([
        ['DELETE FROM articles WHERE slug = $1 AND author_id = $2', [slug, uid]],
        ['DELETE FROM pipeline_runs WHERE user_id = $1 AND ($2::uuid IS NULL OR id = $2)', [uid, rid]],
      ]);
    } else if (t.flow === 'resume-import') {
      const imp = t.importId ?? null;
      await this.runStmts([
        // experience_embeddings cascades from user_career_history.
        ['DELETE FROM user_career_history WHERE user_id = $1 AND ($2::uuid IS NULL OR import_id = $2)', [uid, imp]],
        ['DELETE FROM resume_imports WHERE user_id = $1 AND ($2::uuid IS NULL OR id = $2)', [uid, imp]],
      ]);
    } else if (t.flow === 'ingestion') {
      const repo = t.repoFullName ?? null;
      await this.runStmts([
        ['DELETE FROM document_embeddings WHERE user_id = $1 AND ($2::text IS NULL OR repo_full_name = $2)', [uid, repo]],
        ['DELETE FROM repo_sync_state WHERE user_id = $1 AND ($2::text IS NULL OR repo_full_name = $2)', [uid, repo]],
        // Ingestion tracks progress on repo_sync_state, but a pipeline_runs
        // row may still be created for the trigger — clean it if recorded.
        ['DELETE FROM pipeline_runs WHERE user_id = $1 AND ($2::uuid IS NULL OR id = $2)', [uid, rid]],
      ]);
    }
  }

  /** Best-effort safety net: purge any residual test-user rows across all
   *  flow tables (used when a per-run target was never recorded). */
  async cleanupUserScoped(): Promise<void> {
    this.guard();
    const uid = this.testUserId;
    await this.runStmts([
      ['DELETE FROM coaching_content WHERE job_application_id IN (SELECT id FROM job_applications WHERE user_id = $1)', [uid]],
      ['DELETE FROM resumes WHERE user_id = $1', [uid]],
      ['DELETE FROM job_applications WHERE user_id = $1', [uid]],
      ['DELETE FROM articles WHERE author_id = $1', [uid]],
      ['DELETE FROM pipeline_runs WHERE user_id = $1', [uid]],
      ['DELETE FROM user_career_history WHERE user_id = $1', [uid]],
      ['DELETE FROM resume_imports WHERE user_id = $1', [uid]],
      ['DELETE FROM document_embeddings WHERE user_id = $1', [uid]],
      ['DELETE FROM repo_sync_state WHERE user_id = $1', [uid]],
    ]);
  }

  /** Delete one authenticated-chatbot session: chat_messages first, then
   *  chat_sessions (FK CASCADE would cover messages, but the explicit
   *  delete keeps cleanup deterministic and self-documenting). Scoped to
   *  test user + session so a stray id can never widen the blast radius. */
  async cleanupChatSession(sessionId: string): Promise<void> {
    this.guard();
    await this.runStmts([
      ['DELETE FROM chat_messages WHERE user_id = $1 AND session_id = $2', [this.testUserId, sessionId]],
      ['DELETE FROM chat_sessions WHERE user_id = $1 AND id = $2', [this.testUserId, sessionId]],
    ]);
  }

  async close(): Promise<void> { await this.pool.end(); }
}

/** Resolve the platform `users.id` (gen_random_uuid, NOT the Cognito sub)
 *  for the dedicated test user by email. Read-only — no mutation, so the
 *  assertSafeToMutate guard does not apply; every downstream mutating call
 *  is then scoped to this real users.id. */
export async function resolvePlatformUserId(opts: {
  host: string; port: number; database: string; user: string; password: string; email: string;
}): Promise<string> {
  const pool = new Pool({
    host: opts.host, port: opts.port, database: opts.database,
    user: opts.user, password: opts.password, max: 1,
    connectionTimeoutMillis: 10_000,
  });
  try {
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1', [opts.email]);
    const id = (rows[0] as { id?: string } | undefined)?.id;
    if (!id) {
      throw new SmokeSetupError(
        `No platform users row for "${opts.email}". The dev Cognito test `
        + `user has not been provisioned in RDS yet — trigger one `
        + `authenticated flow (or seed the row) before running the smoke suite.`);
    }
    return id;
  } finally {
    await pool.end();
  }
}

export async function connectRds(opts: {
  host: string; port: number; database: string; user: string; password: string; testUserId: string;
}): Promise<RdsClient> {
  assertSafeToMutate(opts.database, opts.testUserId);
  const pool = new Pool({
    host: opts.host, port: opts.port, database: opts.database,
    user: opts.user, password: opts.password, max: 4,
    connectionTimeoutMillis: 10_000,
  });
  return new RdsClient(pool as unknown as QueryablePool, opts.database, opts.testUserId);
}
