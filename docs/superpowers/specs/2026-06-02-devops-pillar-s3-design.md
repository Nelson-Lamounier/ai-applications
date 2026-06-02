# DevOps Pillar — S3 (lean): K8s NetworkPolicy + RBAC detection — Design

> **Date:** 2026-06-02
> **Status:** Approved design. Plan next.
> **Goal:** Detect Kubernetes NetworkPolicy + RBAC manifests as distinct DevOps evidence (networking / security) so they surface in the S1 DevOps workspace section — Tier-1, honest.
> **Repo:** `ai-applications` (single small PR). **Branch:** `feat/devops-pillar-s3` off develop.
> **Third sub-project** (S3, lean-scoped). Builds on S1 (`devops_topic_mappings`) — uses its existing category→topic mappings, no S1 change.
> **Migration number 060** (057–059 reserved for S4's open PR #120; both branch off develop independently → no stacking).

## Scope (lean — ratified)
Only the one long-tail item with a clean home + real value. **Deferred** (need new infrastructure, not built now): runbook evidence (no non-technology home), OTel authored-instrumentation call-site (needs a Tier-2 competence layer — the OTel *import* already gives Tier-1 observability via the existing TreeSitter+ontology path).

## Why this lands cleanly
NetworkPolicy/RBAC are real Kubernetes skills, so they legitimately belong in `technology_ontology` (no isolation concern, unlike DSA concepts). The existing `K8sManifestParser` already emits a single `kubernetes` token for recognised kinds; S3 adds **distinct tokens** for these two kinds + 2 ontology canonicals whose categories (`cloud_networking` / `cloud_security`) the S1 mapping already routes to `devops_networking` / `devops_security_iam`.

## Components

### A. migration `060_k8s_rbac_networkpolicy_ontology.sql`
Expand-only, idempotent (mirrors 035). Two `technology_ontology` rows + their aliases (alias is PK → `ON CONFLICT (alias) DO NOTHING`; `loadAliasMap` resolves ONLY via `technology_aliases`, lowercase+trim):
```sql
INSERT INTO technology_ontology (canonical_name, display_name, category, curation_level, source) VALUES
  ('k8s_networkpolicy','Kubernetes NetworkPolicy','cloud_networking','curated','seed-060 K8s RBAC/NetworkPolicy, 2026-06-02'),
  ('k8s_rbac','Kubernetes RBAC','cloud_security','curated','seed-060 K8s RBAC/NetworkPolicy, 2026-06-02')
ON CONFLICT (canonical_name) DO NOTHING;

INSERT INTO technology_aliases (alias, technology_id, source)
SELECT a.alias, o.id, 'seed-060'
FROM (VALUES
  ('k8s_networkpolicy','k8s_networkpolicy'), ('networkpolicy','k8s_networkpolicy'),
  ('k8s_rbac','k8s_rbac'), ('rbac','k8s_rbac')
) AS a(alias, canonical)
JOIN technology_ontology o ON o.canonical_name = a.canonical
ON CONFLICT (alias) DO NOTHING;
```
Aliases are tight — NOT the generic `role`/`rolebinding` (the parser emits the controlled `k8s_rbac` token, so only that needs to resolve; `networkpolicy`/`rbac` added as harmless safety variants).

### B. `K8sManifestParser.ts`
- Extend `K8S_KINDS` with `NetworkPolicy`, `Role`, `RoleBinding`, `ClusterRole`, `ClusterRoleBinding` (so a security/networking-only manifest is recognised as k8s → still emits the `kubernetes` token).
- In the per-doc loop, emit a **distinct token** by kind: `NetworkPolicy` → `raw_name: 'k8s_networkpolicy'`; any of the four RBAC kinds → `raw_name: 'k8s_rbac'` (both `ecosystem: 'iac'`, `source_layer: 'iac'`). De-dup so the same kind in one file emits its token once.

## Data flow
```
NetworkPolicy manifest → K8sManifestParser emits 'kubernetes' + 'k8s_networkpolicy'
  → OntologyResolver (alias) → technology_evidence (category cloud_networking)
  → S1 admin-api join (category=cloud_networking) → devops_networking topic
RBAC manifest → 'k8s_rbac' → cloud_security → devops_security_iam
```

## Error handling & honesty
- Tier-1 presence only ("you declared a NetworkPolicy at file:line") — S1's display language is already Tier-1.
- Unknown/other kinds unchanged; existing kinds + container-image extraction unaffected.
- A manifest with NetworkPolicy but no Deployment now correctly registers as kubernetes (previously missed).

## Testing
- **A (migration):** applies; the 2 canonicals exist; the aliases resolve (`SELECT technology_id FROM technology_aliases WHERE alias IN ('k8s_networkpolicy','k8s_rbac')` returns 2).
- **B (parser):** a NetworkPolicy manifest → emits `kubernetes` + `k8s_networkpolicy`; an RBAC (Role/ClusterRoleBinding) manifest → `kubernetes` + `k8s_rbac`; a Deployment manifest → `kubernetes` (+ images), NO `k8s_networkpolicy`/`k8s_rbac` (unchanged); a non-k8s yaml → nothing.

## Decomposition
Single PR (`ai-applications`): migration 060 + `K8sManifestParser` change + parser tests. Apply 060 to dev.

## Out of scope
Runbook evidence + OTel call-site (Tier-2) — future spec. S1/admin-api/UI unchanged (the new evidence flows through the existing DevOps section automatically).
