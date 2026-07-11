-- 115_technology_transfer_seed.sql
--
-- Seed the technology transfer graph. Before this migration the
-- relationship graph held 20 edges over 2,483 canonicals (all AI-vendor +
-- the kubeadm/EKS pair), so loadTransferGroups() almost always fell back to
-- coarse CATEGORY groups — "transferable" verdicts in JD analysis meant
-- "same category", not "genuinely interchangeable".
--
-- This seeds curated, DISJOINT transfer families (no canonical appears in
-- two families — loadTransferGroups builds connected components over ALL
-- edge kinds, so a shared node would merge families into one over-broad
-- mega-group). Also inserts the missing-but-JD-critical canonicals (GKE,
-- AKS, Vertex AI, Gemini, Pinecone, LangGraph, CrewAI...) with aliases so
-- JD phrases resolve at all.
--
-- Idempotent: every insert is ON CONFLICT DO NOTHING; edges reference
-- canonicals by name and silently no-op if a name is absent.

-- ---------------------------------------------------------------------------
-- 1. Missing canonicals (curated, source jd_transfer_seed)
-- ---------------------------------------------------------------------------
INSERT INTO technology_ontology (canonical_name, display_name, category, curation_level, source, popularity_score)
VALUES
    ('gke',          'Google Kubernetes Engine (GKE)', 'orchestration',   'curated', 'jd_transfer_seed', 80),
    ('aks',          'Azure Kubernetes Service (AKS)', 'orchestration',   'curated', 'jd_transfer_seed', 70),
    ('vertex_ai',    'Vertex AI',                      'ai_platform',     'curated', 'jd_transfer_seed', 80),
    ('gemini',       'Google Gemini',                  'ai_platform',     'curated', 'jd_transfer_seed', 80),
    ('azure_openai', 'Azure OpenAI Service',           'ai_platform',     'curated', 'jd_transfer_seed', 70),
    ('pinecone',     'Pinecone',                       'database_vector', 'curated', 'jd_transfer_seed', 70),
    ('weaviate',     'Weaviate',                       'database_vector', 'curated', 'jd_transfer_seed', 50),
    ('qdrant',       'Qdrant',                         'database_vector', 'curated', 'jd_transfer_seed', 50),
    ('jenkins',      'Jenkins',                        'ci_cd',           'curated', 'jd_transfer_seed', 70),
    ('gitlab_ci',    'GitLab CI',                      'ci_cd',           'curated', 'jd_transfer_seed', 70),
    ('circleci',     'CircleCI',                       'ci_cd',           'curated', 'jd_transfer_seed', 50),
    ('pulumi',       'Pulumi',                         'iac',             'curated', 'jd_transfer_seed', 50),
    ('kafka',        'Apache Kafka',                   'message_broker',  'curated', 'jd_transfer_seed', 80),
    ('rabbitmq',     'RabbitMQ',                       'message_broker',  'curated', 'jd_transfer_seed', 60),
    ('datadog',      'Datadog',                        'observability',   'curated', 'jd_transfer_seed', 70),
    ('new_relic',    'New Relic',                      'observability',   'curated', 'jd_transfer_seed', 50),
    ('langgraph',    'LangGraph',                      'ai_platform',     'curated', 'jd_transfer_seed', 60),
    ('crewai',       'CrewAI',                         'ai_platform',     'curated', 'jd_transfer_seed', 50),
    ('llamaindex',   'LlamaIndex',                     'ai_platform',     'curated', 'jd_transfer_seed', 50)
