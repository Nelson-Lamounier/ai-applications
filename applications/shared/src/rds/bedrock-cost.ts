import type { Pool } from 'pg';

// Pricing in USD cents per 1K tokens (eu-west-1, May 2026).
// NOTE: EU cross-region inference surcharge is not in AWS Pricing API; these
// are US base rates used as a conservative floor. Revisit when AWS/Anthropic
// publish EU-specific rates.
const PRICING: Record<string, { inputCentsPerK: number; outputCentsPerK: number }> = {
  'eu.anthropic.claude-haiku-4-5-20251001-v1:0': {
    inputCentsPerK:  0.080,   // $0.80/1M = $0.00080/1K = 0.080 cents/1K
    outputCentsPerK: 0.400,
  },
  'eu.anthropic.claude-sonnet-4-6-20260310-v1:0': {
    inputCentsPerK:  0.300,
    outputCentsPerK: 1.500,
  },
  'amazon.titan-embed-text-v2:0': {
    inputCentsPerK:  0.0026004,  // $0.026004/1M confirmed eu-west-1
    outputCentsPerK: 0,
  },
};

const DEFAULT_PRICING = { inputCentsPerK: 0.300, outputCentsPerK: 1.500 };
const DEFAULT_MONTHLY_LIMIT_CENTS = 500;

export interface CostRecord {
  userId:       string;
  modelId:      string;
  pipeline:     'resume-import' | 'repo-sync' | 'profile-extraction';
  inputTokens:  number;
  outputTokens: number;
  importId?:    string;
  repoName?:    string;
}

export function computeCostCents(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): {
  inputCostCents:  number;
  outputCostCents: number;
  totalCostCents:  number;
} {
  const p = PRICING[modelId] ?? DEFAULT_PRICING;
  const inputCostCents  = Math.round((inputTokens  / 1000) * p.inputCentsPerK  * 1_000_000) / 1_000_000;
  const outputCostCents = Math.round((outputTokens / 1000) * p.outputCentsPerK * 1_000_000) / 1_000_000;
  return {
    inputCostCents,
    outputCostCents,
    totalCostCents: inputCostCents + outputCostCents,
  };
}

async function getMonthlySpendCents(pool: Pool, userId: string): Promise<number> {
  const result = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(total_cost_cents), 0) AS total
       FROM prompt_invocations
      WHERE user_id = $1::uuid
        AND invoked_at >= date_trunc('month', NOW())`,
    [userId],
  );
  return Number.parseFloat(result.rows[0]?.total ?? '0');
}

async function getOrCreateBudget(
  pool: Pool,
  userId: string,
): Promise<{ monthlyLimitCents: number; alertThresholdPct: number }> {
  await pool.query(
    `INSERT INTO user_token_budgets (user_id) VALUES ($1::uuid)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  const result = await pool.query<{ monthly_limit_cents: number; alert_threshold_pct: number }>(
    `SELECT monthly_limit_cents, alert_threshold_pct FROM user_token_budgets WHERE user_id = $1::uuid`,
    [userId],
  );
  const row = result.rows[0];
  return {
    monthlyLimitCents: row?.monthly_limit_cents  ?? DEFAULT_MONTHLY_LIMIT_CENTS,
    alertThresholdPct: row?.alert_threshold_pct  ?? 80,
  };
}

export async function recordBedrockCost(pool: Pool, record: CostRecord): Promise<void> {
  const { inputCostCents, outputCostCents, totalCostCents } = computeCostCents(
    record.modelId, record.inputTokens, record.outputTokens,
  );

  // agent column is required NOT NULL — use pipeline name for InvokeModel calls
  // (they have no agentName concept unlike the Converse API pipeline)
  await pool.query(
    `INSERT INTO prompt_invocations
       (pipeline, agent, model_id, system_prompt_hash, input_cost_cents, output_cost_cents,
        total_cost_cents, latency_ms, user_id, import_id, repo_name,
        system_prompt_tokens, user_message_tokens, output_tokens)
     VALUES ($1, $2, $3, '__direct_invoke__', $4, $5, $6, 0, $7::uuid, $8, $9, 0, $10, $11)`,
    [
      record.pipeline,           // $1 pipeline
      '__direct_invoke__',       // $2 agent
      record.modelId,            // $3 model_id
      inputCostCents,            // $4 input_cost_cents
      outputCostCents,           // $5 output_cost_cents
      totalCostCents,            // $6 total_cost_cents
      record.userId,             // $7 user_id
      record.importId ?? null,   // $8 import_id
      record.repoName ?? null,   // $9 repo_name
      record.inputTokens,        // $10 user_message_tokens
      record.outputTokens,       // $11 output_tokens
    ],
  );

  const spend  = await getMonthlySpendCents(pool, record.userId);
  const budget = await getOrCreateBudget(pool, record.userId);
  const threshold = budget.monthlyLimitCents * (budget.alertThresholdPct / 100);

  if (spend >= budget.monthlyLimitCents) {
    console.warn('[bedrock-cost] user exceeded monthly budget', {
      userId:     record.userId,
      spendCents: spend,
      limitCents: budget.monthlyLimitCents,
    });
    // NOTE(production): throw BudgetExceededError here to reject job start
    // when spend >= monthlyLimitCents (pre-flight check, not post-call).
  } else if (spend >= threshold) {
    console.warn('[bedrock-cost] user approaching monthly budget', {
      userId:     record.userId,
      spendCents: spend,
      limitCents: budget.monthlyLimitCents,
      pct: Math.round((spend / budget.monthlyLimitCents) * 100),
    });
  }
}
