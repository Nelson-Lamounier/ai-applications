-- =============================================================================
-- 075_k8s_hosting_succession_seed.sql
-- =============================================================================
-- Seeds the technology-succession edges that let the doc-vs-code drift guard
-- recognise a STALE documentation claim. The motivating case: a portfolio repo
-- migrated its Kubernetes hosting from self-managed (kubeadm) to managed EKS, but
-- the repo's .md docs still describe "self-hosted Kubernetes". The deterministic
-- code extraction (technology_evidence: IaC/Syft/TreeSitter) shows `aws_eks` and
-- NOT the self-hosted entity, so the doc claim is superseded.
--
-- We add the two self-hosting entities (not previously in the ontology) + their
-- aliases, then `succeeds` edges: aws_eks SUCCEEDS self_hosted_kubernetes / kubeadm
-- (the newer managed platform replaces the older self-managed approach).
--
-- Idempotent: ON CONFLICT DO NOTHING throughout; ids resolved via canonical_name
-- joins (never hard-coded UUIDs). Safe to re-run.
-- =============================================================================

-- ── 1. Entities ───────────────────────────────────────────────────────────────
-- Both are Kubernetes-hosting approaches → category 'orchestration' (same as the
-- existing `kubernetes` entity). curation_level 'curated' so they participate in
-- category grouping and alias resolution.
INSERT INTO technology_ontology
    (canonical_name, display_name, category, curation_level, source, is_active)
VALUES
    ('self_hosted_kubernetes', 'Self-hosted Kubernetes', 'orchestration', 'curated', 'k8s-succession-seed', TRUE),
    ('kubeadm',                'kubeadm',                'orchestration', 'curated', 'k8s-succession-seed', TRUE)
ON CONFLICT (canonical_name) DO NOTHING;

-- ── 2. Aliases ────────────────────────────────────────────────────────────────
-- prose_safe=false: these only resolve in structured contexts + the drift guard's
-- explicit skill-string resolution, never the free-prose README scan.
INSERT INTO technology_aliases (alias, technology_id, source, prose_safe)
SELECT a.alias, o.id, 'k8s-succession-seed', FALSE
FROM (VALUES
    -- self_hosted_kubernetes
    ('self_hosted_kubernetes', 'self-hosted kubernetes'),
    ('self_hosted_kubernetes', 'self hosted kubernetes'),
    ('self_hosted_kubernetes', 'self-managed kubernetes'),
    ('self_hosted_kubernetes', 'self-hosted k8s'),
    ('self_hosted_kubernetes', 'self-managed k8s'),
    ('self_hosted_kubernetes', 'self-hosted cluster'),
    -- kubeadm
    ('kubeadm', 'kubeadm'),
    ('kubeadm', 'kube-adm'),
    ('kubeadm', 'kubeadm cluster')
) AS a(canonical, alias)
JOIN technology_ontology o ON o.canonical_name = a.canonical
ON CONFLICT (alias) DO NOTHING;

-- ── 3. Succession edges ───────────────────────────────────────────────────────
-- Semantics: (from SUCCEEDS to) = `from` is the newer technology that replaces the
-- older `to`. The drift guard keys on the OLDER (to) entity: a doc claim about the
-- predecessor is stale when a successor is the code truth and the predecessor is not.

-- aws_eks SUCCEEDS self_hosted_kubernetes
INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT a.id, b.id, 'succeeds'
FROM technology_ontology a
JOIN technology_ontology b ON TRUE
WHERE a.canonical_name = 'aws_eks'
  AND b.canonical_name = 'self_hosted_kubernetes'
ON CONFLICT DO NOTHING;

-- aws_eks SUCCEEDS kubeadm
INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT a.id, b.id, 'succeeds'
FROM technology_ontology a
JOIN technology_ontology b ON TRUE
WHERE a.canonical_name = 'aws_eks'
  AND b.canonical_name = 'kubeadm'
ON CONFLICT DO NOTHING;

-- kubeadm IMPLEMENTS self_hosted_kubernetes (kubeadm is one way to self-host) —
-- lets a successor of self_hosted_kubernetes also cover a kubeadm doc claim.
INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT a.id, b.id, 'implements'
FROM technology_ontology a
JOIN technology_ontology b ON TRUE
WHERE a.canonical_name = 'kubeadm'
  AND b.canonical_name = 'self_hosted_kubernetes'
ON CONFLICT DO NOTHING;
