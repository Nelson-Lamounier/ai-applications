import type { Pool } from 'pg';
import type { AgentInvocationLog } from '../types.js';

// Pricing in USD cents per 1K tokens (eu-west-1, May 2026).
// NOTE: EU cross-region inference surcharge is not in AWS Pricing API; these
// are US base rates used as a conservative floor. Revisit when AWS/Anthropic
// publish EU-specific rates.
const PRICING: Record<string, { inputCentsPerK: number; outputCentsPerK: number }> = {
  'eu.anthropic.claude-haiku-4-5-20251001-v1:0': {
    inputCentsPerK:  0.080,   // $0.80/1M = $0.00080/1K = 0.080 cents/1K
    outputCentsPerK: 0.400,
  },
  // Bare (non-EU-profile) id — BedrockChunkEnricher's DEFAULT_MODEL_ID when
  // ENRICHMENT_MODEL_ID is unset. Same rates; without this it would fall back
  // to DEFAULT_PRICING (Sonnet) and over-bill Haiku ~3.75x.
  'anthropic.claude-haiku-4-5-20251001-v1:0': {
    inputCentsPerK:  0.080,
    outputCentsPerK: 0.400,
  },
  // Bare Sonnet id — the ModelId CloudWatch actually reports for Converse
  // calls (e.g. self-healing, chatbots, case-study, article-pipeline) is
  // `eu.anthropic.claude-sonnet-4-6` without a dated version suffix (the
  // versioned form is not a valid eu inference-profile id). Same rates;
  // mapping it explicitly avoids relying on DEFAULT_PRICING coincidentally
  // being Sonnet rates.
  'eu.anthropic.claude-sonnet-4-6': {
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
  pipeline:     'resume-import' | 'repo-sync' | 'profile-extraction' | 'retrieval-probe' | 'profile-synthesis' | 'profile-direction' | 'profile-reconciliation' | 'profile-diagnostic' | 'chatbot-public' | 'chatbot-authenticated' | 'job-strategist' | 'article-pipeline' | 'project-clustering' | 'project-case-study' | 'grounding-verify' | 'prose-lint';
  inputTokens:  number;
  outputTokens: number;
  importId?:    string;
  repoName?:    string;
  // Granular attribution (migration 082). Populated only where the id is in
  // scope at the call site: applicationId by the job-strategist pipeline,
  // projectId by the project-case-study pipeline, and syncKind by repo-sync
  // rows ('initial' | 'full_reindex' | 'incremental'). NULL otherwise.
  applicationId?: string;
  projectId?:     string;
  syncKind?:      string;
  // Converse agents (via recordInvocationToRds) supply their real agent name,
  // system-prompt hash, and measured latency. Raw InvokeModel callers
  // (embeddings, chunk enrichment) omit them and fall back to the
  // __direct_invoke__ sentinel / 0 below.
  agent?:            string;
  systemPromptHash?: string;
  latencyMs?:        number;
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

  // agent / system_prompt_hash are NOT NULL. Converse agents pass their real
  // values; raw InvokeModel callers (embeddings, enrichment) fall back to the
  // __direct_invoke__ sentinel.
  await pool.query(
    `INSERT INTO prompt_invocations
       (pipeline, agent, model_id, system_prompt_hash, input_cost_cents, output_cost_cents,
        total_cost_cents, latency_ms, user_id, import_id, repo_name,
        application_id, project_id, sync_kind,
        system_prompt_tokens, user_message_tokens, output_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid, $10, $11, $12::uuid, $13::uuid, $14, 0, $15, $16)`,
    [
      record.pipeline,                            // $1  pipeline
      record.agent ?? '__direct_invoke__',        // $2  agent
      record.modelId,                             // $3  model_id
      record.systemPromptHash ?? '__direct_invoke__', // $4  system_prompt_hash
      inputCostCents,                             // $5  input_cost_cents
      outputCostCents,                            // $6  output_cost_cents
      totalCostCents,                             // $7  total_cost_cents
      record.latencyMs ?? 0,                      // $8  latency_ms
      record.userId,                              // $9  user_id
      record.importId ?? null,                    // $10 import_id
      record.repoName ?? null,                    // $11 repo_name
      record.applicationId ?? null,               // $12 application_id
      record.projectId ?? null,                   // $13 project_id
      record.syncKind ?? null,                    // $14 sync_kind
      record.inputTokens,                         // $15 user_message_tokens
      record.outputTokens,                        // $16 output_tokens
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

/**
 * Adapt the shared agent runner's {@link AgentInvocationLog} to a
 * `recordBedrockCost` call. Returns a callback suitable for
 * `BasePipelineContext.onInvocationComplete`, so every Converse agent in a
 * pipeline books its spend into `prompt_invocations` — pricing is recomputed
 * from the model id (single source of truth) rather than trusting the runner's
 * coarse 60/40 cost split.
 *
 * Skips records with no userId: prompt_invocations.user_id is a NOT NULL uuid,
 * and an unattributed agent call should be surfaced via CloudWatch/CE, not a
 * fabricated user.
 */
export function recordInvocationToRds(
  pool: Pool,
  pipeline: CostRecord['pipeline'],
  context?: { applicationId?: string; projectId?: string; syncKind?: string },
): (log: AgentInvocationLog) => Promise<void> {
  return async (log) => {
    if (!log.userId) {
      console.warn('[bedrock-cost] skipping invocation record — no userId', {
        pipeline, agent: log.agent, modelId: log.modelId,
      });
      return;
    }
    await recordBedrockCost(pool, {
      userId:       log.userId,
      modelId:      log.modelId,
      pipeline,
      agent:            log.agent,
      systemPromptHash: log.systemPromptHash,
      latencyMs:        log.latencyMs,
      applicationId:    context?.applicationId,
      projectId:        context?.projectId,
      syncKind:         context?.syncKind,
      // Converse reports a single input figure; the runner stores it under
      // systemPromptTokens with userMessageTokens = 0.
      inputTokens:  log.systemPromptTokens + log.userMessageTokens,
      outputTokens: log.outputTokens,
    });
  };
}
