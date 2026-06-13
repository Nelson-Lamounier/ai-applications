-- =============================================================================
-- 078_repo_profile.sql
-- =============================================================================
-- Repository Profile layer, Increment 1 (docs/repository-profile-strategy.md).
--
-- Per-run snapshot of each ingested repo's IDENTITY, assembled deterministically
-- from its archetype signals (folder structure) + code-extracted technologies:
--   repo_type      — cdk-infra | k8s-platform | application | ml | … (deterministic cascade)
--   frameworks     — IaC/delivery frameworks the code uses (aws_cdk, terraform, helm)
--   services       — cloud services the repo provisions/operates (aws_eks, aws_rds, …)
--   concepts       — higher-level patterns (gitops, observability, provisions-managed-kubernetes)
--   summary        — one-line natural-language identity (added in Increment 2; nullable now)
--
-- Gives the resume pipeline a repo-level identity ("cdk-monitoring IS the EKS-via-CDK
-- infra repo") instead of isolated tech names. Idempotent DDL; upsert on the run+repo key.
-- =============================================================================

CREATE TABLE IF NOT EXISTS repo_profile (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline_run_id  UUID NOT NULL,
    user_id          UUID NOT NULL,
    repo_full_name   TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    repo_type        TEXT NOT NULL,
    frameworks       TEXT[] NOT NULL DEFAULT '{}',
    services         TEXT[] NOT NULL DEFAULT '{}',
    concepts         TEXT[] NOT NULL DEFAULT '{}',
    summary          TEXT,
    UNIQUE (pipeline_run_id, repo_full_name)
);

CREATE INDEX IF NOT EXISTS idx_repo_profile_repo_time ON repo_profile (repo_full_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repo_profile_type      ON repo_profile (repo_type);
