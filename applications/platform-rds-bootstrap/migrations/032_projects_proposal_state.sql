-- 032_projects_proposal_state.sql
--
-- Phase 2A — Project Clustering Service.
--
-- Adds AI-suggestion provenance to the `projects` table so the clustering
-- service can record *why* a multi-repo grouping was proposed. Proposals
-- live as `projects` rows with `is_ai_suggested=true` / `is_user_confirmed=false`
-- per the migration spec; only the run id, confidence, and reasoning are
-- new metadata — the proposal itself is the existing row.
--
-- Three additive columns, all nullable / no defaults — fully backward
-- compatible with the running app. Per ROLLBACK.md §"Expand / Contract"
-- this is an Expand-only migration.
--
-- Idempotent via ADD COLUMN IF NOT EXISTS.

BEGIN;

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS proposal_pipeline_run_id UUID
        REFERENCES pipeline_runs(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS proposal_reasoning       TEXT,
    ADD COLUMN IF NOT EXISTS proposal_confidence      TEXT
        CHECK (proposal_confidence IS NULL
               OR proposal_confidence IN ('high','medium','low'));

-- Faster filtering of unconfirmed AI proposals by run, e.g. the upcoming
-- review-step UI in Phase 5.
CREATE INDEX IF NOT EXISTS idx_projects_proposal_run
    ON projects (proposal_pipeline_run_id)
    WHERE is_ai_suggested = TRUE AND is_user_confirmed = FALSE;

COMMIT;
