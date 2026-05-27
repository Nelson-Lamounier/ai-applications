---
title: Re-ingest documents into the Bedrock Knowledge Base
type: runbook
tags: [operations, bedrock, knowledge-base, s3, pinecone, ingestion]
sources:
  - infra/lib/stacks/bedrock/kb-stack.ts
  - infra/lib/stacks/bedrock/data-stack.ts
created: 2026-05-27
updated: 2026-05-27
---

## When to run this

Trigger a Bedrock Knowledge Base data-source ingestion job when:

- You've added or updated documents in the `kb-docs/` prefix of the
  KB source bucket and want the change reflected in chatbot answers.
- You suspect the KB has drifted from the S3 contents (deleted docs
  still being cited; new docs never retrieved).
- The chunking strategy or embedding model changed and the entire
  corpus needs re-embedding into Pinecone.
- Bedrock surfaces a `FAILED` ingestion job in the console and you
  need to retry.

Do **not** run this for content changes outside `kb-docs/` — the
data source's `inclusionPrefixes: ['kb-docs/']` filter
([infra/lib/stacks/bedrock/kb-stack.ts:202](../../infra/lib/stacks/bedrock/kb-stack.ts#L202))
means content elsewhere in the bucket is ignored. Move it under
`kb-docs/` first.

## Prerequisites

- AWS CLI access in the account hosting the Bedrock KB
  (verify with `aws sts get-caller-identity`)
- IAM permissions:
  - `bedrock:StartIngestionJob`, `bedrock:GetIngestionJob`,
    `bedrock:ListIngestionJobs` on the KB
  - `s3:GetObject`, `s3:ListBucket` on the data bucket (to confirm
    contents before triggering)
- The KB id (resolved from SSM, see below) and the data-source id
  (visible in the Bedrock console under the KB's "Data sources" tab,
  or returned by `aws bedrock-agent list-data-sources`)
- The `${namePrefix}` for the environment you're operating against
  (e.g. `bedrock-development`)

## Procedure

### 1. Resolve the KB id and data bucket from SSM

The KB stack exports both at deploy time
([kb-stack.ts:206-225](../../infra/lib/stacks/bedrock/kb-stack.ts#L206-L225)):

```bash
NAME_PREFIX=bedrock-development

KB_ID=$(aws ssm get-parameter \
  --name "/${NAME_PREFIX}/knowledge-base-id" \
  --query 'Parameter.Value' --output text)

DATA_BUCKET_ARN=$(aws ssm get-parameter \
  --name "/${NAME_PREFIX}/data-bucket-arn" \
  --query 'Parameter.Value' --output text)

DATA_BUCKET=$(echo "$DATA_BUCKET_ARN" | sed 's|^arn:aws:s3:::||')

echo "KB: $KB_ID"
echo "Bucket: $DATA_BUCKET"
```

### 2. Confirm S3 contents match expectations

```bash
# Listing must contain exactly the documents you intend to ingest
aws s3 ls "s3://$DATA_BUCKET/kb-docs/" --recursive
```

The data source ignores anything outside `kb-docs/`. If a file you
expect to be ingested sits at the bucket root (or in another prefix),
move it under `kb-docs/` before triggering ingestion — re-running
the job afterwards will not retroactively pick it up otherwise.

### 3. Find the data-source id

```bash
DS_ID=$(aws bedrock-agent list-data-sources \
  --knowledge-base-id "$KB_ID" \
  --query 'dataSourceSummaries[?contains(name, `repo-docs`)] | [0].dataSourceId' \
  --output text)
echo "Data source: $DS_ID"
```

The data-source name pattern is `${namePrefix}-repo-docs`
([kb-stack.ts:201](../../infra/lib/stacks/bedrock/kb-stack.ts#L201)).

### 4. Trigger the ingestion job

```bash
JOB_ID=$(aws bedrock-agent start-ingestion-job \
  --knowledge-base-id "$KB_ID" \
  --data-source-id "$DS_ID" \
  --description "Manual re-ingest at $(date -u +%FT%TZ)" \
  --query 'ingestionJob.ingestionJobId' --output text)

echo "Job: $JOB_ID"
```

The job runs asynchronously. Typical duration for the portfolio's
documentation corpus (low MBs of markdown) is 30 s to 5 min,
depending on chunking depth and Bedrock-side load.

### 5. Watch the job to completion

```bash
while true; do
  STATUS=$(aws bedrock-agent get-ingestion-job \
    --knowledge-base-id "$KB_ID" \
    --data-source-id "$DS_ID" \
    --ingestion-job-id "$JOB_ID" \
    --query 'ingestionJob.status' --output text)
  echo "$(date +%T) status=$STATUS"
  case "$STATUS" in
    COMPLETE|FAILED) break ;;
  esac
  sleep 10
done
```

States observed during a healthy run: `STARTING` → `IN_PROGRESS` →
`COMPLETE`. Any `FAILED` exits the loop immediately.

### 6. Inspect the job statistics

```bash
aws bedrock-agent get-ingestion-job \
  --knowledge-base-id "$KB_ID" \
  --data-source-id "$DS_ID" \
  --ingestion-job-id "$JOB_ID" \
  --query 'ingestionJob.statistics'
```

Expected fields (Bedrock API):

| Field | Meaning |
| :- | :- |
| `numberOfDocumentsScanned` | Files seen under `kb-docs/` |
| `numberOfNewDocumentsIndexed` | Files newly added since the last job |
| `numberOfModifiedDocumentsIndexed` | Files updated since last job |
| `numberOfDocumentsDeleted` | Files removed from S3 since last job |
| `numberOfDocumentsFailed` | Files that errored during ingestion |

If `numberOfDocumentsFailed > 0`, drill into the job's `failureReasons`
field and the chosen document's CloudWatch logs (Bedrock surfaces a
`/aws/bedrock/knowledgebases/...` log group when ingestion logging is
enabled).

## Verification

### 1. Confirm Pinecone vector count rose

The KB stores embeddings in Pinecone
([kb-stack.ts:144-155](../../infra/lib/stacks/bedrock/kb-stack.ts#L144-L155)).
Open the Pinecone console for the configured index and compare the
vector count against the pre-job snapshot.

A complete reindex (e.g. after a chunking strategy change) will
rewrite all vectors — old vectors are typically replaced, not
duplicated, by the Bedrock-managed integration.

### 2. End-to-end query test

Run a query that *should* hit a newly-indexed document and verify
the chatbot's response cites it. From the chatbot Lambda (any
environment):

```bash
# Via the chatbot's API (if accessible)
curl -X POST "https://<api-endpoint>/<stage>/invoke" \
  -H "x-api-key: <key>" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "<question that should hit your new doc>"}'
```

Or invoke directly via SDK if you have agent access:

```bash
aws bedrock-agent-runtime invoke-agent \
  --agent-id "$AGENT_ID" \
  --agent-alias-id "$AGENT_ALIAS_ID" \
  --session-id "verify-$(date +%s)" \
  --input-text "<question>"
```

The response should include text from the new document and the
agent's citation field (if enabled) should reference its `sourceUri`.

### 3. Invalidate the semantic cache

Cached chatbot responses generated against the *previous* KB
revision can outlive the reindex. If the change should invalidate
those responses, rotate the `kbTag` constant on the calling side
(see
[docs/troubleshooting/semantic-cache-stale-responses.md](../troubleshooting/semantic-cache-stale-responses.md))
and let TTL clean up the old rows, or wipe them now:

```sql
DELETE FROM semantic_cache WHERE kb_tag = '<old-tag>';
```

## Rollback

The S3 bucket is the source of truth. Ingestion jobs are additive
or replace-in-place — they do not delete S3 objects. To roll back
a content change:

1. Restore the previous S3 object versions
   (the data bucket has versioning enabled — see
   [data-stack.ts](../../infra/lib/stacks/bedrock/data-stack.ts)):

```bash
# List versions for the affected key
aws s3api list-object-versions \
  --bucket "$DATA_BUCKET" \
  --prefix "kb-docs/<path>" \
  --query 'Versions[?IsLatest==`false`].[Key,VersionId]' --output table

# Restore by re-copying the prior version
aws s3api copy-object \
  --copy-source "${DATA_BUCKET}/kb-docs/<path>?versionId=<prior-id>" \
  --bucket "$DATA_BUCKET" \
  --key "kb-docs/<path>"
```

2. Re-trigger the ingestion job (step 4 above).

3. If the rollback was on the *agent* side (e.g. a Guardrail config
   change ingested as part of the same deployment), revert the CDK
   change and `cdk deploy` the Agent stack — the KB stack is
   independently lifecycled
   ([infra/lib/projects/bedrock/factory.ts](../../infra/lib/projects/bedrock/factory.ts))
   so an Agent rollback does not perturb the KB.

If the ingestion job is hung (`IN_PROGRESS` for far longer than
expected) **do not** start a second job in parallel — Bedrock will
queue it. Inspect the original job's logs to determine whether the
delay is genuine or stuck; if stuck, contact AWS Support, as the
ingestion-job lifecycle does not expose a `cancel-ingestion-job`
verb at time of writing.

<!--
Evidence trail (auto-generated):
- Source: infra/lib/stacks/bedrock/kb-stack.ts (lines 170-260 on 2026-05-27)
- Source: infra/lib/stacks/bedrock/data-stack.ts (versioning + KMS key on 2026-05-27)
- Cross-reference: docs/concepts/bedrock-rag-surface.md, docs/troubleshooting/semantic-cache-stale-responses.md
-->
