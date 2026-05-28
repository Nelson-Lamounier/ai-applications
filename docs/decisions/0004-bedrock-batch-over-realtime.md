---
title: Bedrock Batch over real-time Converse for ontology classification
type: decision
tags: [bedrock, batch, finops, ontology, classification, latency-tradeoff]
sources:
  - applications/ontology-importer/src/categorization/BedrockBatchClassifier.ts
  - applications/ontology-importer/src/run-import.ts
created: 2026-05-27
updated: 2026-05-27
---

## Status

Accepted — implemented as-deployed. The
[`ontology-importer`](../projects/ontology-importer.md) classifies
new packages through the Bedrock Batch API via
[`BedrockBatchClassifier`](../../applications/ontology-importer/src/categorization/BedrockBatchClassifier.ts).
A short-circuit threshold (`MIN_BATCH_RECORDS=100`) falls back to
synchronous Converse when there's not enough work to justify
Batch's overhead
([applications/ontology-importer/src/env.ts:55](../../applications/ontology-importer/src/env.ts#L55)).

## Context

The ontology-importer runs on a CronJob schedule (and on-demand for
manual / backfill runs). Each run pulls **new entries from 7
external sources** — npm, PyPI, crates.io, Maven Central, AWS
botocore, Azure REST specs, GCP service usage. Many entries are
classified deterministically by the `Categorizer`'s pattern table
[(applications/ontology-importer/src/categorization/Categorizer.ts](../../applications/ontology-importer/src/categorization/Categorizer.ts)),
but a residual — typically **hundreds to low-thousands per run** —
needs LLM-aided categorisation.

Two Bedrock paths existed for this work:

1. **Synchronous Converse** — issue a `bedrock:Converse` request
   per item. Latency: ~1-3s per call. Cost: full per-token pricing.
2. **Bedrock Batch (`CreateModelInvocationJob`)** — submit a JSONL
   file of records to S3, Bedrock processes them asynchronously,
   results land in another S3 bucket. Latency: minutes to hours
   for the whole batch. Cost: ~50% of synchronous per-token
   pricing (AWS-published rate at time of decision).

For a single user-facing chatbot the latency difference is
disqualifying. For an **offline CronJob** producing reference data
that takes effect on the next sync, the latency cost is tolerable
and the savings compound across every scheduled run.

## Decision

**Use Bedrock Batch as the default classification path** for the
ontology-importer. Short-circuit to synchronous Converse only when
fewer than `MIN_BATCH_RECORDS` (default 100) records are queued —
below that threshold, the Batch job's submission + scheduling
overhead would dominate the cost saving.

Concretely
([applications/ontology-importer/src/categorization/BedrockBatchClassifier.ts:49-85](../../applications/ontology-importer/src/categorization/BedrockBatchClassifier.ts#L49-L85)):

- `buildJsonlRecords` pools all pending items across all 7 sources
  into a single batch.
- Each record carries the same `classify_package` tool definition
  with the [ProseSafeTagger](../concepts/prose-safe-alias-gating.md)-style
  forced tool-use, 30-category enum, and 200-char reasoning cap.
- `BedrockBatchClassifier.submit` writes the JSONL to the
  `BATCH_S3_BUCKET` and creates the model-invocation job, returning
  the job ARN.
- A separate
  [`run-llm-batch-followup.ts`](../../applications/ontology-importer/src/run-llm-batch-followup.ts)
  Job polls for completion, reads results back via S3, and merges
  them into the importer.

The model is `anthropic.claude-haiku-4-5-20251001-v1:0`
([BedrockBatchClassifier.ts:7](../../applications/ontology-importer/src/categorization/BedrockBatchClassifier.ts#L7))
— Haiku has the right cost/quality profile for binary-with-category
classification.

## Consequences

**Enabled:**

- **~50% per-token spend reduction on the LLM portion of every
  import run.** The deterministic `Categorizer` handles the bulk
  upfront; Bedrock Batch handles the residual at the discount rate.
- **Decoupled scheduling.** The submitter Job returns once it has
  a job ARN. The follow-up Job runs hours later and merges the
  result. The two halves can fail independently and be retried
  independently.
- **JSONL on S3 is the durable artefact.** A batch result is
  auditable after the fact — the operator can read the same JSONL
  the model saw and the JSONL the model produced. Synchronous
  Converse responses are only in the prompt_invocations row's
  cost columns, not the full IO.
- **Same tool-use schema as ProseSafeTagger + the synthesizer
  family.** The pattern from
  [zod-tool-use](../patterns/zod-tool-use.md) carries over — Bedrock
  Batch records use the same `tool_choice` + `tool` shape; the
  result parser
  ([BedrockBatchClassifier.ts:87-110](../../applications/ontology-importer/src/categorization/BedrockBatchClassifier.ts#L87-L110))
  is a per-record version of the synchronous parser.

**Prevented:**

- **Per-item latency on each classification.** A real-time chatbot
  surface couldn't use this path. The ontology-importer is not a
  chatbot surface.
- **Per-item cost accounting in `prompt_invocations`.** Batch jobs
  book one aggregate cost record per job, not per item. The cost
  ledger reconciles at the job level rather than the per-record
  level.

**New problems / accepted residual:**

- **Two K8s Jobs for one logical workflow.** A submit Job and a
  follow-up Job. The orchestrator (admin-api / CronJob spec)
  manages both. The submit Job's success doesn't mean
  classification is complete — only that submission succeeded.
- **Enum-hint advisory only.** The `category` field's enum hint
  is **advisory to the LLM** — Claude can emit values outside the
  30-element set despite the JSON Schema `enum`. The parser coerces
  out-of-set categories to `null` so the downstream router treats
  them as `maybe` rather than crashing the DB constraint
  ([BedrockBatchClassifier.ts:93-100](../../applications/ontology-importer/src/categorization/BedrockBatchClassifier.ts#L93-L100)).
  This was discovered empirically — Batch's enum enforcement isn't
  any stricter than synchronous Converse's.
- **JSONL records are immutable once submitted.** If a record's
  prompt is wrong, the only recourse is to cancel the job, fix the
  builder, resubmit. `StopModelInvocationJobCommand` exists for
  this; the
  [BedrockBatchClassifier.stop](../../applications/ontology-importer/src/categorization/BedrockBatchClassifier.ts#L149)
  method wraps it.

## Alternatives considered

### Synchronous Converse for everything

The dominant default. Rejected:

- ~2× more expensive per token.
- Per-item latency × thousands of items = the Job runs for an hour
  on a fast path. The CronJob's window is finite.
- No batch-level auditability artefact.

The accepted residual of Synchronous Converse — per-item cost
attribution and immediate result availability — doesn't matter for
this workflow (the classification is reference data, not a
user-facing response).

### Async Converse with a custom worker pool

Spin up N parallel Lambdas that each call Converse for a slice of
records. Achieves the parallelism benefit without the latency cost
of Batch. Rejected:

- Reproduces what Bedrock Batch already provides (concurrent
  scheduling), without the cost discount.
- Adds operational complexity (the worker pool, the queue, the
  result reconciliation) that Batch handles natively.
- Per-record `prompt_invocations` records would still be the
  cost-tracking model — which sounds nice but bloats the audit
  table without any operational benefit (per-record cost rows for
  reference-data ingestion are noise).

### Deterministic-only (skip LLM entirely)

The route taken by [ADR 0001](0001-deterministic-over-llm-extraction.md)
for the **technologies** field of the tech-extractor's output.
Considered for the ontology-importer; rejected because:

- The package-classification problem has **no structural signal**
  the way technology-name extraction does. The classifier has to
  read a free-text package description and decide the category.
- The deterministic `Categorizer`'s pattern table already handles
  every easily-classifiable case. The residual that needs LLM help
  is **definitionally the hard case**.
- Empirical results: the deterministic-only path produces ~30%
  unclassified entries that land in
  [`technology_review_queue`](../projects/ontology-importer.md#outputs).
  Adding the LLM pass cuts the review queue to manageable size.

## Implementation in this codebase

| Concern | Location |
| :- | :- |
| Batch record builder | [BedrockBatchClassifier.ts:49-85](../../applications/ontology-importer/src/categorization/BedrockBatchClassifier.ts#L49-L85) |
| Job submit + status + stop | [BedrockBatchClassifier.ts:129-152](../../applications/ontology-importer/src/categorization/BedrockBatchClassifier.ts#L129-L152) |
| Result reader (S3 streaming) | [BedrockBatchClassifier.ts:154+](../../applications/ontology-importer/src/categorization/BedrockBatchClassifier.ts#L154) |
| Submitter K8s Job entrypoint | [applications/ontology-importer/src/run-import.ts](../../applications/ontology-importer/src/run-import.ts) |
| Follow-up K8s Job entrypoint | [applications/ontology-importer/src/run-llm-batch-followup.ts](../../applications/ontology-importer/src/run-llm-batch-followup.ts) |
| Short-circuit threshold | `MIN_BATCH_RECORDS=100` ([env.ts:55](../../applications/ontology-importer/src/env.ts#L55)) |

## How this relates to the other ADRs

- [ADR 0001](0001-deterministic-over-llm-extraction.md) — the
  **deterministic-first** principle. The Categorizer runs ahead of
  Batch; Batch handles only what the deterministic path cannot.
- [ADR 0003](0003-mcp-native-vs-action-groups.md) — Bedrock Batch
  is an **alternative integration** to Bedrock Agent action groups.
  Same Bedrock account, different mechanism, different applicability
  trade.

<!--
Evidence trail (auto-generated):
- Source: applications/ontology-importer/src/categorization/BedrockBatchClassifier.ts (lines 1-110, 129-152 on 2026-05-27)
- Source: applications/ontology-importer/src/env.ts (lines 49-55 on 2026-05-27)
- Source: applications/ontology-importer/src/run-import.ts (read on 2026-05-27)
- Cross-references: docs/projects/ontology-importer.md, docs/concepts/prose-safe-alias-gating.md, docs/patterns/zod-tool-use.md
-->
