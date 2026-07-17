<!-- @format -->

# Unified Repo Ingestion + Fact Sheet - Design (v2)

**Date:** 2026-07-17 (v2 - supersedes the concept-ledger-only v1; v1's
increments survive as phases P0/P3 here)
**Status:** Draft for review
**Decision trail:** user approved approach A+C (transfer classes + concept
ledger + query-time expansion), then widened scope: merge the two scanners
(ingestion + tech-extractor) into ONE system, one directory, index-time
categorisation, explicit payload contracts, minimal cost.

## Problem

1. **Two scanners, one repo.** Every sync runs two K8s Jobs that acquire the
   same repository twice (ingestion: Trees+Blobs API per file;
   tech-extractor: tarball), walk the tree twice, and classify files twice.
   The evidence stamp is a post-hoc UPDATE pass over `document_embeddings`
   that races the tech-extractor's writes.
2. **Late canonicalisation.** Raw strings land in the DB; agents compare
   strings at query time. Industry practice (skills-graph systems such as
   Lightcast/ESCO-style taxonomies, and search index-time enrichment
   generally) resolves every mention to a canonical ID at write time and
   keeps query time a lookup.
3. **No materialised categorisation.** "What database does this repo use?"
   and "is this frontend or backend?" currently require an agent to
   re-derive the answer from 28k evidence rows and 15k chunks. The JD
   taxonomy (Required / Preferred / Tools / Concepts) has no supply-side
   mirror.
4. **Relationships unused.** `technology_relationships` exists but nothing
   consults it, so Terraform JDs verdict "gap" against 2,494 iac-layer
   evidence rows (CDK/CloudFormation), azure/gcp verdict "gap" against deep
   AWS evidence (measured over 67 real JD analyses).
5. **Code scattered.** The ingestion system spans four roots:
   `applications/ingestion`, `applications/shared/src/ingestion`,
   `applications/shared/src/rds/pipeline`, `applications/tech-extractor`.

## Goal

One ingestion system, one directory, one acquisition per sync, that
**categorises at scan time** into the same taxonomy JDs use, materialises a
per-repo fact sheet that answers categorical questions without an agent, and
keeps the vector store for what it is good at (prose evidence retrieval).
LLM usage capped at one profile call per repo sync.

## Non-goals

- Reviving per-chunk LLM enrichment (deterministic facts replace it).
- Changing the retrieval read side (`RdsVectorStore.querySimilar`,
  `PgVectorRetriever`) beyond consuming expanded filters and fact metadata.
- Multi-provider acquisition (GitHub-only stays).
- tucaken-app UI changes.

## Use-cases and payload contracts

The design is driven by four concrete query shapes. Each gets an explicit
payload; downstream agents consume these instead of re-deriving.

### UC1 - categorical question ("what database does this repo use?")

One lookup, no agent, no vector search:

```sql
SELECT facts->'databases' FROM repo_facts
 WHERE user_id = $1 AND repo_full_name = $2;
```

### UC2 - role question ("frontend or backend repository?")

`repo_facts.role` (+ `role_confidence`), computed by the existing
`classifyComponentKind` rules at ingestion time.

### UC3 - JD matching (Required / Preferred / Tools / Concepts lanes)

The matcher receives, per canonical JD term:

```jsonc
{
  "term": "terraform",              // canonical id + display name
  "verdict": "partial",             // verified | partial | gap
  "matchBasis": "transferable",     // direct | transferable | concept
  "via": "aws-cdk",                 // sibling that carries the evidence
  "transferBasis": "declarative IaC - CDK/CloudFormation evidenced, Terraform itself not",
  "evidence": [ { "repo": "...", "file": "infra/lib/api-stack.ts", "line": 12,
                   "layer": "iac", "version": null } ]
}
```

Rules: `transferable` never upgrades to `verified` (two-tier honesty);
`concept` verdicts cite `concept_evidence` detector + files; honest gaps
(ldap, kerberos, active directory in the pilot corpus) must remain gaps.

### UC4 - narrative grounding (case study, resume, chatbot)

Unchanged consumption of `document_embeddings` (hybrid vector+BM25) and
`technology_evidence` - but chunk metadata now carries fact-pass stamps at
insert time (lane, `file_tech_stack`, authorship), so filter-then-rank needs
no post-hoc backfill.

### The fact sheet payload (`repo_facts`, one row per repo)

