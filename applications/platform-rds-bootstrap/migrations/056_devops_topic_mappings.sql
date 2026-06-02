-- 056_devops_topic_mappings.sql — DevOps interview-topic taxonomy mapped to the
-- technology_ontology.category buckets that the IaC parsers already populate in
-- technology_evidence. Read-only mapping layer: NO new extraction, NO backfill.
-- Category-level topics are DISJOINT (every technology has exactly one category),
-- so an evidence row maps to at most one topic — no double counting.
-- Tier-1 honesty: display_name says "declared/configured", never competence.
-- Global reference table (no user_id, no RLS), idempotent. Source: maps to the
-- category enum in 034_technology_graph.sql:28-34. Retrieved 2026-06-02.
BEGIN;

CREATE TABLE IF NOT EXISTS devops_topic_mappings (
  canonical_topic_name       TEXT PRIMARY KEY,
  display_name               TEXT NOT NULL,
  topic_group                TEXT NOT NULL,
  mapped_ontology_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  mapped_canonicals          JSONB NOT NULL DEFAULT '[]'::jsonb,
  jd_signal_keywords         JSONB NOT NULL DEFAULT '[]'::jsonb,
  source                     TEXT NOT NULL,
  as_of                      DATE NOT NULL
);

INSERT INTO devops_topic_mappings
  (canonical_topic_name, display_name, topic_group, mapped_ontology_categories, jd_signal_keywords, source, as_of) VALUES
('devops_iac','Infrastructure as Code','iac','["iac"]'::jsonb,'["terraform","cloudformation","cdk","pulumi","infrastructure as code"]'::jsonb,'technology_ontology.category=iac (034:28-34)','2026-06-02'),
('devops_containers','Containerization','containers','["container_runtime"]'::jsonb,'["docker","container","oci image"]'::jsonb,'technology_ontology.category=container_runtime','2026-06-02'),
('devops_orchestration','Container Orchestration (Kubernetes)','orchestration','["orchestration"]'::jsonb,'["kubernetes","k8s","eks","orchestration","autoscaling"]'::jsonb,'technology_ontology.category=orchestration','2026-06-02'),
('devops_cicd','CI/CD & GitOps','cicd','["ci_cd"]'::jsonb,'["ci/cd","github actions","gitops","argocd","pipeline","deployment"]'::jsonb,'technology_ontology.category=ci_cd','2026-06-02'),
('devops_observability','Observability & Monitoring','observability','["observability"]'::jsonb,'["observability","prometheus","grafana","monitoring","tracing","alerting","slo"]'::jsonb,'technology_ontology.category=observability','2026-06-02'),
('devops_cloud_compute','Cloud Compute','cloud','["cloud_compute"]'::jsonb,'["ec2","ecs","eks","compute","fargate"]'::jsonb,'technology_ontology.category=cloud_compute','2026-06-02'),
('devops_cloud_storage','Cloud Storage','cloud','["cloud_storage"]'::jsonb,'["s3","ebs","backup","object storage"]'::jsonb,'technology_ontology.category=cloud_storage','2026-06-02'),
('devops_cloud_database','Cloud Databases','cloud','["cloud_database"]'::jsonb,'["rds","aurora","dynamodb","managed database"]'::jsonb,'technology_ontology.category=cloud_database','2026-06-02'),
('devops_cloud_serverless','Serverless','cloud','["cloud_serverless"]'::jsonb,'["lambda","step functions","serverless","event-driven"]'::jsonb,'technology_ontology.category=cloud_serverless','2026-06-02'),
('devops_networking','Cloud Networking','networking','["cloud_networking"]'::jsonb,'["vpc","load balancer","route53","cloudfront","ingress","service mesh","dns"]'::jsonb,'technology_ontology.category=cloud_networking','2026-06-02'),
('devops_security_iam','Security & IAM','security','["cloud_security"]'::jsonb,'["iam","least privilege","secrets","kms","encryption","waf","cloudtrail","audit"]'::jsonb,'technology_ontology.category=cloud_security','2026-06-02'),
('devops_messaging','Messaging & Eventing','messaging','["message_broker"]'::jsonb,'["sqs","sns","eventbridge","kafka","queue","pub/sub","event-driven"]'::jsonb,'technology_ontology.category=message_broker','2026-06-02')
ON CONFLICT (canonical_topic_name) DO UPDATE SET
  display_name = EXCLUDED.display_name, topic_group = EXCLUDED.topic_group,
  mapped_ontology_categories = EXCLUDED.mapped_ontology_categories,
  jd_signal_keywords = EXCLUDED.jd_signal_keywords,
  source = EXCLUDED.source, as_of = EXCLUDED.as_of;

COMMIT;
