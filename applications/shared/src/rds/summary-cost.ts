/** @format */
import type { Pool } from 'pg';

export interface SummaryCostPass {
  agent: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  latencyMs: number;
}
export interface SummaryCostSummary {
  passes: SummaryCostPass[];
  total: { calls: number; inputTokens: number; outputTokens: number; costCents: number };
}

/**
 * Per-application isolated cost of the summary passes (strategist-summary +
 * strategist-summary-rewrite). Parameterised, read-only, user-agnostic.
 */
export async function summarizeSummaryCost(pool: Pool, applicationId: string): Promise<SummaryCostSummary> {
  const res = await pool.query<{
    agent: string; model_id: string; input_tokens: string;
    output_tokens: string; total_cost_cents: string; latency_ms: string;
  }>(
    `SELECT agent, model_id,
            (system_prompt_tokens + user_message_tokens) AS input_tokens,
            output_tokens, total_cost_cents, latency_ms
       FROM prompt_invocations
      WHERE application_id = $1::uuid
        AND agent LIKE 'strategist-summary%'
      ORDER BY invoked_at`,
    [applicationId],
  );
  const passes: SummaryCostPass[] = res.rows.map((r) => ({
    agent: r.agent,
    model: r.model_id,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    costCents: Number(r.total_cost_cents),
    latencyMs: Number(r.latency_ms),
  }));
  const total = passes.reduce(
    (a, p) => ({
      calls: a.calls + 1,
      inputTokens: a.inputTokens + p.inputTokens,
      outputTokens: a.outputTokens + p.outputTokens,
      costCents: a.costCents + p.costCents,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, costCents: 0 },
  );
  return { passes, total };
}