Mirrors `JdSignal.technologyInventory` lane-for-lane so supply and demand
share a schema:

```jsonc
{
  "role": "backend",                       // ProjectComponentKind
  "role_confidence": 0.9,
  "archetype": "production_saas",
  "classification": "project",             // trust gate
  "quality_score": 1.0,
  "languages":      [ { "name": "typescript", "pct": 82 } ],
  "frameworks":     [ { "name": "react", "version": "19.1", "evidence_count": 14 } ],
  "databases":      [ { "name": "postgresql", "version": "16", "evidence_count": 9 },
                      { "name": "redis", "evidence_count": 4 } ],
  "infrastructure": [ { "name": "kubernetes" }, { "name": "aws-cdk" } ],
  "tools":          [ { "name": "github-actions" }, { "name": "jest" } ],
  "concepts":       [ { "name": "ci/cd", "detector": "workflow-deploy", "files": 6 },
                      { "name": "observability", "detector": "grafana-config", "files": 11 } ],
  "fact_version": 1,
  "computed_at": "..."
}
```

Every `name` is a canonical ontology name; every entry is backed by
`technology_evidence` / `concept_evidence` rows (the fact sheet stores
counts, the evidence tables keep the file:line citations). Stored as one
JSONB column + generated columns for the hot filters (`role`,
`classification`).

## Architecture

```text
ONE K8s Job per repo sync (namespace ingestion)
│
├─ 0 ACQUIRE     tarball snapshot @ HEAD (caps: compressed/extracted/per-file
│                already implemented in tech-extractor's safeExtract) +
│                commits/PRs/contributors via API. Watermark short-circuit:
│                HEAD unchanged -> skip to activity delta only.
│
├─ 1 FACTS       single file walk, deterministic, no LLM:
│                fileClass lanes · Syft + GitHub SBOM · TreeSitter imports ·
│                IaC parsers (Dockerfile/K8s/Terraform/Actions/Helm/Argo) ·
│                README + code-comment prose mining · DSA/AI pattern
│                detectors · concept detectors · repo signals + topology.
│                All raw mentions -> OntologyResolver AT WRITE TIME
│                (alias -> embedding-nearest -> gap-candidate sink).
│                Writes: technology_evidence, concept_evidence,
│                dsa/ai_evidence, repo_sync_state, and repo_facts.
│
├─ 2 KNOWLEDGE   FileFilter -> chunkers (markdown/code/default) -> Titan
│                embed (content-hash gated) -> document_embeddings upsert.
│                Chunk metadata stamped INLINE from stage 1 (lane,
│                file_tech_stack, evidence stamp) - the post-hoc
│                stampUserEvidenceMetadata pass and its race are deleted.
│
├─ 3 NARRATIVE   one LLM call: ProfileExtractor, fed the fact sheet (no more
│                README guessing for facts it already has) ->
│                repository_profiles + profile embeddings. RetrievalProbe.
│
└─ 4 ACTIVITY    repo_commits / repo_commit_files / repo_pull_requests /
                 repo_contributors rows + weekly commit-history chunks.
                 Then rollup + synthesis (existing skip-gate).
```

Transfer classes (`technology_relationships`: `transferable` rows with
`transfer_class`, `transfer_tier full|partial`, `transfer_basis` text) are
consulted by the matcher and by `buildRetrievalPrefilter` term expansion -
query-time reads of write-time-curated edges. Seed classes: iac-declarative
(terraform, aws-cdk, cloudformation, pulumi, bicep), ci-pipelines,
container-orchestration, cloud-platform (partial), document-store,
secrets-managers, observability-stacks.

Concept detectors (deterministic, FP-gated like the DSA detectors): ci/cd,
observability, incident response, container orchestration, secrets
management, distributed systems, infrastructure as code, and process
automation, seeded from the 67-JD corpus frequency table; `skill_ontology` gains the
missing concepts + aliases ("ci/cd" = "ci-cd" = "ci/cd pipeline design").

## Repository consolidation (precondition, user-mandated)

All ingestion-system code moves under **`applications/ingestion/`** - one
directory, one deployable, one owner. Target layout (subfolder-per-concern,
mirroring the projects-domain convention, tests in `__tests__/`):

