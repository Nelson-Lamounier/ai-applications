-- =============================================================================
-- 097_jd_skill_vocabulary_2026.sql
-- =============================================================================
-- Vocabulary growth — JD demand (the proprietary, usage-grown vocabulary; no
-- external registry/O*NET). The controlled-vocab enricher (enrichTextCanonical)
-- can only emit skills that exist in skill_ontology; the live golden-eval showed
-- recall capped at ~0.54 because the 209-term vocabulary is too small. This seeds
-- the canonical skills that 2026 technical JDs actually demand (DevOps, LLM/AI,
-- SRE/Platform/MLOps, Technical Support, Data/Cloud Security), so corpus + query
-- both canonicalise into the SAME enlarged vocabulary and d.skills && query.skills
-- overlaps on real demand.
--
-- Source: synthesised from live 2026 JD market demand (Indeed/roadmap.sh/CIO/
-- Robert Half/Pluralsight role specs, 2026-06-20). Proprietary curation, not an
-- external taxonomy. curation_level='auto_imported' + curated-safe: ON CONFLICT
-- DO NOTHING never overwrites a curated canonical. New canonicals carry NO
-- embedding yet — the Titan skill-embedding backfill (migration 094 path) embeds
-- them so the resolver/classifier can use them.
--
-- Idempotent. Each row: (canonical_name, display_name, category∈15).
-- =============================================================================

INSERT INTO skill_ontology (canonical_name, display_name, category, curation_level, source, source_licence, source_url)
SELECT lower(v.canonical), v.display, v.category, 'auto_imported', 'jd_market_2026', 'curated', 'internal:jd-demand-2026'
FROM (VALUES
    -- ── ML / LLM / AI (the 2026 demand surge) ───────────────────────────────
    ('large language models',     'Large Language Models',     'ml'),
    ('ai agents',                 'AI Agents',                 'ml'),
    ('agentic workflows',         'Agentic Workflows',         'ml'),
    ('langchain',                 'LangChain',                 'ml'),
    ('llamaindex',                'LlamaIndex',                'ml'),
    ('langgraph',                 'LangGraph',                 'ml'),
    ('fine-tuning',               'Fine-Tuning',               'ml'),
    ('instruction tuning',        'Instruction Tuning',        'ml'),
    ('rlhf',                      'RLHF',                      'ml'),
    ('supervised fine-tuning',    'Supervised Fine-Tuning',    'ml'),
    ('model deployment',          'Model Deployment',          'ml'),
    ('model monitoring',          'Model Monitoring',          'ml'),
    ('mlops',                     'MLOps',                     'ml'),
    ('reranking',                 'Reranking',                 'ml'),
    ('semantic search',          'Semantic Search',           'ml'),
    ('llm evaluation',            'LLM Evaluation',            'ml'),
    ('llama',                     'Llama',                     'ml'),
    ('mistral',                   'Mistral',                   'ml'),
    ('hugging face',              'Hugging Face',              'ml'),
    -- ── Vector / Data stores + data engineering ─────────────────────────────
    ('faiss',                     'FAISS',                     'database'),
    ('weaviate',                  'Weaviate',                  'database'),
    ('pinecone',                  'Pinecone',                  'database'),
    ('milvus',                    'Milvus',                    'database'),
    ('qdrant',                    'Qdrant',                    'database'),
    ('data warehousing',          'Data Warehousing',          'data'),
    ('etl pipelines',             'ETL Pipelines',             'data'),
    ('elt pipelines',             'ELT Pipelines',             'data'),
    ('data pipelines',            'Data Pipelines',            'data'),
    ('data governance',           'Data Governance',           'data'),
    ('airflow',                   'Apache Airflow',            'data'),
    -- ── DevOps / SRE / Platform ─────────────────────────────────────────────
    ('jenkins',                   'Jenkins',                   'devops'),
    ('spinnaker',                 'Spinnaker',                 'devops'),
    ('continuous testing',        'Continuous Testing',        'devops'),
    ('automated deployment',      'Automated Deployment',      'devops'),
    ('powershell',                'PowerShell',                'language'),
    ('mlflow',                    'MLflow',                    'devops'),
    ('kubeflow',                  'Kubeflow',                  'devops'),
    ('site reliability engineering', 'Site Reliability Engineering', 'infrastructure'),
    ('platform engineering',      'Platform Engineering',      'infrastructure'),
    ('devsecops',                 'DevSecOps',                 'security'),
    -- ── Cloud platforms / ML platforms ──────────────────────────────────────
    ('microsoft azure',           'Microsoft Azure',           'cloud'),
    ('google cloud platform',     'Google Cloud Platform',     'cloud'),
    ('aws sagemaker',             'AWS SageMaker',             'cloud'),
    ('vertex ai',                 'Vertex AI',                 'cloud'),
    ('azure machine learning',    'Azure Machine Learning',    'cloud'),
    -- ── Observability (extra stacks JDs name) ───────────────────────────────
    ('elk stack',                 'ELK Stack',                 'observability'),
    ('jaeger',                    'Jaeger',                    'observability'),
    -- ── Security / compliance ───────────────────────────────────────────────
    ('cloud security',            'Cloud Security',            'security'),
    ('zero trust architecture',   'Zero Trust Architecture',   'security'),
    ('penetration testing',       'Penetration Testing',       'security'),
    ('soc 2 compliance',          'SOC 2 Compliance',          'security'),
    ('identity providers',        'Identity Providers',        'security'),
    -- ── Languages / backend ─────────────────────────────────────────────────
    ('ruby',                      'Ruby',                      'language'),
    ('async programming',         'Async Programming',         'backend'),
    -- ── Technical Support / cross-functional ────────────────────────────────
    ('technical troubleshooting', 'Technical Troubleshooting', 'other'),
    ('customer communication',    'Customer Communication',    'other'),
    ('linux administration',      'Linux Administration',      'infrastructure'),
    ('networking',                'Networking',                'infrastructure')
) AS v(canonical, display, category)
ON CONFLICT (canonical_name) DO NOTHING;
