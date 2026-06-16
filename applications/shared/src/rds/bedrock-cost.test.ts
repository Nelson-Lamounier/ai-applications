import { computeCostCents, recordInvocationToRds } from './bedrock-cost';
import type { AgentInvocationLog } from '../types.js';

describe('computeCostCents', () => {
  it('computes Haiku costs correctly', () => {
    const result = computeCostCents(
      'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
      1000,
      500,
    );
    expect(result.inputCostCents).toBeCloseTo(0.080, 3);
    expect(result.outputCostCents).toBeCloseTo(0.200, 3);
    expect(result.totalCostCents).toBeCloseTo(0.280, 3);
  });

  it('computes Titan costs correctly (output is zero)', () => {
    const result = computeCostCents('amazon.titan-embed-text-v2:0', 500, 0);
    expect(result.inputCostCents).toBeCloseTo(0.0013002, 6);
    expect(result.outputCostCents).toBe(0);
  });

  it('falls back to default pricing for unknown model', () => {
    const result = computeCostCents('unknown-model', 1000, 1000);
    expect(result.totalCostCents).toBeGreaterThan(0);
  });

  it('prices the bare (non-EU) Haiku id like the EU profile id', () => {
    const bare = computeCostCents('anthropic.claude-haiku-4-5-20251001-v1:0', 1000, 500);
    const eu   = computeCostCents('eu.anthropic.claude-haiku-4-5-20251001-v1:0', 1000, 500);
    expect(bare.totalCostCents).toBeCloseTo(eu.totalCostCents, 6);
  });

  it('prices the bare Sonnet id (the only valid eu inference-profile form)', () => {
    // The dated `...-20260310-v1:0` form is not a valid eu inference-profile
    // id; every agent emits the bare `eu.anthropic.claude-sonnet-4-6`. Verify
    // it maps to Sonnet rates explicitly (input 0.300 / output 1.500 per 1k).
    const sonnet = computeCostCents('eu.anthropic.claude-sonnet-4-6', 1000, 500);
    expect(sonnet.inputCostCents).toBeCloseTo(0.300, 3);
    expect(sonnet.outputCostCents).toBeCloseTo(0.750, 3);
    expect(sonnet.totalCostCents).toBeCloseTo(1.050, 3);
  });
});

describe('recordInvocationToRds', () => {
  const baseLog: AgentInvocationLog = {
    pipeline: 'p', agent: 'research', modelId: 'eu.anthropic.claude-sonnet-4-6',
    promptVersion: undefined, promptId: undefined, systemPromptHash: 'h', outputHash: 'o',
    systemPromptTokens: 100, userMessageTokens: 0, outputTokens: 50, cacheTokensSaved: 0,
    inputCostCents: 0, outputCostCents: 0, totalCostCents: 0, latencyMs: 1, cacheHit: false,
    traceId: undefined, userId: 'user-1', resumeGenerationId: undefined,
  };

  function fakePool() {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (/SUM\(total_cost_cents\)/.test(sql)) return { rows: [{ total: '0' }] };
      return { rows: [{ monthly_limit_cents: 500, alert_threshold_pct: 80 }] };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { pool: { query } as any, queries, query };
  }

  it('maps an invocation log to an INSERT with the given pipeline + summed input tokens', async () => {
    const { pool, queries } = fakePool();
    await recordInvocationToRds(pool, 'job-strategist')({
      ...baseLog, systemPromptTokens: 80, userMessageTokens: 20, outputTokens: 50,
    });
    const insert = queries.find((q) => /INSERT INTO prompt_invocations/.test(q.sql));
    expect(insert).toBeTruthy();
    expect(insert!.params[0]).toBe('job-strategist');      // $1  pipeline
    expect(insert!.params[1]).toBe('research');             // $2  agent (real name, not __direct_invoke__)
    expect(insert!.params[3]).toBe('h');                    // $4  system_prompt_hash (real hash)
    expect(insert!.params[7]).toBe(1);                      // $8  latency_ms (from log.latencyMs)
    expect(insert!.params[11]).toBeNull();                  // $12 application_id (no context supplied)
    expect(insert!.params[12]).toBeNull();                  // $13 project_id
    expect(insert!.params[13]).toBeNull();                  // $14 sync_kind
    expect(insert!.params[14]).toBe(100);                   // $15 user_message_tokens = 80 + 20
    expect(insert!.params[15]).toBe(50);                    // $16 output_tokens
  });

  it('threads applicationId/projectId/syncKind from the context into the INSERT', async () => {
    const { pool, queries } = fakePool();
    await recordInvocationToRds(pool, 'job-strategist', {
      applicationId: 'app-1', projectId: 'proj-1', syncKind: 'initial',
    })(baseLog);
    const insert = queries.find((q) => /INSERT INTO prompt_invocations/.test(q.sql));
    expect(insert!.params[11]).toBe('app-1');               // $12 application_id
    expect(insert!.params[12]).toBe('proj-1');              // $13 project_id
    expect(insert!.params[13]).toBe('initial');             // $14 sync_kind
  });

  it('skips recording (no query) when the log has no userId', async () => {
    const { pool, query } = fakePool();
    await recordInvocationToRds(pool, 'job-strategist')({ ...baseLog, userId: undefined });
    expect(query).not.toHaveBeenCalled();
  });
});
