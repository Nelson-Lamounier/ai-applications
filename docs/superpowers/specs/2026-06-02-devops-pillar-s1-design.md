# DevOps Pillar — S1: topic-mapping layer + Technical-workspace section — Design

> **Date:** 2026-06-02
> **Status:** Approved design (brainstorming complete). Plan next.
> **Goal:** Surface a user's real DevOps/infrastructure work in the Technical workspace by mapping the IaC/cloud/container evidence that ALREADY lives in `technology_evidence` to a bounded DevOps topic taxonomy — honestly (Tier-1 "you declared X at file:line", never "you're an expert").
> **Repos:** `ai-applications` (mapping table + seed) + `tucaken-app` (admin-api serve + UI).
> **Design input:** `docs/superpowers/specs/2026-06-02-devops-ai-pillars-design-input.md` (workflow + 2 verdicts).
> **First of 8 sub-projects** (S1). Reuses the DSA `dsaRealWork` read-path pattern.

## Why this is cheap (the asymmetry)

Unlike DSA (no in-repo evidence → needed a new detector), DevOps evidence is **already extracted**: the IaC parsers (`TerraformParser`, `DockerfileParser`, `K8sManifestParser`, `ArgoHelmParser`, `GithubActionsParser`, `ArnScanner`, `EcrUriScanner`) already land ~24 DevOps technologies in `technology_evidence`, resolved to `technology_ontology` (which already has a `category` CHECK enum: `iac`, `ci_cd`, `container_runtime`, `orchestration`, `cloud_compute/storage/database/serverless/networking/security`, `observability`, `message_broker`). **S1 adds no extraction and no backfill — only a topic-mapping layer + a read path + a workspace section.**

## Honesty constraints (carried as hard requirements)

1. **Tier-1 only.** The parsers prove **artifact-presence**, not competence. A one-line `FROM nginx`, a `helm create` scaffold, a copied `actions/checkout`, a pasted IAM ARN all fire signals while proving zero competence. S1 makes ONLY Tier-1 claims: *"you declared/referenced/configured X at `file:line`."* Tier-2 ("topic-competent" — multi-stage Docker, probes+limits, authored CI logic) needs depth-marker extraction and is **explicitly out of scope** (future spec).
2. **Display language rule.** Mapping `display_name` and UI copy say "declared / configured / references", **never** "expert in / knows / your work shows / mastered".
3. **Prose suppression.** Evidence whose `source_layer ∈ {readme, code-prose}` or whose `file_path` matches `*.md`/`*.markdown` is **excluded** — a mention in a README is not evidence of doing.
4. **Evidence-driven, JD-agnostic gating.** Section shows iff the user has ≥1 (non-prose) DevOps evidence row. No JD dependency (S2 adds calibration later). No empty/fake section.

## Components

### A. `devops_topic_mappings` — migration `056_devops_topic_mappings.sql` (`ai-applications`)
Global reference table (no `user_id`, no RLS), idempotent `INSERT … ON CONFLICT`, mirrors `dsa_topics` provenance. **Category-first hybrid mapping** (self-maintaining: a newly-imported tech auto-flows via its ontology category; canonical overrides only where finer grain is wanted):
```sql
CREATE TABLE IF NOT EXISTS devops_topic_mappings (
  canonical_topic_name      TEXT PRIMARY KEY,          -- 'devops_iac'
  display_name              TEXT NOT NULL,             -- 'Infrastructure as Code'  (Tier-1 safe)
  topic_group               TEXT NOT NULL,             -- display grouping: iac|containers|cloud|networking|security|observability|cicd|messaging
  mapped_ontology_categories JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ['iac'] — technology_ontology.category values
  mapped_canonicals          JSONB NOT NULL DEFAULT '[]'::jsonb,  -- optional fine-grain canonical_name overrides
  jd_signal_keywords         JSONB NOT NULL DEFAULT '[]'::jsonb,  -- for S2 (unused in S1)
  source                    TEXT NOT NULL,
  as_of                     DATE NOT NULL
);
```
**Seed ~30 topics.** Representative (category-mapped unless noted):
- `devops_iac` → `["iac"]`; finer: `devops_terraform`/`devops_cdk`/`devops_cloudformation` via `mapped_canonicals`.
- `devops_containers` → `["container_runtime"]`; `devops_k8s_orchestration` → `["orchestration"]`.
- `devops_cicd` → `["ci_cd"]`; `devops_gitops` → canonicals `["argocd","flux"]`.
- `devops_observability` → `["observability"]`.
- `devops_cloud_compute`/`_storage`/`_database`/`_serverless` → respective `cloud_*` categories.
- `devops_networking` → `["cloud_networking"]`; `devops_security_iam` → `["cloud_security"]`.
- `devops_messaging` → `["message_broker"]`.
(Exact 30-row seed enumerated in the plan; each row Tier-1 `display_name` + cited `source`/`as_of`.)

