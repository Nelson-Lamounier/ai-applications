-- =============================================================================
-- Migration 073 — role_ontology scalability: new-family votes, company-type
-- overlay, and curated-seed expansion (to ~20 families). Idempotent.
-- =============================================================================

-- A: allow 'family' learning votes (extend the CHECK; DROP+ADD is idempotent)
ALTER TABLE role_learning_candidates
  DROP CONSTRAINT IF EXISTS role_learning_candidates_candidate_type_check,
  ADD  CONSTRAINT role_learning_candidates_candidate_type_check
       CHECK (candidate_type IN ('alias','vocabulary','transferable_skill','family'));

-- C: company-type enum + framing overlay
DO $$ BEGIN
  CREATE TYPE company_type_enum AS ENUM ('saas','infra_provider','fintech','hardware','agency','enterprise','marketplace','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS company_type_framing (
  company_type company_type_enum PRIMARY KEY,
  framing_note TEXT NOT NULL DEFAULT ''
);
INSERT INTO company_type_framing (company_type, framing_note) VALUES
('saas',           'Subscription product — frame work around customers, subscriptions, churn/expansion, and a customer-success motion.'),
('infra_provider', 'Operates like SaaS — paying customers, subscriptions, account health; frame infrastructure-provider work as customer-facing SaaS.'),
('fintech',        'Regulated financial product — frame work around compliance, reliability, security, and customer trust.'),
('hardware',       'Hardware/device company — frame support around RMA, firmware, supply chain, and field reliability.'),
('agency',         'Services/agency — frame work around client delivery, multiple accounts, and billable outcomes.'),
('enterprise',     'Large enterprise — frame work around scale, governance, stakeholder management, and process.'),
('marketplace',    'Two-sided marketplace — frame work around supply/demand, trust & safety, and growth loops.'),
('other',          '')
ON CONFLICT (company_type) DO NOTHING;

-- C: move the AWS-specific note out of the family (now company-type-driven)
UPDATE role_ontology SET industry_notes = '' WHERE family_key = 'technical-support';

-- B: expand the curated seed (~15 more families)
INSERT INTO role_ontology (family_key, display_name, role_class, canonical_responsibilities, vocabulary, transferable_skills, industry_notes, source) VALUES
('product-management','Product Manager','hybrid',
 ARRAY['Define product strategy and roadmap','Prioritise based on user + business value','Coordinate engineering, design, and GTM','Measure outcomes with metrics'],
 ARRAY['roadmap','prioritisation','user research','metrics','stakeholder','OKRs','discovery','go-to-market'],
 ARRAY['prioritisation','communication','data-driven decisions','cross-functional leadership'],'', 'seed-073'),
('data-science','Data Scientist','builder',
 ARRAY['Frame business problems as data problems','Build models and run experiments','Communicate insights to stakeholders'],
 ARRAY['statistics','machine learning','experimentation','A/B testing','Python','SQL','modelling','inference'],
 ARRAY['analytical thinking','experimentation','communication','statistical rigour'],'', 'seed-073'),
('ml-engineering','Machine Learning Engineer','builder',
 ARRAY['Productionise ML models and pipelines','Serve and monitor models at scale','Build training/inference infrastructure'],
 ARRAY['MLOps','model serving','feature store','training pipeline','inference','GPU','LLM','RAG','vector'],
 ARRAY['systems design','ML fundamentals','automation','debugging'],'', 'seed-073'),
('data-engineering','Data Engineer','builder',
 ARRAY['Build and operate data pipelines','Model warehouses and own data quality','Enable analytics and ML on reliable data'],
 ARRAY['ETL','ELT','warehouse','pipeline','dbt','Airflow','streaming','data quality','SQL'],
 ARRAY['data modelling','pipeline reliability','SQL','systems thinking'],'', 'seed-073'),
('security-engineering','Security Engineer','ops',
 ARRAY['Identify and remediate security risks','Run incident response and threat detection','Build security tooling and guardrails'],
 ARRAY['threat detection','incident response','IAM','vulnerability','SIEM','zero trust','compliance','encryption'],
 ARRAY['risk analysis','incident response','attention to detail','systems thinking'],'', 'seed-073'),
('solutions-engineering','Solutions / Sales Engineer','customer_facing',
 ARRAY['Partner with sales on technical wins','Run demos, POCs, and architecture sessions','Translate customer needs to product + back'],
 ARRAY['POC','demo','pre-sales','architecture','customer requirements','technical win','cross-functional','enablement'],
 ARRAY['technical communication','customer empathy','stakeholder management','problem framing'],'', 'seed-073'),
