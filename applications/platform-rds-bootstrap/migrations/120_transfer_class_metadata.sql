-- 120_transfer_class_metadata.sql
--
-- Typed transfer classes on the technology graph.
--
-- 115/117 seeded transfer families as untyped related_to edges — enough for
-- loadTransferGroups()'s connected-component reader, but the matcher cannot
-- ask "is X a full or partial substitute for Y, and why" without a typed
-- class on the edge itself. This migration adds transfer_class/transfer_tier/
-- transfer_basis columns to technology_relationships and seeds the 7 classes
-- the JD gap corpus demands, as a full pairwise graph (every member related
-- to every other member, both directions) so a single edge lookup between
-- any two class members resolves the transfer verdict directly.
--
-- Additive only: the existing (from_id, to_id, kind) edges and their
-- meaning are untouched; typing is metadata layered on top. Where 115/117
-- already seeded a pair (e.g. terraform/aws_cdk, docker_swarm/kubernetes),
-- the INSERT no-ops (ON CONFLICT DO NOTHING) but the UPDATE still stamps it.
--
-- Idempotent: canonicals/aliases/edges are ON CONFLICT DO NOTHING; edges are
-- name-resolved via technology_ontology joins so an absent canonical is a
-- silent no-op. Safe to re-run.

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Schema: transfer typing on technology_relationships
-- ---------------------------------------------------------------------------
ALTER TABLE technology_relationships ADD COLUMN IF NOT EXISTS transfer_class TEXT;
ALTER TABLE technology_relationships ADD COLUMN IF NOT EXISTS transfer_tier  TEXT;
ALTER TABLE technology_relationships ADD COLUMN IF NOT EXISTS transfer_basis TEXT;
ALTER TABLE technology_relationships DROP CONSTRAINT IF EXISTS technology_relationships_transfer_tier_check;
ALTER TABLE technology_relationships ADD CONSTRAINT technology_relationships_transfer_tier_check
    CHECK (transfer_tier IS NULL OR transfer_tier IN ('full','partial'));

-- ---------------------------------------------------------------------------
-- 1. Canonicals the 7 classes need that are absent from the ontology today
--    (verified by grepping 034/035/036/074/115/117 for exact canonical_name
--    spellings — terraform, aws_cdk, aws_cloudformation, pulumi,
--    github_actions, gitlab_ci, jenkins, circleci, kubernetes, docker_swarm,
--    aws_ecs, aws, dynamodb, aws_secrets_manager, grafana, prometheus,
--    datadog and aws_cloudwatch already exist and are reused by name below).
--    Categories are from the 034+036 technology_ontology_category_check
--    universe.
-- ---------------------------------------------------------------------------
INSERT INTO technology_ontology (canonical_name, display_name, category, curation_level, source, popularity_score)
VALUES
    ('azure',           'Microsoft Azure',       'cloud_compute',  'curated', 'transfer_class_seed', 80),
    ('gcp',             'Google Cloud Platform', 'cloud_compute',  'curated', 'transfer_class_seed', 70),
    ('mongodb',         'MongoDB',               'database_nosql', 'curated', 'transfer_class_seed', 80),
    ('documentdb',      'Amazon DocumentDB',     'database_nosql', 'curated', 'transfer_class_seed', 40),
    ('vault',           'HashiCorp Vault',       'cloud_security', 'curated', 'transfer_class_seed', 60),
    ('azure_key_vault', 'Azure Key Vault',       'cloud_security', 'curated', 'transfer_class_seed', 50),
    ('bicep',           'Bicep',                 'iac',            'curated', 'transfer_class_seed', 40)
