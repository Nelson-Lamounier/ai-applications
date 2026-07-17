<!-- @format -->

# JD Concept Ledger + Transfer Classes - Design

**Date:** 2026-07-17
**Status:** Draft for review
**Approach:** A + C from the JD-to-evidence review (deterministic concept
ledger in tech-extractor, plus query-time expansion as its consumption layer).
**Prerequisite:** dev migrations 117-119 applied (PR #503 unblocks the
bootstrap image; the ArgoCD PostSync hook applies them).

## Problem

67 JD analyses for the pilot user show a stable four-lane demand taxonomy
(Required / Preferred / Tools / Concepts), but the evidence supply cannot
answer two whole classes of it:

1. **Transferable tools score as gaps.** Terraform is required in 14 JDs and
   verdicted a gap in 12, despite 2,494 iac-layer `technology_evidence` rows
   (CDK, CloudFormation, Helm, K8s). Same shape: azure (23 gaps), gcp (24),
   gitlab-ci, mongodb. The system has no equivalence classes, so evidence for
   a sibling tool counts for nothing.
2. **Concepts have no evidence store.** The top JD concepts - ci/cd (20
   runs), incident response (19), distributed systems (13), root cause
   analysis (9) - resolve to zero tagged chunks. Chunk `skills[]` vocabulary
   never matched JD vocabulary, and the LLM enricher that produced it is
   decommissioned. 5 of the top-12 JD concepts are missing from
   `skill_ontology` entirely.

Bridge tables are thin: `tech_skill_map` holds 75 mappings between 2,502
technology canonicals and 273 skill canonicals.

## Goal

Categorise the user's evidence at extraction time into the same taxonomy JDs
use, deterministically and citably, so matching becomes a lookup:

- A JD tool with no direct evidence but a transfer-class sibling gets an
  honest `transferable` verdict citing the sibling's evidence, not a gap.
- A JD concept resolves to `concept_evidence` rows with file-level citations.
- Query-time expansion gives retrieval and the matcher the same widened
  vocabulary, without any LLM in the loop.

## Non-goals

- Reviving the chunk enricher (approach B) - deferred until the enrichment
  eval harness measures semantically instead of by exact string.
- UI changes in tucaken-app (the panels already render lanes; better data
  flows through unchanged).
- Prose/readme trust changes for the verified stack (CODE_LAYERS stays as
  is).

## Design

Three increments, each independently shippable and eval-gated.

### Increment 1 - Transfer classes (biggest gap-rate win)

**Data.** Seed `technology_relationships` with `relationship =
'transferable'` rows grouped by a `transfer_class` label. Initial classes,
derived from the observed gap corpus:

| transfer_class | members (canonical technologies) |
| --- | --- |
| `iac-declarative` | terraform, aws-cdk, cloudformation, pulumi, bicep |
| `ci-pipelines` | github-actions, gitlab-ci, jenkins, circleci, azure-devops |
| `container-orchestration` | kubernetes, ecs, nomad |
| `cloud-platform` | aws, azure, gcp (partial tier - platform breadth transfers, service names do not) |
| `document-store` | mongodb, documentdb, dynamodb |
| `secrets-managers` | aws-secrets-manager, vault, azure-key-vault |
| `observability-stacks` | grafana, datadog, new-relic, cloudwatch |