('ux-design','Product / UX Designer','hybrid',
 ARRAY['Design user flows and interfaces','Run user research and usability testing','Partner with product + engineering'],
 ARRAY['user research','wireframe','prototype','usability','design system','accessibility','Figma'],
 ARRAY['user empathy','visual communication','research','cross-functional collaboration'],'', 'seed-073'),
('devrel','Developer Relations / Advocate','customer_facing',
 ARRAY['Educate and grow a developer community','Build samples, docs, and talks','Feed developer feedback to product'],
 ARRAY['community','documentation','developer experience','content','enablement','advocacy','API'],
 ARRAY['technical communication','community building','empathy','content creation'],'', 'seed-073'),
('engineering-management','Engineering Manager','hybrid',
 ARRAY['Lead and grow an engineering team','Own delivery and technical direction','Coach, hire, and manage performance'],
 ARRAY['people management','delivery','hiring','coaching','roadmap','1:1s','team health'],
 ARRAY['leadership','communication','coaching','prioritisation'],'', 'seed-073'),
('program-management','Technical Program Manager','hybrid',
 ARRAY['Drive cross-team programs to delivery','Manage dependencies, risks, and timelines','Communicate status to stakeholders'],
 ARRAY['program management','dependencies','risk','timeline','stakeholder','cross-functional','delivery'],
 ARRAY['organisation','cross-functional leadership','risk management','communication'],'', 'seed-073'),
('customer-success','Customer Success Manager','customer_facing',
 ARRAY['Own customer outcomes and renewals','Drive adoption and reduce churn','Advocate for customers internally'],
 ARRAY['adoption','renewal','churn','onboarding','QBR','account health','expansion','customer outcomes'],
 ARRAY['relationship management','customer empathy','data-driven','communication'],'', 'seed-073'),
('technical-writing','Technical Writer','customer_facing',
 ARRAY['Write and maintain product documentation','Make complex systems understandable','Partner with engineering + support'],
 ARRAY['documentation','API docs','tutorials','information architecture','content','enablement'],
 ARRAY['clear writing','technical communication','empathy','attention to detail'],'', 'seed-073'),
('mobile-engineering','Mobile Engineer','builder',
 ARRAY['Build and ship mobile apps','Optimise performance and UX on device','Integrate with backend services'],
 ARRAY['iOS','Android','Swift','Kotlin','React Native','mobile','app store','performance'],
 ARRAY['product sense','debugging','UX awareness','collaboration'],'', 'seed-073'),
('marketing','Marketing','hybrid',
 ARRAY['Drive awareness and demand','Run campaigns and measure funnel','Position the product to the market'],
 ARRAY['campaign','funnel','positioning','content','SEO','demand gen','brand','analytics'],
 ARRAY['communication','data-driven','creativity','positioning'],'', 'seed-073'),
('business-analyst','Business / Data Analyst','hybrid',
 ARRAY['Turn data into business decisions','Build dashboards and reports','Partner with stakeholders on requirements'],
 ARRAY['SQL','dashboards','reporting','requirements','KPIs','analytics','stakeholder'],
 ARRAY['analytical thinking','communication','requirements gathering','data fluency'],'', 'seed-073')
ON CONFLICT (family_key) DO NOTHING;

INSERT INTO role_aliases (alias, family_key) VALUES
('product manager','product-management'),('product owner','product-management'),
('data scientist','data-science'),('machine learning scientist','data-science'),
('machine learning engineer','ml-engineering'),('ml engineer','ml-engineering'),('ai engineer','ml-engineering'),
('data engineer','data-engineering'),
('security engineer','security-engineering'),('security analyst','security-engineering'),
('solutions engineer','solutions-engineering'),('sales engineer','solutions-engineering'),('solutions architect','solutions-engineering'),
('product designer','ux-design'),('ux designer','ux-design'),('ui designer','ux-design'),
('developer advocate','devrel'),('developer relations','devrel'),
('engineering manager','engineering-management'),('team lead','engineering-management'),
('technical program manager','program-management'),('program manager','program-management'),('project manager','program-management'),
('customer success manager','customer-success'),('account manager','customer-success'),
('technical writer','technical-writing'),
('mobile engineer','mobile-engineering'),('ios engineer','mobile-engineering'),('android engineer','mobile-engineering'),
('marketing manager','marketing'),('growth marketer','marketing'),
('business analyst','business-analyst'),('data analyst','business-analyst')
ON CONFLICT (alias) DO NOTHING;

-- =============================================================================
-- Verification
--   SELECT count(*) FROM role_ontology;            -- expect ~20
--   SELECT * FROM company_type_framing;
--   SELECT conname FROM pg_constraint WHERE conrelid = 'role_learning_candidates'::regclass;
-- =============================================================================
