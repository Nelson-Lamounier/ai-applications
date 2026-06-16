<!-- @format -->

# Repository Profile Strategy

**Goal.** Give the resume pipeline a **repo-level identity** — what each ingested repo *is* and
*provisions/implements* — so generation reasons about "tucaken-infra **is** the EKS-via-CDK
infrastructure repo", not just isolated tech names. This is the root fix for the
self-hosted/kubeadm drift: the EKS truth was extracted as names but never assembled into a repo
identity the matcher could prefer over a stale career narrative.

## What exists today (and the gap)

| Capability | Exists | Consumed by resume pipeline |
|---|---|---|
| Folder-structure scan → `repo_sync_state.archetype_signals` (46-key map: `has_iac`, `has_k8s_manifests`, `has_argocd_apps`, `has_helm_chart`, `has_ci`, …) via `deriveRepoSignals()` | ✅ at ingest | ❌ **dead — never read** |
| Repo classification (`repository_profiles.classification`: project/fork/tutorial/stale/noise) | ✅ | ❌ |
| **Services / concepts provisioned** ("provisions EKS via CDK", "LGTM observability") | ❌ does not exist | — |
| Per-repo tech rollup with identity | ❌ | — |

Extraction is per-file/per-tech (`technology_evidence`). No stage assembles a repo into an identity,
and the two categorization sources that *do* exist are never consumed.

## Design — the `repo_profile` layer

### Decisions
- **Scope:** full profile — activate signals + concept synthesis + feed to generation.
- **Method:** deterministic rules + ontology graph for the structured facts; an LLM writes **only**
  the one-line human summary from those verified facts (no hallucinated capabilities).

### Profile shape (`repo_profile` table, per user+repo)
- `repo_type` — `cdk-infra` | `k8s-platform` | `application` | `monitoring` | `ml` | `mobile` | `library` | `docs-site` | `monorepo` (deterministic, from signals + tech).
- `frameworks[]` — IaC/build frameworks actually used (`aws_cdk`, `terraform`, `helm`, …).
- `services[]` — cloud services / infra the repo provisions or operates (`aws_eks`, `aws_rds`, `aws_s3`, …) from `technology_evidence` deterministic layers.
- `concepts[]` — higher-level patterns inferred by rule (e.g. `gitops` from `has_argocd_apps`, `observability` from monitoring config + grafana/prometheus tech).
- `summary` — one honest sentence written by Haiku **from the above facts only**.
- `signals` — the raw archetype_signals snapshot (provenance).
- `commit_sha`, `updated_at` — freshness.

### Deterministic rules (examples)
- `has_iac && aws_cdk ∈ tech` → `repo_type = cdk-infra`, `frameworks += aws_cdk`.
- `aws_eks ∈ tech` → `services += aws_eks`; with `cdk-infra` → concept `provisions-managed-kubernetes`.
- `has_argocd_apps` → concept `gitops`.
- `has_k8s_manifests && has_helm_chart && !cdk` → `repo_type = k8s-platform`.
- `notebook_heavy || has_requirements_with_ml_deps` → `repo_type = ml`.
- Services/frameworks are drawn ONLY from `technology_evidence` deterministic layers (syft/treesitter/iac/dockerfile) — never prose — so the profile cannot claim what the code does not contain.

### Where it runs
- **Build:** read-time in job-strategist (assemble from `technology_evidence` + `archetype_signals`, like `loadRepoCodeTech`), and **persist a snapshot** to `repo_profile` for tracking + reuse. The LLM summary is cached and only regenerated when the repo's `commit_sha`/tech set changes.
- **Feed:** inject the relevant repo profiles into the research **and** strategist grounding (a `## Repository Profiles` block alongside `## Current Code Stack`), so the matcher knows each repo's identity. Later: route/weight KB retrieval by `repo_type` for the JD.

## Build sequence

1. **Increment 1 (deterministic foundation).** `repo_profile` table + a pure deterministic profile builder (`repo_type` + `frameworks[]` + `services[]` + `concepts[]` from signals + tech) + persist + inject the structured profile into research/strategist grounding. No LLM yet. Fixes the repo-identity gap with verifiable facts.
2. **Increment 2 (summary line).** Add the Haiku one-line summary from the verified facts (cached on commit_sha). Enrich the concept rules.
3. **Increment 3 (retrieval routing).** Use `repo_type` + the JD to weight/route KB retrieval and tech-transfer groups (e.g. infra JD → boost cdk-infra/k8s-platform repos).

## Status
- Increment 1 — in progress.
- Increments 2–3 — planned.
