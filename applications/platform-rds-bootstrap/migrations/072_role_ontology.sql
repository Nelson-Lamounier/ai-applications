-- =============================================================================
-- Migration 072 — role_ontology (self-improving role semantics)
--
-- Global reference data (NO RLS), mirrors technology_ontology. Feeds the
-- strategist a roleEvidenceBlock that translates experience into a target role's
-- vocabulary. Curated seed below; user-derived signals are learned via
-- role_learning_candidates and promoted on cross-user corroboration. Idempotent.
-- =============================================================================

DO $$ BEGIN
  CREATE TYPE role_class_enum AS ENUM ('customer_facing','builder','ops','hybrid');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE role_curation_enum AS ENUM ('curated','auto_imported','candidate');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS role_ontology (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_key                 TEXT NOT NULL UNIQUE,
  display_name               TEXT NOT NULL,
  role_class                 role_class_enum NOT NULL,
  canonical_responsibilities TEXT[] NOT NULL DEFAULT '{}',
  vocabulary                 TEXT[] NOT NULL DEFAULT '{}',
  transferable_skills        TEXT[] NOT NULL DEFAULT '{}',
  industry_notes             TEXT NOT NULL DEFAULT '',
  curation                   role_curation_enum NOT NULL DEFAULT 'curated',
  popularity_score           INT NOT NULL DEFAULT 0,
  is_active                  BOOLEAN NOT NULL DEFAULT TRUE,
  source                     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_aliases (
  alias       TEXT PRIMARY KEY,
  family_key  TEXT NOT NULL REFERENCES role_ontology(family_key) ON DELETE CASCADE,
  curation    role_curation_enum NOT NULL DEFAULT 'curated',
  source      TEXT NOT NULL DEFAULT 'seed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_learning_candidates (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_key           TEXT NOT NULL,
  candidate_type       TEXT NOT NULL CHECK (candidate_type IN ('alias','vocabulary','transferable_skill')),
  value                TEXT NOT NULL,
  contributing_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (family_key, candidate_type, value, contributing_user_id)
);
CREATE INDEX IF NOT EXISTS idx_role_learning_lookup
  ON role_learning_candidates (family_key, candidate_type, value);

-- ── Curated seed (curation='curated', source='seed-072') ─────────────────────
INSERT INTO role_ontology (family_key, display_name, role_class, canonical_responsibilities, vocabulary, transferable_skills, industry_notes, source)
VALUES
('technical-support', 'Technical Support / Customer Engineering', 'customer_facing',
 ARRAY['Triage case queues to SLA and response-time targets','Participate in on-call rotations','Manage customer relationships and account health','Educate and enable customers on the platform','Drive and coordinate escalations','Partner cross-functionally with product, engineering, and go-to-market'],
 ARRAY['SLA','response time','on-call','queue','ticket','escalation','customer success','enablement','onboarding','churn','subscription','account health','SaaS support','customer education'],
 ARRAY['customer empathy','incident triage','technical communication','stakeholder management','root-cause analysis','documentation'],
 'Cloud-provider support (e.g. AWS) operates like SaaS support — paying customers, subscriptions, account health. Frame infrastructure-provider support as customer-facing SaaS support.', 'seed-072'),
('software-engineer-backend', 'Backend Software Engineer', 'builder',
 ARRAY['Design and build APIs and services','Model data and own database schemas','Write tested, reviewed production code','Operate services they build'],
 ARRAY['API','microservices','database','distributed systems','latency','throughput','testing','code review','CI/CD'],
 ARRAY['systems design','debugging','data modelling','code quality','collaboration'],
 '', 'seed-072'),
('software-engineer-fullstack', 'Full-Stack Software Engineer', 'builder',
 ARRAY['Build user-facing features end to end','Develop frontend and backend','Ship and iterate on product'],
 ARRAY['React','TypeScript','frontend','backend','API','full-stack','UX','testing'],
 ARRAY['product sense','systems design','debugging','collaboration'],
 '', 'seed-072'),
('sre', 'Site Reliability Engineer', 'ops',
 ARRAY['Own service reliability and SLOs','Run on-call and incident response','Reduce toil through automation','Track DORA/MTTR and drive postmortems'],
 ARRAY['SLO','SLI','error budget','on-call','incident','MTTR','DORA','reliability','observability','runbook'],
 ARRAY['incident response','automation','systems thinking','calm under pressure'],
 '', 'seed-072'),
('platform-infra', 'Platform / Infrastructure Engineer', 'builder',
 ARRAY['Build internal platforms and IaC','Own cloud infrastructure and golden paths','Enable other engineers via self-service'],
 ARRAY['IaC','Terraform','CDK','Kubernetes','platform','golden path','self-service','cloud'],
 ARRAY['systems design','automation','developer experience','documentation'],
 '', 'seed-072'),
('qa-engineering', 'Quality Assurance / Quality Engineering', 'hybrid',
 ARRAY['Define and run test strategy and quality gates','Build monitoring and quality dashboards','Partner cross-functionally with product, engineering, and go-to-market to find process bottlenecks','Standardise operational procedures'],
 ARRAY['test strategy','quality gates','monitoring','dashboards','cross-functional','process standardisation','reliability'],
 ARRAY['attention to detail','process design','cross-functional partnership','data analysis'],
 '', 'seed-072')
ON CONFLICT (family_key) DO NOTHING;

INSERT INTO role_aliases (alias, family_key) VALUES
('technical customer service associate','technical-support'),
('customer service','technical-support'),
('support engineer','technical-support'),
('technical support','technical-support'),
('service associate','technical-support'),
('customer support','technical-support'),
('cloud support','technical-support'),
('backend engineer','software-engineer-backend'),
('backend developer','software-engineer-backend'),
('software engineer','software-engineer-backend'),
('full-stack engineer','software-engineer-fullstack'),
('fullstack developer','software-engineer-fullstack'),
('full stack engineer','software-engineer-fullstack'),
('site reliability engineer','sre'),
('sre','sre'),
('reliability engineer','sre'),
('platform engineer','platform-infra'),
('infrastructure engineer','platform-infra'),
('cloud engineer','platform-infra'),
('devops engineer','platform-infra'),
('cloud & devops engineer','platform-infra'),
('quality assurance analyst','qa-engineering'),
('qa analyst','qa-engineering'),
('quality engineer','qa-engineering')
ON CONFLICT (alias) DO NOTHING;

-- =============================================================================
-- Verification
--   SELECT family_key, role_class, array_length(vocabulary,1) FROM role_ontology;
--   SELECT alias, family_key FROM role_aliases WHERE family_key='technical-support';
-- =============================================================================
