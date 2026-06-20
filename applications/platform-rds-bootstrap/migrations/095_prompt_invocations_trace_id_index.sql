CREATE INDEX IF NOT EXISTS idx_prompt_invocations_trace_id
  ON prompt_invocations (trace_id, invoked_at DESC)
  INCLUDE (pipeline, agent, model_id, project_id, total_cost_cents, latency_ms)
  WHERE trace_id IS NOT NULL;
