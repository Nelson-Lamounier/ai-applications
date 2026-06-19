-- =============================================================================
-- 096_tech_skill_map.sql
-- =============================================================================
-- Tiered enrichment (spec 003-tiered-enrichment), Tier 1.
--
-- Maps a canonical technology (technology_ontology canonical_name, the form that
-- lands in document_embeddings.metadata.file_tech_stack via the parallel
-- extract_tech) to one or more canonical skills (skill_ontology canonical_name).
-- This lets Tier 1 assign a chunk's skills deterministically from the file tech
-- evidence already on the chunk — ZERO model calls — so the per-chunk Haiku skill
-- call is only needed for the residue.
--
-- Each row is (tech_canonical -> skill_canonical): the direct tool-skill AND the
-- implied capability skill (e.g. aws_cdk -> "aws cdk" AND "infrastructure as
-- code"; calico -> "kubernetes networking"; jest -> "jest" AND "automated
-- testing"). Seeded from the live corpus's top file_tech_stack technologies
-- (verified on dev: aws_cdk 833 chunks, postgresql 594, react 529, ...), every
-- skill target an EXISTING active skill_ontology canonical (no invented skills).
--
-- A FK to skill_ontology(canonical_name) keeps the map honest: a mapping to a
-- non-canonical skill is rejected at insert. Idempotent (ON CONFLICT DO NOTHING).
-- The eval (spec Phase 6) gates RELIANCE on this map; the table is the substrate.
-- =============================================================================

CREATE TABLE IF NOT EXISTS tech_skill_map (
    tech_canonical  TEXT NOT NULL,
    skill_canonical TEXT NOT NULL REFERENCES skill_ontology(canonical_name) ON UPDATE CASCADE ON DELETE CASCADE,
    source          TEXT NOT NULL DEFAULT 'seed',
    confidence      REAL NOT NULL DEFAULT 1.0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tech_canonical, skill_canonical)
);

CREATE INDEX IF NOT EXISTS idx_tech_skill_map_tech ON tech_skill_map (tech_canonical);

-- Seed: top corpus technologies -> canonical skills (tool + implied capability).
INSERT INTO tech_skill_map (tech_canonical, skill_canonical) VALUES
    -- IaC / CDK
    ('aws_cdk', 'aws cdk'), ('aws_cdk', 'infrastructure as code'),
    ('cdk_nag', 'cdk nag'), ('cdk_nag', 'infrastructure as code'),
    ('terraform', 'terraform'), ('terraform', 'infrastructure as code'),
    -- AWS services (tool-skill = the canonical service skill)
    ('aws_ssm', 'aws ssm'),
    ('aws_iam', 'aws iam'), ('aws_iam', 'access control'),
    ('aws_s3', 'aws s3'),
    ('@aws-sdk/client-s3', 'aws s3'), ('@aws-sdk/client-s3', 'aws sdk'),
    ('aws_sdk', 'aws sdk'),
    ('aws_ec2', 'aws ec2'),
    ('aws_lambda', 'aws lambda'), ('aws_lambda', 'serverless functions'),
    ('aws_kms', 'aws kms'), ('aws_kms', 'encryption'),
    ('aws_cloudfront', 'aws cloudfront'),
    ('aws_sns', 'aws sns'),
    ('aws_sqs', 'aws sqs'),
    ('aws_cloudwatch', 'aws cloudwatch'), ('aws_cloudwatch', 'metrics and monitoring'),
    ('aws_ecr', 'aws ecr'),
    ('aws_eks', 'aws eks'), ('aws_eks', 'self hosted kubernetes'),
    ('aws_sts', 'aws sts'),
    ('aws_wafv2', 'aws waf'),
    ('aws_autoscaling', 'autoscaling'),
    ('aws_bedrock', 'aws bedrock'),
    ('aws_route53', 'aws route53'),
    ('aws_step_functions', 'aws step functions'), ('aws_step_functions', 'step functions orchestration'),
    -- databases
    ('postgresql', 'postgresql'),
    ('dynamodb', 'dynamodb'),
    ('pgbouncer', 'pgbouncer'), ('pgbouncer', 'connection pooling'),
    ('redis', 'redis'), ('redis', 'caching'),
    ('pgvector', 'pgvector'), ('pgvector', 'vector search'),
    -- frontend
    ('react', 'react'), ('react', 'react development'),
    ('@tanstack/react-query', 'react'), ('@tanstack/react-query', 'frontend state management'),
    ('framer_motion', 'framer motion'),
    ('hono', 'hono'),
    ('nextjs', 'nextjs'),
    ('tailwindcss', 'tailwindcss'),
    -- backend / language / validation
    ('nodejs', 'nodejs'),
    ('zod', 'zod'), ('zod', 'schema validation'),
    -- testing
    ('jest', 'jest'), ('jest', 'automated testing'),
    ('vitest', 'vitest'), ('vitest', 'automated testing'),
    ('testing-library', 'automated testing'),
    -- devops / delivery
    ('github_actions', 'github actions'), ('github_actions', 'ci/cd pipelines'),
    ('argocd', 'argocd'), ('argocd', 'gitops'),
    ('helm', 'helm'), ('helm', 'helm charts'),
    -- kubernetes / infra
    ('kubernetes', 'kubernetes'), ('kubernetes', 'container orchestration'),
    ('calico', 'calico'), ('calico', 'kubernetes networking'),
    ('traefik', 'traefik'),
    ('karpenter', 'karpenter'), ('karpenter', 'autoscaling'),
    -- security / policy
    ('checkov', 'checkov'),
    -- observability
    ('prometheus', 'prometheus'), ('prometheus', 'metrics and monitoring'),
    ('opentelemetry', 'opentelemetry'), ('opentelemetry', 'distributed tracing')
ON CONFLICT (tech_canonical, skill_canonical) DO NOTHING;