```text
applications/ingestion/src/
├── run-ingestion.ts            single entrypoint (stages 0-4)
├── run-rollup.ts + eval runners
├── acquisition/                GitHubAdapter, tarball fetch + safeExtract,
│                               commit/PR/contributor fetchers
├── facts/                      extractors (syft, github-sbom, treesitter,
│                               iac/*, prose), dsa-ai patterns, concept
│                               detectors, repo-signals glue, fact-sheet builder
├── knowledge/                  FileFilter, file-classifier, chunkers,
│                               IngestionPipeline (embed + upsert + probe glue)
├── narrative/                  ProfileExtractor, RetrievalProbe, synthesis
├── activity/                   CommitChunker + activity persistence glue
├── ontology/                   write-time canonicalisation glue over the
│                               shared OntologyResolver
└── persistence/                sync-state, profiles, evidence, fact-sheet writers
```

Moves in: `applications/shared/src/ingestion/**` (verified sole consumer is
this app), `applications/shared/src/rds/pipeline/IngestionPipeline.ts`
(verified sole consumer), all of `applications/tech-extractor/src/**`.

Stays in shared (multi-app consumers - verified): `RdsVectorStore` (+ read
path used by job-strategist), `retrieval/**`, `OntologyResolver` + ontology
repositories, `TitanEmbeddingProvider` (shared cost/lineage surface),
domain types. `projects/evidence/{repo-signals,evidence-topology}.ts` stay
in shared (grounding + projects consume them); the ingestion glue imports
them as today.

Mechanics follow the projects-domain reorg playbook: pure `git mv`,
resolution-based import rewrite, barrel updated, `tsc -b` all packages +
full jest as the gate. The tech-extractor app folder, Dockerfile, and deploy
workflow are deleted only at P2 (after parity), not during the move.

## Phases

| Phase | Deliverable | Gate |
| --- | --- | --- |
| **C0 Consolidation** | one-directory move described above; zero behaviour change | tsc -b all packages, full jest, image builds for ingestion + tech-extractor still green |
| **P0 Fact sheet + transfers (no pipeline surgery)** | `repo_facts` table + builder fed from EXISTING evidence tables; transfer-class seed rows; matcher + prefilter consume both | gap-rate eval over the 67-JD golden set: terraform/azure/gcp class converts to `partial(transferable)`; honest gaps preserved; UC1/UC2 answered from facts |
| **P1 Unified job** | tarball acquisition + facts pass folded into stages behind `UNIFIED_INGESTION=1`; inline chunk stamping; old post-hoc stamp retired | `technology_parity_runs`: old vs new evidence row parity per layer; chunk metadata diff on a full resync; cost/duration per sync at or under the current two-job sum |
| **P2 Retire + detectors** | tech-extractor Job/image/workflow deleted; concept detectors live; `concept_evidence` migration | concept-coverage eval (fraction of JD concept mentions resolving to cited evidence); detector FP gate under 5% (DSA discipline) |
| **P3 JD boundary** | jd-extractor lanes canonicalised on persist (raw strings kept for UI chips); `tech_skill_map` grown to full canonical coverage; unresolved terms feed the ontology gap sink | canonicalisation-rate eval; UI chips byte-identical for existing runs |

## Cost model

- One pod per sync instead of two; one tarball download instead of tarball +
  per-blob API fetches.
- LLM: exactly one profile call per repo sync (Haiku-class) + existing
  rollup synthesis (skip-gated). Zero per-chunk LLM. Concept/tech
  categorisation is deterministic.
- Embeddings: unchanged, content-hash gated (~$0.02/sync observed);
  ontology-resolution embeddings cached as today.
- Deletions repay: enricher code path, duplicate acquisition, post-hoc
  stamp UPDATE over the whole corpus each sync.

## Risks and rollback

- **Parity risk (P1):** evidence extracted from the tarball walk must match
  the API-fetch walk. Mitigation: `technology_parity_runs` side-by-side for
  every repo before cutover; flag-gated.
- **Consolidation risk (C0):** import-graph churn. Mitigation: pure moves,
  no renames of exports; same playbook as the projects reorg (PR #501).
- **Fact staleness:** `repo_facts` recomputed on every sync inside the same
  transaction as evidence writes; `fact_version` column allows schema
  evolution without backfill pain.
- Rollback per phase: C0 is a revert; P0 consumers behind a flag; P1 keeps
  the old two-job path until parity signs off; P2 deletes only after P1 has
  run clean in dev for a full sync cycle.
