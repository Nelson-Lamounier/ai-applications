-- 033_projects_case_study_status.sql
--
-- Phase 2B — Case Study Generation Service.
--
-- The case-study K8s Job populates a handful of existing tables
-- (project_decisions / project_highlights / project_challenges /
-- project_resume_bullets / project_depth_markers / project_architecture)
-- and the summary_embedding column on projects. This migration adds the
-- run-state columns needed to track where each project sits in the
-- generation lifecycle, plus content-hash columns on the child tables so
-- regeneration is idempotent and never overwrites identical evidence.
--
-- All changes are additive + nullable. Backward-compatible with the
-- running app per ROLLBACK.md §Expand/Contract.

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- projects: run-state for the case-study generation lifecycle.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS case_study_status TEXT
        CHECK (case_study_status IS NULL
               OR case_study_status IN ('pending','generating','complete','failed')),
    ADD COLUMN IF NOT EXISTS case_study_generated_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS case_study_pipeline_run_id   UUID
        REFERENCES pipeline_runs(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS case_study_model             TEXT,
    -- Stable hash of the model inputs (project context + KB chunks +
    -- commit list). When the hash is unchanged we can short-circuit
    -- without invoking Sonnet — semantic cache key derives from this.
    ADD COLUMN IF NOT EXISTS case_study_input_hash        TEXT,
    -- Stickiness map: each top-level case-study section the user has
    -- edited carries true here. Regeneration skips edited sections.
    -- Shape: { "pitch": true, "tagline": true, "decisions": ["uuid1", ...], ... }
    ADD COLUMN IF NOT EXISTS user_overrides               JSONB
        NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_projects_case_study_status
    ON projects (case_study_status)
    WHERE case_study_status IS NOT NULL AND case_study_status <> 'complete';

-- ──────────────────────────────────────────────────────────────────────────
-- Child tables: content-hash for idempotent regeneration.
--
-- Each AI-generated child row (decision / highlight / challenge) is keyed
-- by (project_id, content_hash) so re-running case-study generation does
-- NOT re-insert identical content. content_hash is computed by the writer
-- from the row's content + source_signals.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE project_decisions
    ADD COLUMN IF NOT EXISTS content_hash      TEXT,
    ADD COLUMN IF NOT EXISTS pipeline_run_id   UUID
        REFERENCES pipeline_runs(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_decisions_hash
    ON project_decisions (project_id, content_hash)
    WHERE content_hash IS NOT NULL;

ALTER TABLE project_highlights
    ADD COLUMN IF NOT EXISTS content_hash      TEXT,
    ADD COLUMN IF NOT EXISTS pipeline_run_id   UUID
        REFERENCES pipeline_runs(id) ON DELETE SET NULL,
    -- Evidence trail; mirrors project_decisions.source_signals.
    ADD COLUMN IF NOT EXISTS source_signals    JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_highlights_hash
    ON project_highlights (project_id, content_hash)
    WHERE content_hash IS NOT NULL;

ALTER TABLE project_challenges
    ADD COLUMN IF NOT EXISTS content_hash      TEXT,
    ADD COLUMN IF NOT EXISTS pipeline_run_id   UUID
        REFERENCES pipeline_runs(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_challenges_hash
    ON project_challenges (project_id, content_hash)
    WHERE content_hash IS NOT NULL;

ALTER TABLE project_stack_items
    ADD COLUMN IF NOT EXISTS content_hash      TEXT,
    ADD COLUMN IF NOT EXISTS pipeline_run_id   UUID
        REFERENCES pipeline_runs(id) ON DELETE SET NULL,
    -- Evidence trail.
    ADD COLUMN IF NOT EXISTS source_signals    JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_stack_items_hash
    ON project_stack_items (project_id, content_hash)
    WHERE content_hash IS NOT NULL;

-- ──────────────────────────────────────────────────────────────────────────
-- project_architecture: single-row-per-project already; add the
-- pipeline_run_id for traceability.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE project_architecture
    ADD COLUMN IF NOT EXISTS pipeline_run_id   UUID
        REFERENCES pipeline_runs(id) ON DELETE SET NULL;

-- ──────────────────────────────────────────────────────────────────────────
-- project_resume_bullets: same.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE project_resume_bullets
    ADD COLUMN IF NOT EXISTS pipeline_run_id   UUID
        REFERENCES pipeline_runs(id) ON DELETE SET NULL;

COMMIT;
