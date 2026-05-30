-- =============================================================================
-- Migration 011 — Prompt Quality Observability
--
-- Two tables for measuring and improving AI prompt quality:
--
--   1. prompt_invocations — one row per Bedrock agent call,
--      capturing tokens, cost, latency, cache hit, and hashes
--      so prompt changes can be correlated with quality shifts.
--
--   2. prompt_feedback — user thumbs-up/down ratings linked
--      to specific invocations, forming a quality signal loop.
--
-- Written by the pipeline jobs (job-strategist, article-pipeline,
-- resume-import-processor) via the onInvocationComplete callback
-- in shared/src/agent-runner.ts.
-- =============================================================================

-- =============================================================================
-- 1. prompt_invocations — per-call Bedrock audit log
-- =============================================================================
CREATE TABLE IF NOT EXISTS prompt_invocations (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Agent identity
  pipeline                TEXT NOT NULL,    -- 'job-strategist' | 'article-pipeline' | 'resume-import'
  agent                   TEXT NOT NULL,    -- agentName from AgentConfig
  model_id                TEXT NOT NULL,

  -- Prompt version tracking
  prompt_version          TEXT,             -- PROMPT_VERSION env var from the pod
  prompt_id               TEXT,             -- logical prompt identifier (e.g. 'strategist-persona-v3')

  -- Prompt fingerprints — SHA-256 of the serialised content
  system_prompt_hash      TEXT NOT NULL,
  output_hash             TEXT,             -- SHA-256 of the response text (null on error)

  -- Token breakdown
  system_prompt_tokens    INTEGER NOT NULL DEFAULT 0,
  user_message_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens           INTEGER NOT NULL DEFAULT 0,
  cache_tokens_saved      INTEGER NOT NULL DEFAULT 0,   -- cacheReadInputTokens

  -- Cost (in integer cents to avoid float drift)
  input_cost_cents        INTEGER NOT NULL DEFAULT 0,
  output_cost_cents       INTEGER NOT NULL DEFAULT 0,
  total_cost_cents        INTEGER NOT NULL DEFAULT 0,

  -- Performance
  latency_ms              INTEGER NOT NULL,
  cache_hit               BOOLEAN NOT NULL DEFAULT false,

  -- Tracing (optional — X-Ray or correlation ID)
  trace_id                TEXT,
  parent_invocation_id    UUID REFERENCES prompt_invocations(id) ON DELETE SET NULL,

  -- Context — who triggered this invocation
  user_id                 UUID REFERENCES users(id) ON DELETE SET NULL,
  resume_generation_id    UUID,             -- resume ID from the tailored-resume table

  -- Lifecycle
  invoked_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prompt_invocations_pipeline_agent
  ON prompt_invocations (pipeline, agent, invoked_at DESC);

CREATE INDEX IF NOT EXISTS idx_prompt_invocations_user
  ON prompt_invocations (user_id, invoked_at DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prompt_invocations_prompt_id
  ON prompt_invocations (prompt_id, invoked_at DESC)
  WHERE prompt_id IS NOT NULL;

-- Partial index for cache-hit analytics
CREATE INDEX IF NOT EXISTS idx_prompt_invocations_cache_miss
  ON prompt_invocations (pipeline, agent, invoked_at DESC)
  WHERE cache_hit = false;

-- =============================================================================
-- 2. prompt_feedback — user quality ratings per invocation
-- =============================================================================
CREATE TABLE IF NOT EXISTS prompt_feedback (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Link to the specific invocation that generated the output
  invocation_id       UUID REFERENCES prompt_invocations(id) ON DELETE CASCADE,

  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Rating: 1 = thumbs up, -1 = thumbs down
  rating              SMALLINT NOT NULL CHECK (rating IN (-1, 1)),

  -- Optional free-text note from the user
  feedback_text       TEXT,

  -- Structured issue tags (e.g. ['wrong_skills', 'off_tone', 'missing_context'])
  feedback_categories TEXT[] NOT NULL DEFAULT '{}',

  -- Admin triage fields
  admin_reviewed      BOOLEAN NOT NULL DEFAULT false,
  admin_notes         TEXT,
  -- 'low' | 'medium' | 'high' | 'critical'
  admin_severity      TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prompt_feedback_invocation
  ON prompt_feedback (invocation_id);

CREATE INDEX IF NOT EXISTS idx_prompt_feedback_user
  ON prompt_feedback (user_id, created_at DESC);

-- Partial index for admin review queue
CREATE INDEX IF NOT EXISTS idx_prompt_feedback_unreviewed
  ON prompt_feedback (created_at DESC)
  WHERE admin_reviewed = false AND rating = -1;

-- =============================================================================
-- Verification
-- =============================================================================
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public'
--     AND table_name IN ('prompt_invocations', 'prompt_feedback');
