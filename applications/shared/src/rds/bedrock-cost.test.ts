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

  it('prices the bare Sonnet id (CloudWatch ModelId) like the dated Sonnet id', () => {
    const bare  = computeCostCents('eu.anthropic.claude-sonnet-4-6', 1000, 500);
    const dated = computeCostCents('eu.anthropic.claude-sonnet-4-6-20260310-v1:0', 1000, 500);
    expect(bare.totalCostCents).toBeCloseTo(dated.totalCostCents, 6);
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
    expect(insert!.params[0]).toBe('job-strategist');      // $1 pipeline
    expect(insert!.params[9]).toBe(100);                    // $10 user_message_tokens = 80 + 20
    expect(insert!.params[10]).toBe(50);                    // $11 output_tokens
  });

  it('skips recording (no query) when the log has no userId', async () => {
    const { pool, query } = fakePool();
    await recordInvocationToRds(pool, 'job-strategist')({ ...baseLog, userId: undefined });
    expect(query).not.toHaveBeenCalled();
  });
});
