-- 111_article_topic_candidates.sql
-- Article topic candidates mined from case-study evidence.
--
-- The Project case-study generator already loads a repo's evidence and
-- synthesises project_challenges / project_decisions (problem -> resolution ->
-- value). A cheap discovery step transforms those into narrow, problem-framed
-- article candidates — no repo re-scan. The admin builder surfaces them as a
-- pre-seeded dropdown; the chosen candidate becomes a structured brief for the
-- article pipeline.
--
-- Keyed by github_repo_id (BIGINT — the canonical repo anchor that survives
-- renames, per migrations 084-086), never repo_full_name. user_id-scoped so a
-- future v2 can open the feature to non-admin users with no schema change.
--
-- verified_metrics carries the repo's real measured numbers (cost, latency,
-- RCU, % change) extracted from cited commits/PRs/diffs, so the Writer can cite
-- them and QA treats them as verified rather than fabricated (Gap 3).
--
-- Idempotent (CREATE ... IF NOT EXISTS) per ADR 0009.
CREATE TABLE IF NOT EXISTS article_topic_candidates (
    id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                UUID        NOT NULL REFERENCES users(id),
    github_repo_id         BIGINT      NOT NULL,
    repo_full_name         TEXT,
    project_id             UUID,
    source_pipeline_run_id UUID,
    title                  TEXT        NOT NULL,
    problem                TEXT        NOT NULL,
    angle                  TEXT,
    primary_keyword        TEXT,
    evidence_refs          JSONB       NOT NULL DEFAULT '[]'::jsonb,
    verified_metrics       JSONB       NOT NULL DEFAULT '[]'::jsonb,
    skills                 TEXT[]      NOT NULL DEFAULT '{}',
    status                 TEXT        NOT NULL DEFAULT 'suggested'
                             CHECK (status IN ('suggested', 'used', 'dismissed')),
    used_article_slug      TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_article_topic_candidates_repo
    ON article_topic_candidates (user_id, github_repo_id, status);