No new `RdsDevopsMappingRepository` strictly required for S1 (the read path is in admin-api), but a tiny shared loader may be added if convenient; not required.

### B. admin-api read-path — `GET /:slug` serves `devopsEvidence` (`tucaken-app`)
RLS-scoped via the existing outer `withUser` client (reuse the `dsaRealWork` pattern — no second pool checkout). Fail-open (query error → field omitted, 200). Join + aggregate:
```sql
SELECT m.canonical_topic_name, m.display_name, m.topic_group,
       COUNT(*)::int AS artifact_count,
       (ARRAY_AGG(json_build_object('repo', e.repo_full_name, 'file', e.file_path,
                                    'line', e.line_start, 'rawName', e.raw_name)
                  ORDER BY e.confidence DESC))[1:3] AS samples
  FROM technology_evidence e
  JOIN technology_ontology o ON o.id = e.technology_id
  JOIN devops_topic_mappings m
    ON  (o.category = ANY (SELECT jsonb_array_elements_text(m.mapped_ontology_categories))
         OR o.canonical_name = ANY (SELECT jsonb_array_elements_text(m.mapped_canonicals)))
 WHERE e.user_id = current_setting('app.current_user_id')::uuid
   AND e.source_layer NOT IN ('readme','code-prose')          -- prose suppression
   AND e.file_path !~* '\.(md|markdown)$'                      -- prose suppression
 GROUP BY m.canonical_topic_name, m.display_name, m.topic_group;
```
Served shape `ApplicationDetail.devopsEvidence?: DevopsTopicEvidence[]` where
`DevopsTopicEvidence = { canonicalTopicName, displayName, topicGroup, artifactCount, samples: {repo,file,line,rawName}[] }`.

### C. UI — Section C "DevOps / Infrastructure" (`TechnicalWorkspace.tsx`, `tucaken-app`)
- Gated **evidence-driven**: render iff `devopsEvidence?.length`.
- Grouped by `topicGroup`; each topic = a Tier-1 card: *"You declared `{rawName}` at `{repo}/{file}:{line}`"* (+ `(N artifacts)` when count>1) + GitHub deep-link (`https://github.com/{repo}/blob/HEAD/{file}#L{line}`).
- Section banner (honesty): *"This shows the infrastructure artifacts your repos declare, with receipts — what you can speak to, not a competence score. Depth assessment is coming."*
- UI types: `DevopsTopicEvidence` + `ApplicationDetail.devopsEvidence` in `applications.types.ts`.

## Data flow
```
ingestion → tech-extract (existing) → technology_evidence (IaC/cloud/container)   [no change]
admin-api GET /:slug → join technology_evidence ⋈ technology_ontology ⋈ devops_topic_mappings
                       (RLS, prose-suppressed) → devopsEvidence
TechnicalWorkspace → Section C (evidence-driven) → Tier-1 cards + file:line links
```

## Error handling & honesty guardrails
- Join failure → `devopsEvidence` omitted, 200 (fail-open), section hidden.
- Empty result → section hidden (no fake section).
- Tier-1 display language enforced in seed `display_name` + UI copy; prose suppressed in SQL.
- No write path, no new extraction, no job change → nothing to break in ingestion.

## Testing
- **A (migration):** applies; seed rows > 0; every `mapped_ontology_categories` value is a valid `technology_ontology.category`; `mapped_canonicals` resolve to real canonicals.
- **B (admin-api):** join aggregates by topic from fake pg rows; RLS-scoped (`withUser`); prose rows (readme/`.md`) excluded; query failure → field omitted + 200.
- **C (UI):** Section C renders only with evidence; Tier-1 copy (no "expert/knows"); file:line link present; hidden when `devopsEvidence` empty/undefined.

## Decomposition (2 PRs)
- **PR1 (`ai-applications`):** migration 056 `devops_topic_mappings` + ~30-row seed (+ optional shared loader). Apply to dev.
- **PR2 (`tucaken-app`):** admin-api serves `devopsEvidence` (RLS, prose-suppressed, fail-open) + types; Technical Section C (evidence-driven, Tier-1, banner). Depends on PR1.

## Out of scope (S1)
- Tier-2 competence (depth-marker extraction) — future spec.
- JD pillar calibration (S2), round_type (S5), runbook/OTel detectors (S3), AI pillar (S4), story-mining/system-tour (S6–S8).
