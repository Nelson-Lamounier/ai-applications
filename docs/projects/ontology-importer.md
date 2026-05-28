---
title: ontology-importer
type: project
tags: [kubernetes, postgres, bedrock-batch, ontology, classification, multi-source]
sources:
  - applications/ontology-importer/
  - .github/workflows/deploy-ontology-importer.yml
created: 2026-05-27
updated: 2026-05-27
---

## What it does

The `ontology-importer` is a Kubernetes Job that periodically
imports new technology entries from external package registries
(npm, PyPI, crates.io, Maven Central) and cloud-provider APIs (AWS
botocore, Azure REST specs, GCP service usage) into the platform's
`technology_ontology` table. Bedrock Batch — not real-time
Converse — runs the LLM-aided categorisation step at ~half the
per-token cost of synchronous invocation.

Three triggers
([applications/ontology-importer/src/env.ts:5-11](../../applications/ontology-importer/src/env.ts#L5-L11)):

- **`cronjob`** — scheduled refresh (default)
- **`manual`** — operator-initiated full re-run
- **`backfill`** — one-off run against a subset of sources

The pipeline also runs the
[ProseSafeTagger](../concepts/prose-safe-alias-gating.md) over
newly-imported aliases so the
[tech-extractor](tech-extractor.md)'s prose scanners can pick them
up.

## Architecture

```mermaid
flowchart TD
    Trigger[CronJob /<br/>manual / backfill] --> Env[parseEnv]
    Env --> Pool["new Pool(env.pg)"]
    Env --> Sources[ALL_SOURCES<br/>npm, PyPI, crates, Maven,<br/>AWS, Azure, GCP]
    Sources --> Fetch[Source.fetch]
    Fetch --> Importer[OntologyImporter]
    Importer --> Pool
    Importer --> Pooled[PooledItem[]]
    Pooled --> Build[buildJsonlRecords]
    Build --> S3[(S3 batch bucket)]
    S3 --> Batch[BedrockBatchClassifier]
    Batch --> Bedrock[Bedrock Batch<br/>Claude Haiku 4.5]
    Bedrock --> Categorize[Categorizer]
    Categorize --> Write[OntologyWriteRepository]
    Write --> Aurora[(technology_ontology<br/>+ technology_aliases)]
    Importer --> Deactivate[DeactivationDetector]
    Deactivate --> Aurora
    Importer --> Review[OntologyReviewQueueRepository]
    Importer --> Summary[ImportRunSummary]
    Summary --> Aurora2[(technology_import_runs)]
```

The flow is **two-pass**: source-fetched entries that the
deterministic `Categorizer` cannot classify are pooled, written to
S3 as JSONL, and submitted to Bedrock Batch. The batch result is
polled and merged back. Items the batch cannot classify confidently
land on the `OntologyReviewQueueRepository` for human review.

## Runtime contract

### Required environment variables

([applications/ontology-importer/src/env.ts:23-58](../../applications/ontology-importer/src/env.ts#L23-L58)):

| Variable | Default | Purpose |
| :- | :- | :- |
| `PG_HOST` / `PG_PORT` / `PG_DATABASE` / `PG_USER` / `PG_PASSWORD` | — (required) | Aurora connection |
| `AWS_REGION` | `eu-west-1` | Bedrock + S3 region |
| `BEDROCK_MODEL_ID` | `anthropic.claude-haiku-4-5-20251001-v1:0` | Batch classifier model |
| `BATCH_S3_BUCKET` | — (required) | S3 bucket for JSONL batch inputs |
| `BATCH_S3_PREFIX` | `batch` | Key prefix within the bucket |
| `BEDROCK_BATCH_ROLE_ARN` | — (required) | IAM role Bedrock assumes to read/write the S3 inputs |
| `MIN_BATCH_RECORDS` | `100` | Threshold below which we run synchronous Converse instead |
| `TRIGGERED_BY` | `cronjob` | One of `cronjob` / `manual` / `backfill` |
| `DEACTIVATION_THRESHOLD` | `3` | Consecutive missing-from-source runs before deactivation |
| `SOURCES` | unset | Optional comma-separated subset (`npm,pypi,…`) — defaults to all |

### Inputs

- **External package registries + cloud APIs.** Each `Source`
  implementation handles its own auth, pagination, rate limiting.
- **Aurora reference data.** Existing `technology_ontology`
  rows for diff + dedupe; `technology_aliases` for prose-safe
  tagging.

### Outputs

- **`technology_ontology`** — new rows + updates to existing rows.
- **`technology_aliases`** — alias rows (with `prose_safe` set by
  the post-pass `ProseSafeTagger`).
- **`technology_import_runs`** — one row per Job invocation with
  `ImportRunSummary` counts.
- **`technology_review_queue`** — items the LLM could not confidently
  classify; operator review queue.
- **Prom metrics** via `buildMetrics(obs.registry)` then pushed to
  Pushgateway.

## Repository layout

```text
applications/ontology-importer/
├── src/
│   ├── run-import.ts                   ← K8s Job entrypoint
│   ├── run-llm-batch-followup.ts       ← Bedrock Batch result-poll Job
│   ├── run-tag-aliases-prose-safe.ts   ← ProseSafeTagger Job
│   ├── env.ts                          ← env-var contract
│   ├── sources/
│   │   ├── Source.ts                   ← interface
│   │   ├── NpmRegistrySource.ts
│   │   ├── PypiBigQuerySource.ts
│   │   ├── CratesIoSource.ts
│   │   ├── MavenCentralSource.ts
│   │   ├── AwsBotocoreSource.ts
│   │   ├── AzureRestSpecsSource.ts
│   │   ├── GcpServiceUsageSource.ts
│   │   ├── FakeSource.ts               ← test double
│   │   └── data/                       ← embedded reference data
│   ├── categorization/
│   │   ├── Categorizer.ts              ← deterministic-first pass
│   │   ├── BedrockBatchClassifier.ts   ← async LLM fallback
│   │   ├── ProseSafeTagger.ts          ← post-pass alias gating
│   │   ├── overrides.json              ← curated category overrides
│   │   └── patterns.json               ← deterministic patterns
│   ├── aliases/
│   │   ├── AliasGenerator.ts
│   │   └── aliasFilters.ts
│   ├── importer/
│   │   ├── OntologyImporter.ts         ← top-level orchestrator
│   │   ├── DeactivationDetector.ts
│   │   └── ImportRunSummary.ts
│   └── metrics.ts
├── Dockerfile
├── package.json
└── tsconfig.json
```

## How to run locally

```bash
yarn workspace @bedrock/ontology-importer build
yarn workspace @bedrock/ontology-importer test

# Subset run against the FakeSource (no external API calls)
TRIGGERED_BY=manual SOURCES=fake \
  BATCH_S3_BUCKET=test-bucket BEDROCK_BATCH_ROLE_ARN=arn:aws:iam::... \
  PG_HOST=... PG_PORT=5432 PG_DATABASE=... PG_USER=... PG_PASSWORD=... \
  node applications/ontology-importer/dist/run-import.js
```

The `FakeSource` is provided specifically to test the orchestrator
without hitting any external API
([applications/ontology-importer/src/sources/FakeSource.ts](../../applications/ontology-importer/src/sources/FakeSource.ts)).

## Deploy

CI/CD via [deploy-ontology-importer.yml](../../.github/workflows/deploy-ontology-importer.yml):

- Triggers on push to `develop` against
  `applications/ontology-importer/**` or `applications/shared/**`
- Calls reusable `_build-push-image.yml`:
  - `image-ssm-path: /k8s/development/job-images/ontology-importer`
- Posts a Loki deploy marker

The K8s CronJob spec lives in the sibling cluster repo; this
service's deploy only refreshes the image URI.

## Related projects

| Project | Relationship |
| :- | :- |
| [tech-extractor](tech-extractor.md) | Reads the ontology this service writes; depends on `prose_safe = true` aliases from `ProseSafeTagger` |
| [ingestion](ingestion.md) | Consumes `technology_ontology` indirectly via the per-repo profile extractor |
| `kubernetes-platform` (sibling repo) | Hosts the CronJob schedule + IAM role for Bedrock Batch |

## Deeper detail

- [docs/concepts/prose-safe-alias-gating.md](../concepts/prose-safe-alias-gating.md)
  — the post-pass `ProseSafeTagger` job + the 15-example Bedrock
  Converse calibration prompt
- [docs/concepts/tech-extractor-architecture.md](../concepts/tech-extractor-architecture.md)
  — the consumer of the prose-safe alias set
- [docs/concepts/ontology-resolver.md](../concepts/ontology-resolver.md)
  — how `Rds*Repository` consumers resolve `raw_name` → canonical
  `technology_id`
- [docs/concepts/bedrock-cost-tracking.md](../concepts/bedrock-cost-tracking.md)
  — the per-pipeline cost ledger; Bedrock Batch invocations book
  `prompt_invocations` rows
- (planned) docs/decisions/0004-bedrock-batch-over-realtime.md —
  the ADR formalising the cost rationale for Batch on this path

<!--
Evidence trail (auto-generated):
- Source: applications/ontology-importer/src/run-import.ts (lines 1-40 on 2026-05-27)
- Source: applications/ontology-importer/src/env.ts (read in full on 2026-05-27)
- Source: applications/ontology-importer/src/sources/ (directory listing on 2026-05-27)
- Source: applications/ontology-importer/src/categorization/ (directory listing on 2026-05-27)
- Source: applications/ontology-importer/src/importer/ (directory listing on 2026-05-27)
- Source: .github/workflows/deploy-ontology-importer.yml (referenced on 2026-05-27)
-->
