-- 060_k8s_rbac_networkpolicy_ontology.sql — DevOps S3: distinct ontology canonicals for
-- Kubernetes NetworkPolicy + RBAC, so K8sManifestParser's new k8s_networkpolicy / k8s_rbac
-- tokens resolve and flow (via category) to S1's devops_networking / devops_security_iam topics.
-- These are real K8s skills → they legitimately belong in technology_ontology (no isolation concern).
-- Expand-only, idempotent (mirrors 035). loadAliasMap resolves ONLY via technology_aliases.
BEGIN;

INSERT INTO technology_ontology (canonical_name, display_name, category, curation_level, source) VALUES
  ('k8s_networkpolicy','Kubernetes NetworkPolicy','cloud_networking','curated','seed-060 K8s RBAC/NetworkPolicy, 2026-06-02'),
  ('k8s_rbac','Kubernetes RBAC','cloud_security','curated','seed-060 K8s RBAC/NetworkPolicy, 2026-06-02')
ON CONFLICT (canonical_name) DO NOTHING;

INSERT INTO technology_aliases (alias, technology_id, source)
SELECT a.alias, o.id, 'seed-060'
FROM (VALUES
  ('k8s_networkpolicy','k8s_networkpolicy'),
  ('networkpolicy','k8s_networkpolicy'),
  ('k8s_rbac','k8s_rbac'),
  ('rbac','k8s_rbac')
) AS a(alias, canonical)
JOIN technology_ontology o ON o.canonical_name = a.canonical
ON CONFLICT (alias) DO NOTHING;

COMMIT;
