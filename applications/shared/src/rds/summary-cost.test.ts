/** @format */
import { describe, it, expect } from '@jest/globals';
import { summarizeSummaryCost } from './summary-cost.js';

describe('summarizeSummaryCost', () => {
  it('returns per-pass rows and a summed total for the two summary agents', async () => {
    const rows = [
      { agent: 'strategist-summary', model_id: 'eu.anthropic.claude-sonnet-4-6', input_tokens: '15447', output_tokens: '247', total_cost_cents: '5.0046', latency_ms: '6974' },
      { agent: 'strategist-summary-rewrite', model_id: 'eu.anthropic.claude-sonnet-4-6', input_tokens: '16000', output_tokens: '250', total_cost_cents: '5.2', latency_ms: '7000' },
    ];
    const pool = { query: async () => ({ rows }) } as never;
    const r = await summarizeSummaryCost(pool, 'app-uuid');
    expect(r.passes).toHaveLength(2);
    expect(r.passes[0]).toEqual({ agent: 'strategist-summary', model: 'eu.anthropic.claude-sonnet-4-6', inputTokens: 15447, outputTokens: 247, costCents: 5.0046, latencyMs: 6974 });
    expect(r.total).toEqual({ calls: 2, inputTokens: 31447, outputTokens: 497, costCents: 10.2046 });
  });
});
