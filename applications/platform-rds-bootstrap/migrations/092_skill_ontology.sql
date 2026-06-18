-- =============================================================================
-- 092_skill_ontology.sql
-- =============================================================================
-- RAG-provenance extension, slice 2a (FOLLOWUP item 4): foundation for canonical
-- SKILL resolution — the deterministic counterpart to technology_ontology, for
-- the free-text `skills` the LLM enricher emits onto document_embeddings.
--
-- Mirrors the proven technology_ontology + technology_aliases design (migration
-- 034) so the generic OntologyResolver (Map<alias,id>) is reused unchanged. A
-- raw skill ("k8s networking") resolves via skill_aliases to a canonical
-- skill_ontology row ("kubernetes networking"), collapsing LLM variance.
--
-- This slice ships the schema + a small CURATED seed to prove the structure;
-- the full vocabulary (from role_ontology.transferable_skills + observed skills)
-- and the write-path wiring are later slices (2b/2c). Idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS skill_ontology (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_name TEXT NOT NULL UNIQUE,             -- lowercased canonical skill
    display_name   TEXT NOT NULL,
    category       TEXT NOT NULL CHECK (category IN (
        'language','backend','frontend','infrastructure','devops','data','ml',
        'observability','security','testing','api','database','architecture',
        'cloud','other')),
    curation_level TEXT NOT NULL DEFAULT 'curated'
        CHECK (curation_level IN ('curated','auto_imported','candidate')),
    source         TEXT,
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    notes          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS skill_aliases (
    alias    TEXT PRIMARY KEY,                        -- lowercased; one alias -> one skill
    skill_id UUID NOT NULL REFERENCES skill_ontology(id) ON DELETE CASCADE,
    source   TEXT
);

-- --- Curated seed (small, representative — full vocabulary is slice 2b) -------
INSERT INTO skill_ontology (canonical_name, display_name, category, source) VALUES
    ('kubernetes networking',     'Kubernetes Networking',     'infrastructure', 'seed'),
    ('infrastructure as code',    'Infrastructure as Code',    'devops',         'seed'),
    ('ci/cd pipelines',           'CI/CD Pipelines',           'devops',         'seed'),
    ('distributed tracing',       'Distributed Tracing',       'observability',  'seed'),
    ('metrics and monitoring',    'Metrics & Monitoring',      'observability',  'seed'),
    ('rest api design',           'REST API Design',           'api',            'seed'),
    ('rag retrieval',             'RAG Retrieval',             'ml',             'seed'),
    ('vector search',             'Vector Search',             'data',           'seed'),
    ('row level security',        'Row-Level Security',        'security',       'seed'),
    ('database migrations',       'Database Migrations',       'database',       'seed'),
    ('connection pooling',        'Connection Pooling',        'database',       'seed'),
    ('error handling',            'Error Handling',            'backend',        'seed')
ON CONFLICT (canonical_name) DO NOTHING;

-- Aliases (lowercased) -> canonical skill. Each canonical name is its own alias.
INSERT INTO skill_aliases (alias, skill_id, source)
SELECT a.alias, so.id, 'seed'
FROM skill_ontology so
JOIN (VALUES
    ('kubernetes networking', 'kubernetes networking'),
    ('k8s networking',        'kubernetes networking'),
    ('infrastructure as code','infrastructure as code'),
    ('iac',                   'infrastructure as code'),
    ('iac with cdk',          'infrastructure as code'),
    ('ci/cd pipelines',       'ci/cd pipelines'),
    ('ci/cd',                 'ci/cd pipelines'),
    ('cicd',                  'ci/cd pipelines'),
    ('distributed tracing',   'distributed tracing'),
    ('tracing',               'distributed tracing'),
    ('opentelemetry tracing', 'distributed tracing'),
    ('metrics and monitoring','metrics and monitoring'),
    ('monitoring',            'metrics and monitoring'),
    ('rest api design',       'rest api design'),
    ('rest api',              'rest api design'),
    ('restful api',           'rest api design'),
    ('rag retrieval',         'rag retrieval'),
    ('retrieval augmented generation', 'rag retrieval'),
    ('vector search',         'vector search'),
    ('semantic search',       'vector search'),
    ('row level security',    'row level security'),
    ('rls',                   'row level security'),
    ('database migrations',   'database migrations'),
    ('schema migrations',     'database migrations'),
    ('connection pooling',    'connection pooling'),
    ('error handling',        'error handling')
) AS a(alias, canonical) ON a.canonical = so.canonical_name
ON CONFLICT (alias) DO NOTHING;