ON CONFLICT (canonical_name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Aliases — JD phrasings that must resolve (alias PK is global)
-- ---------------------------------------------------------------------------
INSERT INTO technology_aliases (alias, technology_id, source)
SELECT v.alias, o.id, 'jd_transfer_seed'
FROM (VALUES
    ('gke',                        'gke'),
    ('google kubernetes engine',   'gke'),
    ('aks',                        'aks'),
    ('azure kubernetes service',   'aks'),
    ('eks',                        'aws_eks'),
    ('amazon eks',                 'aws_eks'),
    ('vertex ai',                  'vertex_ai'),
    ('vertexai',                   'vertex_ai'),
    ('gemini',                     'gemini'),
    ('google gemini',              'gemini'),
    ('azure openai',               'azure_openai'),
    ('pinecone',                   'pinecone'),
    ('weaviate',                   'weaviate'),
    ('qdrant',                     'qdrant'),
    ('jenkins',                    'jenkins'),
    ('gitlab ci',                  'gitlab_ci'),
    ('gitlab-ci',                  'gitlab_ci'),
    ('circleci',                   'circleci'),
    ('circle ci',                  'circleci'),
    ('pulumi',                     'pulumi'),
    ('kafka',                      'kafka'),
    ('apache kafka',               'kafka'),
    ('rabbitmq',                   'rabbitmq'),
    ('datadog',                    'datadog'),
    ('new relic',                  'new_relic'),
    ('langgraph',                  'langgraph'),
    ('crewai',                     'crewai'),
    ('crew ai',                    'crewai'),
    ('llamaindex',                 'llamaindex'),
    ('llama index',                'llamaindex'),
    ('cloudformation',             'aws_cloudformation'),
    ('step functions',             'aws_step_functions'),
    ('angular',                    '@angular/core'),
    ('nestjs',                     '@nestjs/core'),
    ('next.js',                    'nextjs')
) AS v(alias, canonical)
JOIN technology_ontology o ON o.canonical_name = v.canonical
ON CONFLICT (alias) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Transfer edges (related_to; undirected consumer — one direction stored).
--    Families are DISJOINT by construction. Edges silently no-op when a
--    canonical is absent.
-- ---------------------------------------------------------------------------
INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT f.id, t.id, 'related_to'
FROM (VALUES
    -- Managed Kubernetes (joins the existing kubeadm/EKS component — same family)
    ('aws_eks',        'gke'),
    ('gke',            'aks'),
    -- AI platforms (extends the existing Bedrock/OpenAI/Claude component)
    ('vertex_ai',      'aws_bedrock'),
    ('gemini',         'vertex_ai'),
    ('azure_openai',   'openai'),
    -- Vector databases
    ('pgvector',       'pinecone'),
    ('pinecone',       'weaviate'),
    ('weaviate',       'qdrant'),
    -- Infrastructure as code
    ('terraform',      'aws_cdk'),
    ('aws_cdk',        'aws_cloudformation'),
    ('terraform',      'pulumi'),
    ('terraform',      'ansible'),
    -- CI/CD
    ('github_actions', 'gitlab_ci'),
    ('gitlab_ci',      'jenkins'),
    ('jenkins',        'circleci'),
    -- Frontend frameworks (component frameworks + their meta-frameworks)
    ('react',          'vue'),
    ('vue',            'svelte'),
    ('svelte',         '@angular/core'),
    ('nextjs',         'react'),
    ('nuxt',           'vue'),
    -- Node HTTP frameworks
    ('express',        'fastify'),
    ('fastify',        'hono'),
    ('hono',           'koa'),
    ('koa',            '@nestjs/core'),
    -- Message brokers (aws_kafka = MSK, the managed sibling)
    ('kafka',          'rabbitmq'),
    ('kafka',          'aws_kafka'),
    -- Observability stack
    ('prometheus',     'grafana'),
    ('grafana',        'loki'),
    ('prometheus',     'datadog'),
    ('datadog',        'new_relic'),
    ('opentelemetry',  'prometheus'),
    -- Agent frameworks
    ('langchain',      'langgraph'),
    ('langgraph',      'crewai'),
    ('crewai',         'llamaindex')
) AS v(from_name, to_name)
JOIN technology_ontology f ON f.canonical_name = v.from_name
JOIN technology_ontology t ON t.canonical_name = v.to_name
ON CONFLICT (from_id, to_id, kind) DO NOTHING;
