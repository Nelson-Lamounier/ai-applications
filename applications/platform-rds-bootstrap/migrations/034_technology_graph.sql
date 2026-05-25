-- 034_technology_graph.sql
--
-- Tech Extractor Layer 1 — deterministic technology extraction.
-- Six tables: three global reference (ontology/aliases/relationships),
-- three user-scoped (evidence/candidates/parity) + a single-row
-- ontology_version counter.
--
-- Expand-only, idempotent (ROLLBACK.md §Expand/Contract). Enum-like columns
-- use TEXT + CHECK to match the repo convention (no CREATE TYPE).

BEGIN;

-- set_updated_at() may already exist from an earlier migration; OR REPLACE
-- keeps this file self-contained.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Global reference data ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS technology_ontology (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_name   TEXT NOT NULL UNIQUE,
    display_name     TEXT NOT NULL,
    category         TEXT NOT NULL CHECK (category IN (
        'language','framework_web','framework_mobile','framework_ml','runtime',
        'database_relational','database_nosql','database_vector','database_search',
        'database_kv','message_broker','observability','cloud_compute','cloud_storage',
        'cloud_database','cloud_serverless','cloud_networking','cloud_security','iac',
        'ci_cd','container_runtime','orchestration','api_protocol','testing',
        'build_tool','package_manager','auth','payment','ai_platform')),
    curation_level   TEXT NOT NULL DEFAULT 'curated'
        CHECK (curation_level IN ('curated','auto_imported','candidate')),
    source           TEXT,
    popularity_score INT  NOT NULL DEFAULT 0,
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    notes            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS set_updated_at ON technology_ontology;
CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON technology_ontology
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS technology_aliases (
    alias         TEXT PRIMARY KEY,                       -- lowercased; one alias -> one tech
    technology_id UUID NOT NULL REFERENCES technology_ontology(id) ON DELETE CASCADE,
    source        TEXT
);
CREATE INDEX IF NOT EXISTS idx_technology_aliases_tech ON technology_aliases (technology_id);

CREATE TABLE IF NOT EXISTS technology_relationships (
    from_id UUID NOT NULL REFERENCES technology_ontology(id) ON DELETE CASCADE,
    to_id   UUID NOT NULL REFERENCES technology_ontology(id) ON DELETE CASCADE,
    kind    TEXT NOT NULL CHECK (kind IN
        ('runs_on','implements','part_of','succeeds','related_to')),
    PRIMARY KEY (from_id, to_id, kind)
);

-- ── Ontology version counter + bump trigger ──────────────────────────────
CREATE TABLE IF NOT EXISTS ontology_version (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    version   INT NOT NULL DEFAULT 1
);
INSERT INTO ontology_version (singleton, version)
    VALUES (TRUE, 1) ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION bump_ontology_version()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE ontology_version SET version = version + 1 WHERE singleton = TRUE;
    RETURN NULL;  -- AFTER STATEMENT trigger
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bump_version_on_ontology ON technology_ontology;
CREATE TRIGGER bump_version_on_ontology
    AFTER INSERT OR UPDATE OR DELETE ON technology_ontology
    FOR EACH STATEMENT EXECUTE FUNCTION bump_ontology_version();

DROP TRIGGER IF EXISTS bump_version_on_aliases ON technology_aliases;
CREATE TRIGGER bump_version_on_aliases
    AFTER INSERT OR UPDATE OR DELETE ON technology_aliases
    FOR EACH STATEMENT EXECUTE FUNCTION bump_ontology_version();

-- ── User-scoped: evidence ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS technology_evidence (
    id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repo_full_name                TEXT NOT NULL,
    commit_sha                    TEXT NOT NULL,
    technology_id                 UUID REFERENCES technology_ontology(id),   -- NULL = unmatched
    raw_name                      TEXT NOT NULL,
    ecosystem                     TEXT,
    source_layer                  TEXT NOT NULL CHECK (source_layer IN
        ('syft','treesitter','iac','dockerfile','readme')),
    file_path                     TEXT NOT NULL,
    line_start                    INT,
    line_end                      INT,
    confidence                    REAL,
    extracted_at_ontology_version INT NOT NULL,
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Portable dedup index (avoids PG15-only NULLS NOT DISTINCT). COALESCE both
-- nullable members so unmatched (technology_id NULL) and position-less
-- (line_start NULL) rows still dedup on retry.
CREATE UNIQUE INDEX IF NOT EXISTS uq_technology_evidence
    ON technology_evidence (
        user_id, repo_full_name,
        COALESCE(technology_id::text, raw_name),
        file_path,
        COALESCE(line_start, -1)
    );
CREATE INDEX IF NOT EXISTS idx_technology_evidence_repo_commit
    ON technology_evidence (user_id, repo_full_name, commit_sha);

ALTER TABLE technology_evidence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_technology_evidence ON technology_evidence;
CREATE POLICY rls_technology_evidence ON technology_evidence
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

-- ── User-scoped: candidates ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS technology_candidates (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    raw_name            TEXT NOT NULL,
    normalized_name     TEXT NOT NULL,
    ecosystem           TEXT NOT NULL DEFAULT 'unknown',
    first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    occurrence_count    INT NOT NULL DEFAULT 0,
    user_count          INT NOT NULL DEFAULT 0,
    example_repos       JSONB NOT NULL DEFAULT '[]',
    suggested_canonical UUID REFERENCES technology_ontology(id),
    suggested_category  TEXT,
    resolved_at         TIMESTAMPTZ,
    resolution          TEXT CHECK (resolution IN
        ('promoted','aliased','ignored','duplicate')),
    UNIQUE (normalized_name, ecosystem)
);
CREATE INDEX IF NOT EXISTS idx_technology_candidates_unresolved
    ON technology_candidates (resolution) WHERE resolved_at IS NULL;

-- ── User-scoped: parity runs ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS technology_parity_runs (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repo_full_name         TEXT NOT NULL,
    commit_sha             TEXT NOT NULL,
    ontology_version       INT NOT NULL,
    l1_canonical_count     INT NOT NULL,
    llm_canonical_count    INT NOT NULL,
    llm_unresolvable_count INT NOT NULL,
    intersection_count     INT NOT NULL,
    recall                 REAL NOT NULL,
    l1_only_examples       JSONB NOT NULL DEFAULT '[]',
    llm_only_examples      JSONB NOT NULL DEFAULT '[]',
    ran_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_technology_parity_runs_repo
    ON technology_parity_runs (user_id, repo_full_name, ran_at DESC);

ALTER TABLE technology_parity_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_technology_parity_runs ON technology_parity_runs;
CREATE POLICY rls_technology_parity_runs ON technology_parity_runs
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

-- ── Minimal curated seed (~Phase 1 baseline; grows by data-track PRs) ─────
-- canonical_name is the slug form; display_name the human form.
INSERT INTO technology_ontology (canonical_name, display_name, category, curation_level, source)
VALUES
    ('typescript','TypeScript','language','curated','seed'),
    ('javascript','JavaScript','language','curated','seed'),
    ('python','Python','language','curated','seed'),
    ('go','Go','language','curated','seed'),
    ('rust','Rust','language','curated','seed'),
    ('java','Java','language','curated','seed'),
    ('react','React','framework_web','curated','seed'),
    ('nextjs','Next.js','framework_web','curated','seed'),
    ('nodejs','Node.js','runtime','curated','seed'),
    ('postgresql','PostgreSQL','database_relational','curated','seed'),
    ('redis','Redis','database_kv','curated','seed'),
    ('pgvector','pgvector','database_vector','curated','seed'),
    ('docker','Docker','container_runtime','curated','seed'),
    ('kubernetes','Kubernetes','orchestration','curated','seed'),
    ('helm','Helm','iac','curated','seed'),
    ('terraform','Terraform','iac','curated','seed'),
    ('aws_cdk','AWS CDK','iac','curated','seed'),
    ('aws_lambda','AWS Lambda','cloud_serverless','curated','seed'),
    ('aws_s3','Amazon S3','cloud_storage','curated','seed'),
    ('aws_rds','Amazon RDS','cloud_database','curated','seed'),
    ('aws_bedrock','Amazon Bedrock','ai_platform','curated','seed'),
    ('github_actions','GitHub Actions','ci_cd','curated','seed'),
    ('jest','Jest','testing','curated','seed'),
    ('prometheus','Prometheus','observability','curated','seed'),
    ('grafana','Grafana','observability','curated','seed')
ON CONFLICT (canonical_name) DO NOTHING;

-- Aliases (lowercased). One alias -> one technology.
INSERT INTO technology_aliases (alias, technology_id, source)
SELECT a.alias, o.id, 'seed'
FROM (VALUES
    ('typescript','typescript'), ('ts','typescript'),
    ('javascript','javascript'), ('js','javascript'),
    ('python','python'), ('py','python'),
    ('go','go'), ('golang','go'),
    ('rust','rust'),
    ('java','java'),
    ('react','react'), ('react.js','react'), ('reactjs','react'),
    ('next.js','nextjs'), ('nextjs','nextjs'), ('next','nextjs'),
    ('node.js','nodejs'), ('node','nodejs'), ('nodejs','nodejs'),
    ('postgresql','postgresql'), ('postgres','postgresql'), ('pg','postgresql'),
    ('redis','redis'),
    ('pgvector','pgvector'),
    ('docker','docker'),
    ('kubernetes','kubernetes'), ('k8s','kubernetes'),
    ('helm','helm'),
    ('terraform','terraform'), ('tf','terraform'),
    ('aws-cdk','aws_cdk'), ('aws_cdk','aws_cdk'), ('cdk','aws_cdk'), ('aws-cdk-lib','aws_cdk'),
    ('aws-lambda','aws_lambda'), ('lambda','aws_lambda'),
    ('s3','aws_s3'), ('aws-s3','aws_s3'),
    ('rds','aws_rds'),
    ('bedrock','aws_bedrock'), ('amazon-bedrock','aws_bedrock'),
    ('github-actions','github_actions'), ('gha','github_actions'),
    ('jest','jest'),
    ('prometheus','prometheus'), ('prom-client','prometheus'),
    ('grafana','grafana')
) AS a(alias, canon)
JOIN technology_ontology o ON o.canonical_name = a.canon
ON CONFLICT (alias) DO NOTHING;

-- ── Grants (match the tucaken_app convention from 030+) ───────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON technology_ontology      TO tucaken_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON technology_aliases       TO tucaken_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON technology_relationships TO tucaken_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON technology_candidates    TO tucaken_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON technology_evidence      TO tucaken_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON technology_parity_runs   TO tucaken_app;
GRANT SELECT, INSERT, UPDATE        ON ontology_version          TO tucaken_app;

COMMIT;