Each row carries `transfer_tier: full | partial` (cloud-platform is partial;
IaC is full) and a short `transfer_basis` sentence used verbatim in honest
framing ("IaC evidence is CDK/CloudFormation; Terraform itself not
evidenced").

**Consumption (matcher).** In the research matcher, when a canonical JD term
has no direct evidence, look up its transfer class; if a sibling has
evidence, emit verdict `partial` with `matchBasis: 'transferable'`, the
sibling named, and the sibling's citations attached. Never silently upgrade
to `verified` - the two-tier honesty rule holds.

**Consumption (retrieval, the C layer).** `buildRetrievalPrefilter` expands
`file_tech_stack` filter terms with class siblings so chunks evidencing CDK
surface for a Terraform JD. Expansion happens at query time from the
relationships table; nothing is re-stamped.

### Increment 2 - Concept ledger

**Ontology.** Add the missing JD concepts to `skill_ontology` (with aliases:
"ci/cd" = "ci-cd" = "continuous integration and delivery" = "ci/cd pipeline
design"). Seed list = frequency-ranked concepts from the live JD corpus
(observability, ci/cd, incident response, distributed systems, container
orchestration, process automation, secrets management, root cause analysis,
vulnerability scanning, infrastructure as code, ...), capped at ~60 to stay
curatable.

**Evidence table.** New migration: `concept_evidence` (mirrors
`technology_evidence` ergonomics):

```sql
concept_evidence (
  id, user_id, repo_full_name, github_repo_id,
  skill_id        -- FK skill_ontology
  detector        -- which rule fired
  source_kind     -- 'signal' | 'file' | 'aggregate'
  file_path, line_start, line_end,   -- NULL for signal-level evidence
  confidence, extracted_at, commit_sha
)
UNIQUE (user_id, repo_full_name, skill_id, detector, coalesce(file_path,''))
```

**Detector layer in tech-extractor.** A new deterministic pass alongside the
existing extractors, consuming artefacts the run already has (file walk,
manifests, parsed IaC, plus `archetype_signals` / `evidence_topology`):

| concept | detector inputs (examples) |
| --- | --- |
| ci/cd | workflow files parsed by GithubActionsParser; deploy jobs -> higher confidence |
| observability | monitoring config globs, Grafana dashboards/alert rules, OTel/alloy config, metrics code hits |
| incident response | runbooks dir, alert rules with severity routes, on-call config |
| container orchestration | k8s manifests + helm charts + argo apps (already parsed) |
| secrets management | ESO manifests, secrets-manager SDK usage (treesitter), vault config |
| distributed systems | multi-service compose/k8s topology + queue/broker manifests + cross-service clients |
| infrastructure as code | any iac-layer technology evidence (aggregate) |
| process automation | cron/schedule manifests, bot workflows, scripted ops dirs |

Every detector emits file:line where a concrete file exists, or
`source_kind='signal'` rows citing the signal map. Detectors are pure
functions with unit tests; no LLM.

**Consumption.** The matcher resolves JD concepts through `skill_ontology`
aliases to `concept_evidence`; verdicts cite detector + files. Concepts with
no detector coverage stay honest gaps (e.g. "technical support",
"customer relationship management" - career-history territory, out of scope
here).

### Increment 3 - Canonicalisation at the JD boundary + bridge growth

- jd-extractor output lanes are canonicalised on persist (same
  `OntologyResolver` cascade the enricher used: alias map, embedding-nearest,
  raw). The stored `jdExtraction` keeps raw strings for display plus
  `canonicalIds` per lane for matching - the UI chips stay human, the matcher
  goes canonical.
- Unresolved JD terms feed the existing `ontology_gap_candidates` sink, so
  the ontology grows from real demand instead of guesswork.
- Grow `tech_skill_map` deterministically: every technology canonical maps to
  its category-level skill (kubernetes -> container orchestration, terraform
  -> infrastructure as code) harvested from `technology_ontology` categories.
  75 rows -> full coverage.

## Evals (per phase, before scale - CLAUDE.md rule 5)

Golden set = the 67 real JD extractions already in `pipeline_runs` (frozen
snapshot, no new LLM calls needed).

- **Gap-rate eval (increment 1):** re-run matching offline over the golden
  set; metric = required+tools lane gap rate before/after transfer classes.
  Target: terraform/azure/gcp class gaps convert to `partial(transferable)`;
  zero honest gaps lost (ldap, kerberos, active directory must stay gaps).
- **Concept-coverage eval (increment 2):** fraction of JD concept mentions
  resolving to >= 1 `concept_evidence` row with a citation. Report per
  concept; assert no detector fires on a repo lacking the artefact (FP gate,
  mirrors the DSA detector <= 5% FP discipline).
- **Canonicalisation eval (increment 3):** resolution rate of JD lane terms
  to canonicals; alias misses land in the gap sink, not silently dropped.

## Sequencing and risk

1. Increment 1 is pure data + matcher logic - no new extraction run needed,
   works for all users immediately. Ship first.
2. Increment 2 needs a tech-extractor release + one re-extract per repo
   (5 repos for the pilot user). Detectors are additive; a detector bug can
   only over- or under-claim concepts, gated by the FP eval.
3. Increment 3 touches the strategist persist path; keep behind a metadata
   version field so old runs render unchanged.

Rollback story: every increment is a table + consumption flag; disabling the
consumption flag restores current behaviour without data loss.
