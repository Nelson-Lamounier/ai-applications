-- 036_ontology_import_tracking.sql
--
-- Tier 2 ontology importer — tracking tables (per-source contribution, import
-- runs, review queue, skipped imports) + extend the technology_ontology
-- category CHECK to add 'developer_tool' (used by the importer's categorizer).
--
-- Builds on 034_technology_graph.sql. Expand-only, idempotent. Tracking tables
-- are GLOBAL (no user_id, no RLS). Grants to tucaken_app match the 034 pattern.

BEGIN;

-- 1. Extend the category CHECK to add 'developer_tool'. The 034 constraint is
--    named technology_ontology_category_check by default; drop + recreate.
ALTER TABLE technology_ontology DROP CONSTRAINT IF EXISTS technology_ontology_category_check;
ALTER TABLE technology_ontology ADD CONSTRAINT technology_ontology_category_check
    CHECK (category IN (
        'language','framework_web','framework_mobile','framework_ml','runtime',
        'database_relational','database_nosql','database_vector','database_search',
        'database_kv','message_broker','observability','cloud_compute','cloud_storage',
        'cloud_database','cloud_serverless','cloud_networking','cloud_security','iac',
        'ci_cd','container_runtime','orchestration','api_protocol','testing',
        'build_tool','package_manager','auth','payment','ai_platform',
        'developer_tool'));

CREATE TABLE IF NOT EXISTS ontology_import_sources (
    technology_id        UUID NOT NULL REFERENCES technology_ontology(id) ON DELETE CASCADE,
    source               TEXT NOT NULL,
    source_identifier    TEXT NOT NULL,
    first_imported_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    consecutive_misses   INT NOT NULL DEFAULT 0,
    popularity_in_source INT,
    source_metadata      JSONB,
    PRIMARY KEY (technology_id, source)
);
CREATE INDEX IF NOT EXISTS idx_ontology_import_sources_source_seen
    ON ontology_import_sources (source, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_ontology_import_sources_misses
    ON ontology_import_sources (consecutive_misses) WHERE consecutive_misses > 0;

CREATE TABLE IF NOT EXISTS ontology_import_runs (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source                 TEXT NOT NULL,
    triggered_by           TEXT NOT NULL CHECK (triggered_by IN ('cronjob','manual','backfill')),
    started_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at           TIMESTAMPTZ,
    status                 TEXT NOT NULL CHECK (status IN ('running','success','failed','partial')),
    entries_fetched        INT NOT NULL DEFAULT 0,
    entries_inserted       INT NOT NULL DEFAULT 0,
    entries_updated        INT NOT NULL DEFAULT 0,
    entries_deactivated    INT NOT NULL DEFAULT 0,
    alias_merges           INT NOT NULL DEFAULT 0,
    unresolved_count       INT NOT NULL DEFAULT 0,
    review_queue_added     INT NOT NULL DEFAULT 0,
    llm_batch_id           TEXT,
    llm_batch_status       TEXT CHECK (llm_batch_status IN ('pending','completed','failed')),
    llm_batch_completed_at TIMESTAMPTZ,
    category_accuracy_score REAL,
    error_summary          TEXT,
    notes                  JSONB
);
CREATE INDEX IF NOT EXISTS idx_ontology_import_runs_source
    ON ontology_import_runs (source, started_at DESC);

CREATE TABLE IF NOT EXISTS ontology_skipped_imports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    raw_name        TEXT NOT NULL,
    ecosystem       TEXT NOT NULL,
    source          TEXT NOT NULL,
    llm_decision    TEXT NOT NULL,
    llm_reasoning   TEXT,
    llm_run_id      TEXT,
    skipped_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at     TIMESTAMPTZ,
    override_action TEXT CHECK (override_action IN ('promoted','confirmed_skip')),
    UNIQUE (raw_name, ecosystem)
);

CREATE TABLE IF NOT EXISTS ontology_review_queue (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    raw_name            TEXT NOT NULL,
    ecosystem           TEXT NOT NULL,
    source              TEXT NOT NULL,
    reason              TEXT NOT NULL CHECK (reason IN
        ('llm_maybe','uncategorized','merge_candidate','category_low_confidence')),
    suggested_category  TEXT,
    suggested_canonical UUID REFERENCES technology_ontology(id),
    llm_reasoning       TEXT,
    source_metadata     JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at         TIMESTAMPTZ,
    resolved_by         TEXT,
    resolution          TEXT CHECK (resolution IN ('promoted','skipped','aliased','merged')),
    UNIQUE (raw_name, ecosystem)
);
CREATE INDEX IF NOT EXISTS idx_ontology_review_queue_open
    ON ontology_review_queue (resolved_at) WHERE resolved_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON ontology_import_sources   TO tucaken_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ontology_import_runs      TO tucaken_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ontology_skipped_imports  TO tucaken_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ontology_review_queue     TO tucaken_app;

COMMIT;
