-- =============================================================================
-- 093_skill_ontology_vocabulary.sql
-- =============================================================================
-- RAG-provenance extension, slice 2b (FOLLOWUP item 4): expand the skill_ontology
-- vocabulary so canonicalisation (slice 2c, already wired) bites at scale.
--
-- Pure data — no code. Two sources, deliberately NOT scraping free-text
-- document_embeddings.skills (that noise is the variance we are trying to
-- remove). Industry note: the SOTA canonical source is an external taxonomy
-- (Lightcast Open Skills ~33k, ESCO ~13k RDF/SKOS, O*NET) — aligning to one of
-- those is the future enhancement; here we bootstrap from curated in-house data.
--
--   1. role_ontology.transferable_skills — already-curated capability phrases
--      (migrations 072/073). Imported as auto_imported candidates + self-alias.
--   2. A curated capability batch with real synonym aliases for THIS portfolio's
--      domain (devops / cloud / observability / AI), where the dedup pays off.
--
-- Idempotent (ON CONFLICT DO NOTHING). Categories default to 'other' for the
-- auto-import (the source carries no category); the curated batch sets real ones.
-- =============================================================================

-- --- 1. Bootstrap from curated role_ontology transferable skills --------------
INSERT INTO skill_ontology (canonical_name, display_name, category, curation_level, source)
SELECT DISTINCT lower(trim(s)) AS canonical_name,
       trim(s)                 AS display_name,
       'other'                 AS category,
       'auto_imported'         AS curation_level,
       'role_ontology'         AS source
FROM role_ontology, unnest(transferable_skills) AS s
WHERE trim(s) <> ''
ON CONFLICT (canonical_name) DO NOTHING;

-- Self-alias every imported skill (lowercased) so a verbatim emit resolves.
INSERT INTO skill_aliases (alias, skill_id, source)
SELECT so.canonical_name, so.id, 'role_ontology'
FROM skill_ontology so
WHERE so.source = 'role_ontology'
ON CONFLICT (alias) DO NOTHING;

-- --- 2. Curated capability batch (domain-relevant, with synonym aliases) ------
INSERT INTO skill_ontology (canonical_name, display_name, category, source) VALUES
    ('container orchestration',  'Container Orchestration',  'infrastructure', 'seed'),
    ('gitops',                   'GitOps',                   'devops',         'seed'),
    ('observability',            'Observability',            'observability',  'seed'),
    ('incident response',        'Incident Response',        'devops',         'seed'),
    ('cost optimisation',        'Cost Optimisation',        'cloud',          'seed'),
    ('prompt engineering',       'Prompt Engineering',       'ml',             'seed'),
    ('embeddings retrieval',     'Embeddings Retrieval',     'ml',             'seed'),
    ('structured output',        'Structured Output',        'ml',             'seed'),
    ('access control',           'Access Control',           'security',       'seed'),
    ('secrets management',       'Secrets Management',       'security',       'seed'),
    ('event driven architecture','Event-Driven Architecture','architecture',   'seed'),
    ('caching strategy',         'Caching Strategy',         'backend',        'seed')
ON CONFLICT (canonical_name) DO NOTHING;

INSERT INTO skill_aliases (alias, skill_id, source)
SELECT a.alias, so.id, 'seed'
FROM skill_ontology so
JOIN (VALUES
    ('container orchestration',  'container orchestration'),
    ('orchestration',           'container orchestration'),
    ('kubernetes orchestration','container orchestration'),
    ('gitops',                  'gitops'),
    ('argocd gitops',           'gitops'),
    ('observability',           'observability'),
    ('o11y',                    'observability'),
    ('incident response',       'incident response'),
    ('on-call',                 'incident response'),
    ('cost optimisation',       'cost optimisation'),
    ('cost optimization',       'cost optimisation'),
    ('finops',                  'cost optimisation'),
    ('prompt engineering',      'prompt engineering'),
    ('prompting',               'prompt engineering'),
    ('embeddings retrieval',    'embeddings retrieval'),
    ('vector retrieval',        'embeddings retrieval'),
    ('rag',                     'embeddings retrieval'),
    ('structured output',       'structured output'),
    ('tool use',                'structured output'),
    ('function calling',        'structured output'),
    ('access control',          'access control'),
    ('authz',                   'access control'),
    ('authorisation',           'access control'),
    ('authorization',           'access control'),
    ('secrets management',      'secrets management'),
    ('secret management',       'secrets management'),
    ('event driven architecture','event driven architecture'),
    ('event-driven architecture','event driven architecture'),
    ('eda',                     'event driven architecture'),
    ('caching strategy',        'caching strategy'),
    ('caching',                 'caching strategy')
) AS a(alias, canonical) ON a.canonical = so.canonical_name
ON CONFLICT (alias) DO NOTHING;
