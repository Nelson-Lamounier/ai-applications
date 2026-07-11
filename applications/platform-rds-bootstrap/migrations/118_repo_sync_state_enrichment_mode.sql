-- =============================================================================
-- 118_repo_sync_state_enrichment_mode.sql
-- =============================================================================
-- Adds per-repo enrichment provenance and backfills the LLM ledger's repo id.
--
-- This migration is a three-step idempotent update:
--   1. Adds NULLABLE `enrichment_mode` and `enrichment_model` columns to
--      `repo_sync_state` so the portfolio can record which enrichment tier
--      (LLM or tier1) was applied to each repo.
--   2. Backfills `github_repo_id` on the LLM cost ledger (`prompt_invocations`)
--      from the stable repo key, joining on (user_id, repo_full_name).
--      Canonical-eval rows have no repository and are left NULL by design.
--   3. Backfills `enrichment_mode` and `enrichment_model` from the cost ledger:
--      a repo with >=1 `chunk-enrich` invocation was LLM-enriched; otherwise
--      tier1. The most recent model_id is recorded per repo.
--
-- Because every statement is additive and idempotent (`IF NOT EXISTS`/`WHERE`
-- guards), this migration is safe to re-run.
-- =============================================================================

BEGIN;

-- --- Step 1: Add enrichment_mode and enrichment_model columns ---------------
ALTER TABLE repo_sync_state
    ADD COLUMN IF NOT EXISTS enrichment_mode  text,
    ADD COLUMN IF NOT EXISTS enrichment_model text;

-- --- Step 2: Backfill github_repo_id on the LLM cost ledger ------------------
-- Join prompt_invocations (user_id, repo_name) against repositories (user_id,
-- full_name) to populate the immutable github_repo_id. Canonical-eval rows
-- have no repository and remain NULL.
UPDATE prompt_invocations pi
   SET github_repo_id = r.github_repo_id
  FROM repositories r
 WHERE pi.github_repo_id IS NULL
   AND r.user_id   = pi.user_id
   AND r.full_name = pi.repo_name;

-- --- Step 3: Backfill enrichment_mode and enrichment_model from history -----
-- A repo with >=1 chunk-enrich invocation was LLM-enriched, else tier1.
-- The most recent model_id is recorded per repo.
-- NOTE: 'none' (genuinely disabled enrichment) is a forward-only value written
-- by the worker at sync time; it cannot be reconstructed here because no
-- historical marker distinguishes a disabled run from a tier1 run. The absence
-- of 'none' in backfilled rows is expected, not a bug.
WITH llm AS (
    SELECT user_id, github_repo_id,
           (array_agg(model_id ORDER BY invoked_at DESC))[1] AS model_id
      FROM prompt_invocations
     WHERE agent = 'chunk-enrich' AND github_repo_id IS NOT NULL
     GROUP BY user_id, github_repo_id
)
UPDATE repo_sync_state s
   SET enrichment_mode  = CASE WHEN llm.user_id IS NOT NULL THEN 'llm' ELSE 'tier1' END,
       enrichment_model = llm.model_id
  FROM (SELECT DISTINCT user_id, github_repo_id FROM repo_sync_state WHERE github_repo_id IS NOT NULL) k
  LEFT JOIN llm ON llm.user_id = k.user_id AND llm.github_repo_id = k.github_repo_id
 WHERE s.user_id = k.user_id AND s.github_repo_id = k.github_repo_id;

COMMIT;
