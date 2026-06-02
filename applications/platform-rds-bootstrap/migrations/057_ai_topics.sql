-- 057_ai_topics.sql — AI-Augmented Engineering topic catalog (constraint-only).
-- Mirrors 051_dsa_topics. Global (no user_id, no RLS), idempotent. The detector emits 5 of
-- these (prompt_caching, mcp_integration, grounding, eval_quality, cost_engineering); the rest
-- seed the catalog for future JD-calibration. Retrieved 2026-06-02.
BEGIN;
CREATE TABLE IF NOT EXISTS ai_topics (
  canonical_name     TEXT PRIMARY KEY,
  display_name       TEXT NOT NULL,
  category           TEXT NOT NULL,
  jd_signal_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  source             TEXT NOT NULL,
  as_of              DATE NOT NULL
);
INSERT INTO ai_topics (canonical_name, display_name, category, jd_signal_keywords, source, as_of) VALUES
('ai_llm_integration','LLM Integration','integration','["llm","bedrock","openai","anthropic","inference"]'::jsonb,'AI-eng taxonomy, design-input §3b','2026-06-02'),
('ai_prompt_engineering','Prompt Engineering','prompting','["prompt","system prompt","few-shot","prompt template"]'::jsonb,'design-input §3b','2026-06-02'),
('ai_prompt_caching','Prompt Caching','prompting','["prompt cache","cachepoint","cache","latency"]'::jsonb,'design-input §3b','2026-06-02'),
('ai_mcp_integration','MCP Integration','agents','["mcp","model context protocol","tools","agent tooling"]'::jsonb,'design-input §3b','2026-06-02'),
('ai_agent_orchestration','Agent Orchestration','agents','["agent","orchestration","langgraph","crewai","multi-agent","supervisor"]'::jsonb,'design-input §3b','2026-06-02'),
('ai_grounding','Grounding & Verification','quality','["grounding","hallucination","verification","citations","faithfulness"]'::jsonb,'design-input §3b','2026-06-02'),
('ai_eval_quality','Eval & Quality Engineering','quality','["evals","eval","golden dataset","regression","rubric","llm-as-judge"]'::jsonb,'design-input §3b','2026-06-02'),
('ai_cost_engineering','Cost Engineering','infra','["token cost","cost attribution","budget","model selection","batching"]'::jsonb,'design-input §3b','2026-06-02'),
('ai_observability','AI Observability','infra','["tracing","prompt observability","llm logging","inference monitoring"]'::jsonb,'design-input §3b','2026-06-02'),
('ai_safety_security','AI Safety & Security','quality','["prompt injection","input sanitisation","pii","output sanitisation","guardrails"]'::jsonb,'design-input §3b','2026-06-02'),
('ai_rag_retrieval','RAG & Retrieval','retrieval','["rag","retrieval","reranking","hybrid search","vector"]'::jsonb,'design-input §3b','2026-06-02'),
('ai_embeddings','Embeddings','retrieval','["embeddings","vector","pgvector","semantic search"]'::jsonb,'design-input §3b','2026-06-02')
ON CONFLICT (canonical_name) DO UPDATE SET
  display_name=EXCLUDED.display_name, category=EXCLUDED.category,
  jd_signal_keywords=EXCLUDED.jd_signal_keywords, source=EXCLUDED.source, as_of=EXCLUDED.as_of;
COMMIT;
