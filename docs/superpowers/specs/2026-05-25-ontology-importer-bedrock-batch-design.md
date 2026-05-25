# Ontology Importer — Bedrock Batch Inference Refactor (Design)

**Date:** 2026-05-25
**Status:** Approved (brainstorming) → ready for implementation plan
**Scope:** Refactor the `@bedrock/ontology-importer` Layer-4 LLM classifier from the Anthropic Message Batches API to **AWS Bedrock Batch Inference** (`CreateModelInvocationJob`), plus the rollout/validation criteria that gate decommissioning the `BedrockChunkEnricher`.

---

## Why

The Tier 2 ontology importer (merged: ai-applications #45/#46/#48, cdk-monitoring #161, kubernetes-bootstrap #88) shipped with the Anthropic Message Batches API for Layer-4 classification of the unresolved tail. That choice optimized the LLM layer in isolation and broke platform consistency:

1. **A new managed secret** — `ANTHROPIC_API_KEY` in Secrets Manager. Its ESO sync (`k8s-development/ontology-importer/secrets`) is the current blocker (`SecretSyncedError`); the import CronJob pod can't start without it.
2. **Split billing / broken cost tracking** — every other model call (the `BedrockChunkEnricher` being replaced, ingestion, the per-model Cost Explorer dashboards from the `bedrock-cost-explorer-per-model` work) flows through Bedrock. An Anthropic-direct call lands on a separate invoice the existing cost observability can't see.
3. **Inconsistency** — the platform is Bedrock-centric; this would be the lone outlier.

There is no capability gap: Bedrock runs Claude Haiku 4.5, supports tool-use (the Messages `tools`/`tool_choice` body in `modelInput`), and offers **Batch Inference** for the same ~50% async batch economics. Moving to Bedrock removes the secret (Pod Identity IAM, like `ingestion`), unifies cost tracking, and matches the platform.

**Baseline to beat:** the last parity run on `kubernetes-bootstrap` (96-tech ontology) was recall **0.128** (`l1=11, llm_resolvable=78, ∩=10`). The ontology is still 96 techs / 211 aliases / 0 auto-imported — the importer has not run.

---

## Architecture

`@bedrock/ontology-importer` keeps its two-CronJob shape; only the Layer-4 backend changes. Per monthly run:

1. **`run-import`** iterates `ALL_SOURCES`, runs the Plan-1 `OntologyImporter` (deterministic Layers 1-3 insert into `technology_ontology`/`technology_aliases` as they go), then **pools every source's `unresolved` entries into one batch per run**. It writes one input JSONL to S3, calls `CreateModelInvocationJob`, and records the job ARN on a single `ontology_import_runs` row with `status='partial'`, `llm_batch_id=<jobArn>`.
2. **`run-llm-batch-followup`** (every 30 min) finds `partial` runs with a job ARN, calls `GetModelInvocationJob`; when the job reaches `Completed` it reads the output JSONL from S3 and routes each result — `yes`+category → ontology insert + alias + `upsertSeen`; `no` → `ontology_skipped_imports`; `maybe`/null → `ontology_review_queue` — then finishes the run `success`.

The pod authenticates to Bedrock + S3 via **EKS Pod Identity** (no API key), mirroring `ingestion`.

Batch granularity changes from **per-source** (old Anthropic design) to **one pooled batch per run** — required because Bedrock enforces a *minimum records per batch inference job* quota, which a single small source could not meet.

---

## Components (ai-applications)

### `BedrockBatchClassifier` (replaces `LlmBatchClassifier`)
`applications/ontology-importer/src/categorization/`. Approach A (direct replacement) — preserve the existing pure-function seams and the `submit`/`retrieve`/`results` shell shape so the entrypoints and unit tests change minimally.

**Pure (unit-tested):**
- `buildJsonlRecords(entries: RawImportEntry[], ecosystem: string): BatchRecord[]` — each `{ recordId, modelInput }`. `recordId` = sanitized `${ecosystem}:${source_identifier}` (≤ 64 chars, Bedrock-legal record-id charset). `modelInput` = the Anthropic Messages body on Bedrock: `{ anthropic_version: "bedrock-2023-05-31", max_tokens: 256, system: <classifier system text>, tools: [classify_package], tool_choice: {type:"tool", name:"classify_package"}, messages: [{role:"user", content:<package summary>}] }`. (Carries over the existing system prompt, `classify_package` tool schema with the 30-category enum + null, and the package-summary message from `LlmBatchClassifier`. **No `cache_control`** — prompt caching is a runtime feature, unavailable in batch.)
- `parseModelOutput(record: { recordId: string; modelOutput?: {...} }): { recordId, decision, category, reasoning }` — find the `tool_use` block named `classify_package` in `modelOutput.content`; default `{decision:'maybe', category:null}` when absent. (Same logic as today's `parseBatchResult`, reading `modelOutput` instead of a Message.)

**Shell (mocked in tests):**
- `submit(records): Promise<string>` — write the records as one `.jsonl` to `s3://<bucket>/<prefix>/input/<runId>.jsonl`, call `CreateModelInvocationJob` (`modelId`, `roleArn=<BEDROCK_BATCH_ROLE_ARN>`, `inputDataConfig` → input prefix, `outputDataConfig` → `s3://<bucket>/<prefix>/output/<runId>/`), return the job ARN.
- `retrieve(jobArn): Promise<{ status: string }>` — `GetModelInvocationJob`; status ∈ `Submitted|InProgress|Completed|Failed|Stopped|...`.
- `readResults(jobArn): AsyncIterable<record>` — locate and stream the output `*.jsonl.out` under the job's output prefix from S3, yielding parsed `{recordId, modelOutput}` rows.

**Deps:** add `@aws-sdk/client-bedrock` (control plane: Create/Get/StopModelInvocationJob) + `@aws-sdk/client-s3`; remove `@anthropic-ai/sdk`.

### `env.ts`
Drop `ANTHROPIC_API_KEY`. Add `BEDROCK_MODEL_ID` (Haiku 4.5 batch-eligible model id / eu inference profile), `BATCH_S3_BUCKET`, `BATCH_S3_PREFIX` (default `batch`), `BEDROCK_BATCH_ROLE_ARN`, `AWS_REGION` (default `eu-west-1`), `MIN_BATCH_RECORDS` (default `100` — the Bedrock *minimum records per batch inference job* quota; configurable because the quota is account/region-specific and can be raised). Keep `PG_*`, `TRIGGERED_BY`, `DEACTIVATION_THRESHOLD`, `SOURCES`.

### `run-import.ts`
Per-source `ontology_import_runs` rows still track the deterministic import exactly as today (each source `begin`→`finish('success'|'failed')` with `entries_*` counts and **no** `llm_batch_id`). The LLM tail is then pooled: collect `unresolved` across all sources into one array and, if `unresolved.length >= MIN_BATCH_RECORDS`, `submit` one batch and write **one additional** run row via `begin(source='pooled_llm_batch', triggeredBy)` then immediately set it `status='partial'` + `llm_batch_id=<jobArn>` (a small repo helper `markBatchSubmitted(runId, jobArn)` or reuse `finish` with a partial status). Else (sub-minimum) → insert all unresolved into `ontology_review_queue` (`reason='llm_maybe'`) and write no batch row. This keeps the per-source rows clean and gives the follow-up exactly one row to poll per run (`status='partial' AND llm_batch_id IS NOT NULL`).

### `run-llm-batch-followup.ts`
`findPendingBatches()` → for each, `retrieve(jobArn)`; `Completed` → `readResults` → `parseModelOutput` → route (split `recordId` on the **first** colon so maven `g:a` identifiers survive) → `finish('success')`; `Failed`/`Stopped` → `finish('failed')` (unresolved carry to next run); otherwise leave `partial`.

---

## Infra — cdk-monitoring (base `main`)

1. **S3 bucket** `ontology-importer-batch-{env}` in the shared-vpc stack: SSE (S3-managed), block-public, lifecycle rule expiring objects after **14 days** (input/output JSONL is transient). SSM param `/shared/ontology-importer/{env}/batch-bucket`.
2. **Bedrock batch service role** — trust policy `bedrock.amazonaws.com`; permissions: `s3:GetObject`/`ListBucket` on the input prefix, `s3:PutObject` on the output prefix of the batch bucket. (Bedrock assumes this role during the job to read inputs and write outputs.) SSM param `/shared/ontology-importer/{env}/batch-role-arn`.
3. **Pod Identity** — add a `purpose: 'ontology-importer'` case in `infra/lib/stacks/kubernetes/eks-pod-identity-stack.ts`:
   - Role policy: `bedrock:CreateModelInvocationJob`, `bedrock:GetModelInvocationJob`, `bedrock:StopModelInvocationJob`, `bedrock:InvokeModel` (on `arn:aws:bedrock:*::foundation-model/*` + `inference-profile/*`, mirroring the `ingestion` case); `s3:GetObject`/`PutObject`/`DeleteObject`/`ListBucket` on the batch bucket; `iam:PassRole` on the Bedrock batch service role.
   - `CfnPodIdentityAssociation`: cluster `k8s-eks-{env}`, namespace `ontology-importer`, serviceAccount `ontology-importer-sa`.

---

## Infra — kubernetes-bootstrap (base `main`)

1. **Delete** `charts/ontology-importer/external-secrets/ontology-importer-secrets.yaml` and the `ontology-importer-secrets-eks-development` ArgoCD Application (no Anthropic key). Keep `platform-rds-credentials` ESO.
2. **CronJob env** (both `import` + `followup`): drop the `ontology-importer-secrets` `envFrom`; add `BEDROCK_MODEL_ID`, `BATCH_S3_BUCKET`, `BATCH_S3_PREFIX`, `BEDROCK_BATCH_ROLE_ARN`, `AWS_REGION` from `values.yaml` (dev values seeded from the CDK SSM params).
3. **ServiceAccount** unchanged — Pod Identity binds by namespace + SA name (no annotation needed, unlike IRSA); `ontology-importer-sa` already exists.

---

## Data flow

```
(monthly) run-import:
  ALL_SOURCES → OntologyImporter (L1-3 → technology_ontology/aliases)
             → pool unresolved across sources
             → if >= MIN_BATCH_RECORDS:
                   write s3://bucket/prefix/input/<runId>.jsonl
                   CreateModelInvocationJob(model, roleArn, in, out)
                   ontology_import_runs row: status=partial, llm_batch_id=jobArn
                else: ontology_review_queue (reason=llm_maybe); status=success

(30-min) run-llm-batch-followup:
  findPendingBatches() → GetModelInvocationJob(jobArn)
     Completed → read s3://bucket/prefix/output/<runId>/*.jsonl.out
               → parseModelOutput → route yes→ontology / no→skipped / maybe→review_queue
               → finish(run, success)
     Failed    → finish(run, failed)   (unresolved re-collected next run)
```

---

## Rollout & validation

1. **Deploy** in order: cdk-monitoring (S3 bucket + batch role + Pod Identity + SSM) → ai-applications image (CI builds, no Anthropic secret) → kubernetes-bootstrap chart (drops the secret ESO, adds Bedrock env). ArgoCD syncs; the `ontology-importer-secrets` app/ESO disappears.
2. **Trigger** the import manually: `kubectl create job -n ontology-importer --from=cronjob/ontology-importer-import manual-run-1`.
3. **Verify growth:** `technology_ontology` `auto_imported` count goes from 0 to thousands; an `ontology_import_runs` row has `status=partial` + a job ARN.
4. **Follow-up** routes results once the Bedrock job completes (`auto_imported`/`skipped`/`review_queue` populated; run `success`).
5. **Re-measure parity:** re-run tech-extract on `Nelson-Lamounier/kubernetes-bootstrap` (infra) and a `tucaken-app` (app, syft-heavy) repo → new `technology_parity_runs` rows.
6. **Compare** `recall` to the **0.128** baseline.

**Decommission gate (judgment + target):** aim for `recall ≥ 0.85` on **both** infra and app repos. Re-measure, then review the per-repo `llm_only_examples` (techs the enricher found that L1 missed) and `l1_only_examples`. Decommission the `BedrockChunkEnricher` **only if** the residual gap is dominated by noise or genuinely un-extractable *deployed* infra tech (e.g. Helm/ArgoCD-deployed prometheus/grafana, CDK-declared lambda/dynamodb not present as source dependencies). If real, source-present tech is still missed, grow the ontology / add detectors and re-measure before decommissioning. Decommission = remove the enricher invocation from the ingestion path and retire the `document_embeddings.technologies` enrichment writes (separate follow-up PR, out of scope for this build).

---

## Error handling

- **Batch job `Failed`/`Stopped`** → run marked `failed`; pooled unresolved are not queued, so they are re-collected and re-batched next run.
- **Sub-minimum tail** (`< MIN_BATCH_RECORDS`) → routed to `ontology_review_queue` (`reason='llm_maybe'`); no batch submitted.
- **Per-record output parse error** → skip that record + log; never fail the whole follow-up.
- **Idempotency** (unchanged): run-keyed; `insertAutoImported` is insert-or-get-id; aliases `ON CONFLICT (alias) DO NOTHING`; `upsertSeen` on the per-source PK. Re-running a completed batch's follow-up is a no-op (all inserts conflict-safe).

---

## Testing

- **Pure functions** unit-tested with fixtures: `buildJsonlRecords` (one record/entry, correct `recordId`, `modelInput` = Bedrock Messages body with the tool, no `cache_control`); `parseModelOutput` (extracts `classify_package` input; defaults to maybe/null without a tool_use).
- **SDK shell** (`@aws-sdk/client-bedrock` + S3) mocked — no live AWS in tests.
- **In-process integration smoke** (carried over): `FakeSource` → `OntologyImporter` (in-memory ports) → mocked classifier → assert routing to ontology/skipped/review-queue buckets, plus the sub-minimum→review-queue branch.
- **cdk** unit tests: the batch bucket exists (name + lifecycle), the batch service role (trust + S3), the `ontology-importer` Pod Identity role+association + the SSM params — mirroring the existing ECR/vpc-stack test style.

---

## Out of scope

- The actual decommission of `BedrockChunkEnricher` (separate PR, gated on the parity re-measurement above).
- Live BigQuery PyPI top-list refresh (`loadPypiTop.ts`) — still refresh-time only; the importer runs on the committed seed.
- Any change to the tech-extractor / parity reporter itself — re-measurement reuses the existing pipeline.