ON CONFLICT (canonical_name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Aliases for the newly curated canonicals (JD phrasing resolution).
-- ---------------------------------------------------------------------------
INSERT INTO technology_aliases (alias, technology_id, source)
SELECT a.alias, o.id, 'transfer_class_seed'
FROM (VALUES
    ('azure',                 'azure'),
    ('microsoft azure',       'azure'),
    ('azure cloud',           'azure'),
    ('gcp',                   'gcp'),
    ('google cloud',          'gcp'),
    ('google cloud platform', 'gcp'),
    ('mongodb',               'mongodb'),
    ('mongo',                 'mongodb'),
    ('mongo db',              'mongodb'),
    ('documentdb',            'documentdb'),
    ('amazon documentdb',     'documentdb'),
    ('aws documentdb',        'documentdb'),
    ('vault',                 'vault'),
    ('hashicorp vault',       'vault'),
    ('azure key vault',       'azure_key_vault'),
    ('azure-key-vault',       'azure_key_vault'),
    ('bicep',                 'bicep'),
    ('azure bicep',           'bicep')
) AS a(alias, canon)
JOIN technology_ontology o ON o.canonical_name = a.canon
ON CONFLICT (alias) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Typed transfer classes.
--    Each class: INSERT the full pairwise edge set (every member <-> every
--    other member, both directions, kind='related_to'; no-ops where 115/117
--    already seeded the pair) then UPDATE the same pair set with the typed
--    metadata, so pre-existing and newly-inserted rows alike end up stamped.
-- ---------------------------------------------------------------------------

-- 3a. iac-declarative — terraform, aws_cdk, aws_cloudformation, pulumi, bicep
INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT f.id, t.id, 'related_to'
FROM (VALUES
    ('terraform','aws_cdk'), ('aws_cdk','terraform'),
    ('terraform','aws_cloudformation'), ('aws_cloudformation','terraform'),
    ('terraform','pulumi'), ('pulumi','terraform'),
    ('terraform','bicep'), ('bicep','terraform'),
    ('aws_cdk','aws_cloudformation'), ('aws_cloudformation','aws_cdk'),
    ('aws_cdk','pulumi'), ('pulumi','aws_cdk'),
    ('aws_cdk','bicep'), ('bicep','aws_cdk'),
    ('aws_cloudformation','pulumi'), ('pulumi','aws_cloudformation'),
    ('aws_cloudformation','bicep'), ('bicep','aws_cloudformation'),
    ('pulumi','bicep'), ('bicep','pulumi')
) AS v(from_name, to_name)
JOIN technology_ontology f ON f.canonical_name = v.from_name
JOIN technology_ontology t ON t.canonical_name = v.to_name
ON CONFLICT (from_id, to_id, kind) DO NOTHING;

UPDATE technology_relationships r
SET transfer_class = 'iac-declarative',
    transfer_tier   = 'full',
    transfer_basis  = 'Declarative infrastructure-as-code: resource modelling, state, plan/apply discipline transfer directly'
FROM (VALUES
    ('terraform','aws_cdk'), ('aws_cdk','terraform'),
    ('terraform','aws_cloudformation'), ('aws_cloudformation','terraform'),
    ('terraform','pulumi'), ('pulumi','terraform'),
    ('terraform','bicep'), ('bicep','terraform'),
    ('aws_cdk','aws_cloudformation'), ('aws_cloudformation','aws_cdk'),
    ('aws_cdk','pulumi'), ('pulumi','aws_cdk'),
    ('aws_cdk','bicep'), ('bicep','aws_cdk'),
    ('aws_cloudformation','pulumi'), ('pulumi','aws_cloudformation'),
    ('aws_cloudformation','bicep'), ('bicep','aws_cloudformation'),
    ('pulumi','bicep'), ('bicep','pulumi')
) AS v(from_name, to_name)
JOIN technology_ontology f ON f.canonical_name = v.from_name
JOIN technology_ontology t ON t.canonical_name = v.to_name
WHERE r.from_id = f.id AND r.to_id = t.id AND r.kind = 'related_to';

-- 3b. ci-pipelines — github_actions, gitlab_ci, jenkins, circleci
INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT f.id, t.id, 'related_to'
FROM (VALUES
    ('github_actions','gitlab_ci'), ('gitlab_ci','github_actions'),
    ('github_actions','jenkins'), ('jenkins','github_actions'),
    ('github_actions','circleci'), ('circleci','github_actions'),
    ('gitlab_ci','jenkins'), ('jenkins','gitlab_ci'),
    ('gitlab_ci','circleci'), ('circleci','gitlab_ci'),
    ('jenkins','circleci'), ('circleci','jenkins')
) AS v(from_name, to_name)
JOIN technology_ontology f ON f.canonical_name = v.from_name
JOIN technology_ontology t ON t.canonical_name = v.to_name
ON CONFLICT (from_id, to_id, kind) DO NOTHING;

UPDATE technology_relationships r
SET transfer_class = 'ci-pipelines',
    transfer_tier   = 'full',
    transfer_basis  = 'Pipeline-as-code CI: stages, triggers, secrets and artefact flows transfer directly'
FROM (VALUES
    ('github_actions','gitlab_ci'), ('gitlab_ci','github_actions'),
    ('github_actions','jenkins'), ('jenkins','github_actions'),
    ('github_actions','circleci'), ('circleci','github_actions'),
    ('gitlab_ci','jenkins'), ('jenkins','gitlab_ci'),
    ('gitlab_ci','circleci'), ('circleci','gitlab_ci'),
    ('jenkins','circleci'), ('circleci','jenkins')
) AS v(from_name, to_name)
JOIN technology_ontology f ON f.canonical_name = v.from_name
JOIN technology_ontology t ON t.canonical_name = v.to_name
WHERE r.from_id = f.id AND r.to_id = t.id AND r.kind = 'related_to';

-- 3c. container-orchestration — kubernetes, docker_swarm, aws_ecs
INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT f.id, t.id, 'related_to'
FROM (VALUES
    ('kubernetes','docker_swarm'), ('docker_swarm','kubernetes'),
    ('kubernetes','aws_ecs'), ('aws_ecs','kubernetes'),
    ('docker_swarm','aws_ecs'), ('aws_ecs','docker_swarm')
) AS v(from_name, to_name)
JOIN technology_ontology f ON f.canonical_name = v.from_name
JOIN technology_ontology t ON t.canonical_name = v.to_name
ON CONFLICT (from_id, to_id, kind) DO NOTHING;

UPDATE technology_relationships r
SET transfer_class = 'container-orchestration',
    transfer_tier   = 'full',
    transfer_basis  = 'Container scheduling and service orchestration concepts transfer directly'
FROM (VALUES
    ('kubernetes','docker_swarm'), ('docker_swarm','kubernetes'),
    ('kubernetes','aws_ecs'), ('aws_ecs','kubernetes'),
    ('docker_swarm','aws_ecs'), ('aws_ecs','docker_swarm')
) AS v(from_name, to_name)
JOIN technology_ontology f ON f.canonical_name = v.from_name
JOIN technology_ontology t ON t.canonical_name = v.to_name
WHERE r.from_id = f.id AND r.to_id = t.id AND r.kind = 'related_to';

-- 3d. cloud-platform — aws, azure, gcp (partial: platform breadth transfers,
--     service-specific names do not)
INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT f.id, t.id, 'related_to'
FROM (VALUES
    ('aws','azure'), ('azure','aws'),
    ('aws','gcp'), ('gcp','aws'),
    ('azure','gcp'), ('gcp','azure')
) AS v(from_name, to_name)
JOIN technology_ontology f ON f.canonical_name = v.from_name
JOIN technology_ontology t ON t.canonical_name = v.to_name
ON CONFLICT (from_id, to_id, kind) DO NOTHING;

UPDATE technology_relationships r
SET transfer_class = 'cloud-platform',
    transfer_tier   = 'partial',
    transfer_basis  = 'Platform breadth transfers (compute, IAM, networking concepts); service-specific names do not'
FROM (VALUES
    ('aws','azure'), ('azure','aws'),
    ('aws','gcp'), ('gcp','aws'),
    ('azure','gcp'), ('gcp','azure')
) AS v(from_name, to_name)
JOIN technology_ontology f ON f.canonical_name = v.from_name
JOIN technology_ontology t ON t.canonical_name = v.to_name
WHERE r.from_id = f.id AND r.to_id = t.id AND r.kind = 'related_to';

-- 3e. document-store — mongodb, documentdb, dynamodb
INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT f.id, t.id, 'related_to'
FROM (VALUES
    ('mongodb','documentdb'), ('documentdb','mongodb'),
    ('mongodb','dynamodb'), ('dynamodb','mongodb'),
    ('documentdb','dynamodb'), ('dynamodb','documentdb')
) AS v(from_name, to_name)
JOIN technology_ontology f ON f.canonical_name = v.from_name
JOIN technology_ontology t ON t.canonical_name = v.to_name
ON CONFLICT (from_id, to_id, kind) DO NOTHING;

UPDATE technology_relationships r
SET transfer_class = 'document-store',
    transfer_tier   = 'full',
    transfer_basis  = 'Document/key-value modelling, indexing and query patterns transfer directly'
FROM (VALUES
    ('mongodb','documentdb'), ('documentdb','mongodb'),
    ('mongodb','dynamodb'), ('dynamodb','mongodb'),
    ('documentdb','dynamodb'), ('dynamodb','documentdb')
) AS v(from_name, to_name)
JOIN technology_ontology f ON f.canonical_name = v.from_name
JOIN technology_ontology t ON t.canonical_name = v.to_name
WHERE r.from_id = f.id AND r.to_id = t.id AND r.kind = 'related_to';

-- 3f. secrets-managers — aws_secrets_manager, vault, azure_key_vault
INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT f.id, t.id, 'related_to'
FROM (VALUES
    ('aws_secrets_manager','vault'), ('vault','aws_secrets_manager'),
    ('aws_secrets_manager','azure_key_vault'), ('azure_key_vault','aws_secrets_manager'),
    ('vault','azure_key_vault'), ('azure_key_vault','vault')
) AS v(from_name, to_name)
JOIN technology_ontology f ON f.canonical_name = v.from_name
JOIN technology_ontology t ON t.canonical_name = v.to_name
ON CONFLICT (from_id, to_id, kind) DO NOTHING;

UPDATE technology_relationships r
SET transfer_class = 'secrets-managers',
    transfer_tier   = 'full',
    transfer_basis  = 'Secret lifecycle, rotation and injection patterns transfer directly'
FROM (VALUES
    ('aws_secrets_manager','vault'), ('vault','aws_secrets_manager'),
    ('aws_secrets_manager','azure_key_vault'), ('azure_key_vault','aws_secrets_manager'),
    ('vault','azure_key_vault'), ('azure_key_vault','vault')
) AS v(from_name, to_name)
JOIN technology_ontology f ON f.canonical_name = v.from_name
JOIN technology_ontology t ON t.canonical_name = v.to_name
WHERE r.from_id = f.id AND r.to_id = t.id AND r.kind = 'related_to';

-- 3g. observability-stacks — grafana, prometheus, datadog, aws_cloudwatch
INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT f.id, t.id, 'related_to'
FROM (VALUES
    ('grafana','prometheus'), ('prometheus','grafana'),
    ('grafana','datadog'), ('datadog','grafana'),
    ('grafana','aws_cloudwatch'), ('aws_cloudwatch','grafana'),
    ('prometheus','datadog'), ('datadog','prometheus'),
    ('prometheus','aws_cloudwatch'), ('aws_cloudwatch','prometheus'),
    ('datadog','aws_cloudwatch'), ('aws_cloudwatch','datadog')
) AS v(from_name, to_name)
JOIN technology_ontology f ON f.canonical_name = v.from_name
JOIN technology_ontology t ON t.canonical_name = v.to_name
ON CONFLICT (from_id, to_id, kind) DO NOTHING;

UPDATE technology_relationships r
SET transfer_class = 'observability-stacks',
    transfer_tier   = 'full',
    transfer_basis  = 'Metrics, dashboards and alerting concepts transfer directly'
FROM (VALUES
    ('grafana','prometheus'), ('prometheus','grafana'),
    ('grafana','datadog'), ('datadog','grafana'),
    ('grafana','aws_cloudwatch'), ('aws_cloudwatch','grafana'),
    ('prometheus','datadog'), ('datadog','prometheus'),
    ('prometheus','aws_cloudwatch'), ('aws_cloudwatch','prometheus'),
    ('datadog','aws_cloudwatch'), ('aws_cloudwatch','datadog')
) AS v(from_name, to_name)
JOIN technology_ontology f ON f.canonical_name = v.from_name
JOIN technology_ontology t ON t.canonical_name = v.to_name
WHERE r.from_id = f.id AND r.to_id = t.id AND r.kind = 'related_to';

COMMIT;
