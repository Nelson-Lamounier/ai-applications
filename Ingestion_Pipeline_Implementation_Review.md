# Ingestion Pipeline — Implementation Review

> **Scope**: GitHub repository → RDS PostgreSQL + pgvector vector store  
> **Date**: April 2026  
> **Branch**: `develop`

---

## 1. Problem Statement

The portfolio's Bedrock Agent answers questions about Nelson's work by querying a Pinecone-backed Knowledge Base that Bedrock manages externally. This creates three hard constraints:

1. **No semantic precision control** — Bedrock's managed KB performs vector search internally; there is no way to tune chunking strategy, overlap, embedding context, or retrieval fusion.
2. **No incremental sync** — the only update primitive is a full data source re-sync, which re-embeds every document on every deploy.
3. **Vendor lock-in on vector storage** — Pinecone free tier has a single namespace and a fixed 1536-dim model requirement.

The ingestion pipeline solves all three: it owns the full chain from raw file bytes to stored vector, with complete control over chunking, context enrichment, deduplication, hybrid retrieval, and stale-chunk garbage collection.

---

## 2. What Was Implemented

### 2.1 Six Functional Gaps Closed

| Gap | Priority | What was missing | What was built |
|-----|----------|------------------|----------------|
| **9** | P1 | No overlap between chunks | `overlapChars` in `MarkdownChunker` |
| **2** | P1 | No structural context for embeddings | Repository preamble in `IngestionPipeline.buildEmbedText()` |
| **6** | P1 | No garbage collection of stale chunks | `pruneDeletedFiles()` in `IVectorStore` + `RdsVectorStore` |
| **3** | P1 | Vector-only retrieval | Hybrid BM25 + vector via RRF in `RdsVectorStore.queryHybrid()` |
| **3** | P1 | No FTS index | `content_tsv TSVECTOR GENERATED ALWAYS AS` + GIN index in DDL |
| **10** | P0 | No deployed ingestion workload | 3-Lambda CDK stack + S3 staging bucket |

### 2.2 Infrastructure Stacks

| CDK Stack | Resource | Purpose |
|-----------|----------|---------|
| `Bedrock-Aurora-{env}` (file: `rds-pgvector-stack.ts`) | RDS PostgreSQL 16.3 | Vector store — `document_embeddings` + `repo_sync_state` tables |
| `Bedrock-Aurora-{env}` | VPC (isolated subnets only, `natGateways: 0`) | Network isolation without NAT Gateway cost |
| `Bedrock-Aurora-{env}` | Secrets Manager Interface endpoint | Credentials for isolated-subnet Lambdas |
| `Bedrock-Aurora-{env}` | Bedrock Runtime Interface endpoint | `InvokeModel` (Titan Embed) without internet |
| `Bedrock-Aurora-{env}` | S3 Gateway endpoint (free) | Worker reads S3 bundle without NAT |
| `Bedrock-Aurora-{env}` | Bootstrap Lambda (custom resource) | Schema DDL on CloudFormation CREATE/UPDATE |
| `Bedrock-Ingestion-{env}` | Trigger Lambda | Validates request, returns 202, fires Fetcher async |
| `Bedrock-Ingestion-{env}` | Fetcher Lambda | Fetches GitHub files, uploads S3 bundle, fires Worker async |
| `Bedrock-Ingestion-{env}` | Worker Lambda (VPC isolated) | Reads S3 bundle, runs pipeline, stores vectors in RDS |
| `Bedrock-Ingestion-{env}` | S3 staging bucket | Ephemeral GitHub file bundle (1-day lifecycle) |
| `Bedrock-Ingestion-{env}` | GitHub token Secrets Manager secret | PAT for GitHub API — placeholder updated post-deploy |
| `Bedrock-Ingestion-{env}` | API Gateway REST API | `POST /ingestion/trigger` |

> **Note on stack naming**: The CDK stack logical ID is `Bedrock-Aurora-{env}` (preserved to avoid CloudFormation recreation). The file and class are named `rds-pgvector-stack.ts` / `RdsPgVectorStack` to reflect the actual technology (RDS PostgreSQL, not Aurora Serverless).

---

## 3. The Three-Lambda Architecture (No NAT Gateway)

### Why Three Lambdas

A Lambda inside a VPC subnet has **no internet access** unless a NAT Gateway routes its egress traffic. NAT Gateways cost approximately $32 USD/month plus data-transfer charges — expensive for a portfolio workload.

The solution splits responsibility by network context:

```
POST /ingestion/trigger
        │
        ▼
┌───────────────────┐
│  Trigger Lambda   │  No VPC │ 10 s timeout
│  Validate input   │  Returns 202 immediately
│  Invoke Fetcher   │  (async / Event invocation)
└───────────────────┘
        │ async
        ▼
┌───────────────────┐
│  Fetcher Lambda   │  No VPC │ 5 min timeout
│  GitHub API calls │  Resolves GitHub token from SM
│  Upload S3 bundle │  Writes files JSON to S3
│  Invoke Worker    │  (async / Event invocation)
└───────────────────┘
        │ async
        ▼
┌───────────────────┐
│  Worker Lambda    │  VPC PRIVATE_ISOLATED │ 15 min timeout
│  Read S3 bundle   │  S3 Gateway endpoint (free)
│  Chunk + embed    │  Bedrock Runtime Interface endpoint
│  Upsert to RDS    │  TCP 5432 within VPC
│  Delete S3 bundle │  Cleanup on success or error
└───────────────────┘
```

**GitHub API access** stays outside the VPC (Fetcher Lambda). The Worker never touches GitHub — it receives a pre-fetched file bundle from S3. This eliminates the NAT Gateway entirely.

**VPC endpoints used instead**:

| Endpoint | Type | Monthly cost | Purpose |
|----------|------|-------------|---------|
| Secrets Manager | Interface | ~$14/month (2 AZs) | RDS credentials at cold start |
| Bedrock Runtime | Interface | ~$14/month (2 AZs) | `InvokeModel` (Titan Embed v2) |
| S3 | Gateway | **$0** | Worker reads staged file bundle |

Total VPC endpoint cost (~$28/month) vs NAT Gateway (~$32/month + data transfer): cheaper in all but the most write-heavy scenarios, and zero egress surprises.

---

## 4. End-to-End Workflow

### Step 1 — Trigger (< 1 second, caller experience)

An admin dashboard or CI script calls:
```
POST /{env}/ingestion/trigger
X-Api-Key: <key>
Content-Type: application/json

{ "userId": "nelson", "repoFullName": "nelsonlamounier/portfolio", "forceReindex": false }
```

The Trigger Lambda:
1. Validates the body with Zod (`userId` non-empty, `repoFullName` matches `owner/repo`)
2. Invokes the Fetcher Lambda with `InvocationType: 'Event'` (fire-and-forget)
3. Returns `HTTP 202 Accepted` — the caller does not wait for the pipeline

### Step 2 — File Fetch (Fetcher Lambda, ~30–60 seconds for a typical repo)

1. Resolves GitHub PAT from Secrets Manager (cached across warm invocations)
2. Calls `GitHubAdapter.listFiles(repoFullName)` — one GitHub Trees API call returns all file metadata
3. Passes the file list through `FileFilter.filterWithSize()`:
   - **Include**: `**/*.md`, `**/*.ts`, `**/*.tsx`, `**/*.py`, `**/*.yaml`, `**/*.json`, etc.
   - **Exclude**: `**/node_modules/**`, `dist/**`, `**/*.test.ts`, `yarn.lock`, etc.
   - **Size limit**: files > 500 KB dropped before content fetch (saves API quota)
4. Fetches content for each included file sequentially via `GitHubAdapter.fetchFile()`
5. Builds a JSON bundle: `{ userId, repoFullName, forceReindex, files: [{ path, sizeBytes, content }] }`
6. Uploads bundle to S3: `ingestion/{userId}/{owner}-{repo}/{timestamp}.json`
7. Invokes Worker async with `{ userId, repoFullName, forceReindex, s3Key }`

### Step 3 — Pipeline (Worker Lambda, up to 15 minutes)

The Worker runs the full ingestion pipeline, broken into six sub-steps:

#### Step 3a — Read Bundle from S3
Worker reads the JSON bundle using the S3 Gateway endpoint (free, within AWS network). After reading, the bundle contents are held in memory; the S3 object is deleted in the `finally` block regardless of success or error.

#### Step 3b — Chunking (`MarkdownChunker` via `ChunkerRegistry`)

Each file passes through the appropriate chunker:

```
raw file content
      │
      ▼
  Strip YAML frontmatter
      │
      ▼
  Split on heading lines (## ### ####)
      │  Each section = heading + its body
      ▼
  maxChunkChars exceeded?
      ├── Yes → split at paragraph boundaries (blank lines)
      └── No  → emit as-is
      │
      ▼
  Carry overlap tail (200 chars) into next chunk
      │  Buffer prefix: "...{last 200 chars of previous chunk}"
      └── Prevents hard cuts mid-sentence
      │
      ▼
  Tag derivation from file path
      │  "docs/architecture/overview.md" → tags: ["docs", "architecture"]
      ▼
  Emit RawChunk[]
```

Each `RawChunk` contains: `filePath`, `heading`, `content`, `fileType`, `tags`, `chunkIndex`, `totalChunks`. No user or embedding data — those are added by the pipeline layer.

#### Step 3c — Hash Check (one DB round-trip)

Before embedding, the pipeline calls `vectorStore.checkContentHashes()`. This sends all `(filePath, chunkIndex, SHA-256(content))` tuples to RDS in a single query that classifies each chunk as:

- **missing** — no DB row → must embed and insert
- **stale** — DB row exists, but hash changed → must re-embed and update  
- **unchanged** — DB row exists, hash matches → skip (no Bedrock call)

Skipping unchanged chunks is the primary cost-control mechanism. On a typical re-run where only 3 files changed, ~95% of chunks are skipped.

#### Step 3d — Context Enrichment + Embedding

For each `missing` or `stale` chunk:

```typescript
// Text sent to Bedrock Titan Embed v2:
const embedText = `[Repository: nelsonlamounier/portfolio | File: docs/architecture.md | Section: ## Deployment]

## Deployment

The CDK stack deploys to us-east-1...`
```

The preamble (`[Repository: ... | File: ... | Section: ...]`) is prepended to the text that is **sent to the embedding model only**. The `content` field stored in the database contains the original clean text. This enriches the vector with structural signal (repo context, file path, section heading) without polluting retrieval results with metadata strings.

Each call goes to `amazon.titan-embed-text-v2:0` via the Bedrock Runtime Interface endpoint, returning a 1024-dimensional `float32` vector.

#### Step 3e — Upsert to RDS

Embedded chunks are upserted via:

```sql
INSERT INTO document_embeddings (
    user_id, repo_full_name, file_path, heading, content,
    file_type, tags, chunk_index, total_chunks, content_hash,
    embedding, last_synced_at
) VALUES ($1, $2, $3, ...) 
ON CONFLICT (user_id, repo_full_name, file_path, chunk_index)
DO UPDATE SET
    content = EXCLUDED.content,
    content_hash = EXCLUDED.content_hash,
    embedding = EXCLUDED.embedding,
    last_synced_at = NOW()
```

The unique constraint on `(user_id, repo_full_name, file_path, chunk_index)` is the upsert key. On first ingest → insert. On re-ingest of changed file → update.

#### Step 3f — Stale Chunk GC (`pruneDeletedFiles`)

After upsert, the pipeline calls:

```sql
DELETE FROM document_embeddings
WHERE user_id = $1
  AND repo_full_name = $2
  AND file_path NOT IN ($3, $4, $5, ...)
```

Where `$3...$N` is the complete set of file paths in the current ingestion. Any chunk belonging to a file that no longer exists in the repository is deleted. The count of deleted rows is reported back as `pruned` in the `IngestionReport`.

This prevents vector store bloat when files are renamed, deleted, or moved between runs.

#### Step 3g — Sync State

`repo_sync_state` is updated at key milestones:
- `markStarted` — sets `sync_status = 'syncing'` before any work begins
- `markComplete` — records `file_count`, `chunk_count`, `last_synced_at`, `sync_status = 'complete'`
- `markError` — records the error message and sets `sync_status = 'error'`

This table is the source of truth for the admin dashboard's "last synced" display.

### Step 4 — Ingestion Report (CloudWatch)

The Worker logs a structured JSON report on completion:

```json
{
  "userId": "nelson",
  "repoFullName": "nelsonlamounier/portfolio",
  "totalRawChunks": 847,
  "embedded": 143,
  "skipped": 701,
  "pruned": 3,
  "inserted": 89,
  "updated": 54,
  "errors": 0,
  "durationMs": 142000
}
```

---

## 5. Database Schema

### `document_embeddings` Table

```sql
CREATE TABLE document_embeddings (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT        NOT NULL,
  repo_full_name  TEXT        NOT NULL,
  file_path       TEXT        NOT NULL,
  heading         TEXT,
  content         TEXT        NOT NULL,
  content_tsv     TSVECTOR    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  file_type       TEXT,
  tags            TEXT[],
  chunk_index     INTEGER     NOT NULL,
  total_chunks    INTEGER     NOT NULL,
  content_hash    TEXT        NOT NULL,
  embedding       vector(1024) NOT NULL,
  last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Key design decisions:**

- `content_tsv GENERATED ALWAYS AS` — PostgreSQL maintains the FTS column automatically. No application code maintains it; no trigger needed. Changing `content` via `UPDATE` atomically updates `content_tsv` in the same transaction.
- `content_hash` — SHA-256 of the raw chunk content, computed before embedding. The hash-check query uses this to classify chunks, avoiding redundant Bedrock API calls.
- `embedding vector(1024)` — matches Titan Embed Text v2's output dimension. Changing this after deploy requires a table migration (column cannot be altered in-place for pgvector).

### Indexes

| Index | Type | Purpose |
|-------|------|---------|
| `idx_embeddings_user_id` | B-tree | Fast `WHERE user_id = $1` scans |
| `idx_embeddings_user_repo` | B-tree | Filter by `(user_id, repo_full_name)` |
| `idx_embeddings_natural_key` | Unique B-tree | `ON CONFLICT` upsert target |
| `idx_embeddings_hnsw` | HNSW | Approximate nearest-neighbour (`<=>` cosine distance) |
| `idx_embeddings_content_tsv` | GIN | Full-text search (`content_tsv @@ plainto_tsquery(...)`) |

### `repo_sync_state` Table

```sql
CREATE TABLE repo_sync_state (
  user_id         TEXT        NOT NULL,
  repo_full_name  TEXT        NOT NULL,
  sync_status     TEXT        NOT NULL DEFAULT 'pending',
  last_synced_at  TIMESTAMPTZ,
  file_count      INTEGER     NOT NULL DEFAULT 0,
  chunk_count     INTEGER     NOT NULL DEFAULT 0,
  error_message   TEXT,
  PRIMARY KEY (user_id, repo_full_name)
);
```

---

## 6. Hybrid Retrieval (BM25 + Vector via RRF)

### What is Reciprocal Rank Fusion?

RRF merges two ranked lists by scoring each result as the sum of `1 / (k + rank)` from each list, where `k = 60` (standard constant that dampens the influence of top-ranked outliers). A result that ranks #1 in both lists scores `1/61 + 1/61 ≈ 0.033`. A result missing from one list gets `0` for that component.

### SQL Implementation

```sql
WITH
vector_ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (ORDER BY embedding <=> $queryVec::vector) AS vrank
    FROM document_embeddings
    WHERE user_id = $userId AND repo_full_name = $repo
    ORDER BY embedding <=> $queryVec::vector
    LIMIT $limit
),
text_ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               ORDER BY ts_rank(content_tsv, plainto_tsquery('english', $queryText)) DESC
           ) AS trank
    FROM document_embeddings
    WHERE user_id = $userId AND repo_full_name = $repo
      AND content_tsv @@ plainto_tsquery('english', $queryText)
    ORDER BY ts_rank(...) DESC
    LIMIT $limit
),
rrf AS (
    SELECT COALESCE(v.id, t.id) AS id,
           COALESCE(1.0 / (60 + v.vrank), 0.0)
               + COALESCE(1.0 / (60 + t.trank), 0.0) AS rrf_score
    FROM vector_ranked v
    FULL OUTER JOIN text_ranked t ON v.id = t.id
)
SELECT d.*, r.rrf_score AS similarity
FROM rrf r JOIN document_embeddings d ON d.id = r.id
ORDER BY r.rrf_score DESC
LIMIT $limit
```

### When Hybrid Beats Pure Vector

| Query type | Best mode |
|------------|-----------|
| `"How does the authentication middleware work?"` | Hybrid — keyword "authentication middleware" boosts exact matches |
| `"Tell me about error handling strategy"` | Hybrid — captures both semantic meaning and the literal phrase |
| `"What does Nelson think about..."` | Vector — no exact keywords; semantic understanding required |
| `"CDK stack lifecycle"` | Hybrid — "CDK", "stack", "lifecycle" are exact domain terms |

Callers control the mode via `QueryParams.useHybrid = true` and providing `queryText`. The Bedrock Agent's action group Lambda will set this flag based on whether the user's query contains domain-specific keywords.

---

## 7. SSM Parameters

### Published by `Bedrock-Aurora-{env}` (RdsPgVectorStack)

All parameters use the path prefix `/{namePrefix}/rds/` where `namePrefix` = `bedrock-{environment}`.

| Parameter | Example (dev) | Value | Consumed by |
|-----------|---------------|-------|-------------|
| `/{prefix}/rds/secret-arn` | `/bedrock-development/rds/secret-arn` | SM secret ARN containing `{ username, password }` | Ingestion Worker Lambda, Bootstrap Lambda |
| `/{prefix}/rds/host` | `/bedrock-development/rds/host` | RDS instance endpoint hostname | Ingestion Worker Lambda, Query Lambda |
| `/{prefix}/rds/port` | `/bedrock-development/rds/port` | `5432` | Ingestion Worker Lambda, Query Lambda |
| `/{prefix}/rds/database` | `/bedrock-development/rds/database` | `portfolio_kb` | Ingestion Worker Lambda, Query Lambda |
| `/{prefix}/rds/user` | `/bedrock-development/rds/user` | `postgres` | Ingestion Worker Lambda, Query Lambda |
| `/{prefix}/rds/vpc-id` | `/bedrock-development/rds/vpc-id` | VPC ID | For future Lambda cross-stack placement |
| `/{prefix}/rds/db-sg-id` | `/bedrock-development/rds/db-sg-id` | DB security group ID | For future cross-stack SG wiring |
| `/{prefix}/rds/lambda-sg-id` | `/bedrock-development/rds/lambda-sg-id` | Lambda security group ID | For future isolated-subnet Lambda wiring |

> **Note**: The Ingestion Stack reads these SSM parameters at CDK **deploy time** using `ssm.StringParameter.valueForStringParameter()`. The resolved values become Lambda environment variables — the Lambda itself never calls SSM at runtime.

### Published by `Bedrock-Ingestion-{env}` (IngestionStack)

| Parameter | Example (dev) | Value | Consumed by |
|-----------|---------------|-------|-------------|
| `/{prefix}/ingestion/api-url` | `/bedrock-development/ingestion/api-url` | API Gateway invoke URL | Admin dashboard, CI/CD scripts |

---

## 8. Secrets Manager Resources

### Created by `Bedrock-Aurora-{env}`

| Secret name | Content | Updated by |
|-------------|---------|------------|
| `{namePrefix}/rds-pgvector/credentials` | `{ "username": "postgres", "password": "<auto-generated>" }` | CDK (auto-rotated password; never manually set) |

### Created by `Bedrock-Ingestion-{env}`

| Secret name | Content | Updated by |
|-------------|---------|------------|
| `{namePrefix}/github-token` | `{ "token": "PLACEHOLDER_UPDATE_ME" }` | **Must be updated manually post-deploy** |

---

## 9. Post-Deployment Checklist

### Required Before First Ingestion Run

#### 1. Update GitHub Token Secret

The GitHub PAT secret is created with a placeholder value. Replace it before calling the ingestion API:

```bash
aws secretsmanager update-secret \
  --secret-id bedrock-development/github-token \
  --secret-string '{"token":"ghp_YOUR_PERSONAL_ACCESS_TOKEN"}'
```

**Token permissions required**: `repo` (read access to private repositories) or `public_repo` (read access to public repositories only, no `repo` scope needed).

For production:
```bash
aws secretsmanager update-secret \
  --secret-id bedrock-production/github-token \
  --secret-string '{"token":"ghp_YOUR_PAT"}'
```

#### 2. Verify Bootstrap Lambda Ran Successfully

The schema bootstrap runs automatically as a CloudFormation custom resource. Check the bootstrap Lambda's log group to confirm:

```bash
aws logs tail /aws/lambda/bedrock-development-rds-bootstrap --follow
```

Expected final log line: `{"message":"Bootstrap complete","steps":9}` (or similar — all 9 DDL steps executed).

#### 3. Retrieve the Ingestion API URL

```bash
aws ssm get-parameter \
  --name /bedrock-development/ingestion/api-url \
  --query Parameter.Value \
  --output text
```

#### 4. Retrieve the API Key (if `enableApiKey: true`)

```bash
aws apigateway get-api-keys \
  --include-values \
  --query "items[?name=='bedrock-development-ingestion-key'].value" \
  --output text
```

### First Ingestion Run

```bash
INGESTION_URL=$(aws ssm get-parameter \
  --name /bedrock-development/ingestion/api-url \
  --query Parameter.Value --output text)

API_KEY=$(aws apigateway get-api-keys \
  --include-values \
  --query "items[?name=='bedrock-development-ingestion-key'].value" \
  --output text)

curl -X POST "${INGESTION_URL}ingestion/trigger" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${API_KEY}" \
  -d '{"userId":"nelson","repoFullName":"nelsonlamounier/portfolio","forceReindex":false}'
```

Expected response:
```json
{
  "status": "queued",
  "userId": "nelson",
  "repoFullName": "nelsonlamounier/portfolio",
  "forceReindex": false
}
```

### Monitoring a Run

```bash
# Fetcher Lambda logs
aws logs tail /aws/lambda/bedrock-development-ingestion-fetcher --follow

# Worker Lambda logs
aws logs tail /aws/lambda/bedrock-development-ingestion-worker --follow
```

The worker emits a structured JSON completion log with `totalRawChunks`, `embedded`, `skipped`, `pruned`, `inserted`, `updated`, `errors`, and `durationMs`.

### Checking Sync State in the Database

Connect via AWS Systems Manager Session Manager + port-forward, or run a query Lambda:

```sql
SELECT repo_full_name, sync_status, last_synced_at, file_count, chunk_count, error_message
FROM repo_sync_state
WHERE user_id = 'nelson';
```

---

## 10. Design Decisions

### D1 — RDS PostgreSQL Instead of Aurora Serverless v2

Aurora Serverless v2 supports the RDS Data API (HTTP-based, no VPC Lambda required), which was the original plan. The migration to RDS PostgreSQL was driven by:

- **pgvector availability**: pgvector 0.8.0 is available on PostgreSQL 14+ on RDS — no Aurora-specific version required.
- **Cost predictability**: Aurora Serverless v2 scales to zero (0 ACU) but resumes in ~3 seconds on first query. The minimum billable unit is 0.5 ACU (~$0.04/hour = ~$29/month minimum even at idle). RDS `t4g.micro` is ~$12/month (dev/staging).
- **Data API removal**: Aurora's Data API imposes a 1 MB response limit and does not support streaming. Batch vector operations on 1024-dim embeddings approach this limit quickly. Direct TCP via `node-postgres` has no such constraint.

The tradeoff: Lambda must be VPC-resident to connect to RDS via TCP. This is handled by the three-Lambda architecture with VPC endpoints.

### D2 — Three-Lambda Chain Instead of Two (Trigger + Worker)

The original design had a Worker Lambda in a `PRIVATE_WITH_EGRESS` subnet (with NAT Gateway for GitHub API + Bedrock). The refactored design splits GitHub fetching out of the VPC entirely:

- **Fetcher Lambda** (no VPC) handles all internet egress (GitHub API)
- **Worker Lambda** (VPC isolated) handles all VPC-resident work (RDS + Bedrock via endpoint)

This eliminates the NAT Gateway (~$32/month) and replaces it with targeted VPC Interface endpoints. The S3 staging bucket acts as the handoff between the two non-VPC-resident and VPC-resident stages. The `StaticRepoAdapter` wraps the bundle contents to satisfy the existing `IRepoAdapter` interface, so the orchestrator and pipeline require no changes.

### D3 — SHA-256 Content-Hash Deduplication

Every chunk is hashed before any Bedrock API call. The `checkContentHashes` query returns a three-way classification (missing / stale / unchanged) in a single round-trip. On a typical re-run of a repo where 5% of files changed, 95% of chunks are skipped — this keeps incremental-sync cost near zero regardless of repo size.

### D4 — Sequential Embedding (No Parallelism)

Chunks are embedded one at a time. Bedrock InvokeModel has a per-model TPS limit. For a portfolio repo (< 10K chunks), sequential embedding is safe and predictable. The Lambda timeout is 900 seconds (15 minutes) — sufficient for ~3000 embed calls at ~300ms each. Parallelism (e.g., `p-limit(3)`) can be introduced when load testing shows the RDS connection pool and Bedrock TPS can sustain concurrent calls.

### D5 — GENERATED ALWAYS AS for `content_tsv`

The `content_tsv` column uses PostgreSQL's generated column feature rather than an application trigger or manual `UPDATE`. The database maintains the FTS column automatically — every `INSERT` and `UPDATE` to `content` atomically updates `content_tsv` in the same transaction. Zero application overhead; no risk of the FTS column falling out of sync.

### D6 — Overlap in MarkdownChunker (Gap 9)

When a 2000-character limit splits a paragraph mid-thought, the next chunk starts with no context about what preceded it. The `overlapChars: 200` default carries the last 200 characters of the flushed chunk as a prefix (`...{tail}`) into the next chunk's buffer. This means the embedding for the subsequent chunk "sees" the tail of the previous one — improving retrieval for queries whose answer straddles a chunk boundary.

The overlap is applied at the buffer level (before the chunk is emitted), not by re-fetching already-emitted content. No overlap is written to `content` in the database — the stored text is always clean.

### D7 — Stale Chunk GC After Upsert (Gap 6)

Without garbage collection, deleted or renamed files accumulate as orphan chunks in the vector store. These orphans degrade retrieval quality by injecting results that point to files that no longer exist. The `pruneDeletedFiles()` call runs after every ingestion using the complete set of current file paths as the "allowed" list. Any chunk whose `file_path` is absent from that list is deleted. The `pruned` count in the report makes the effect observable.

### D8 — Context Preamble Injected at Embed Time Only (Gap 2)

The embedding model receives more signal when the input includes structural metadata. However, storing `[Repository: X | File: Y | Section: Z]\n\n{content}` in the database would mean retrieval results include this prefix in the text shown to users. The solution: `buildEmbedText()` adds the preamble only to the string passed to `embedder.embed()`. The `content` field in the DB remains clean original prose. Retrieval responses are immediately readable.

### D9 — RRF k=60 (Gap 3)

Reciprocal Rank Fusion's `k` constant controls how steeply the score falls off by rank. At `k=60`, rank #1 scores `1/61 ≈ 0.016` and rank #10 scores `1/70 ≈ 0.014`. The scores are relatively flat — a near-top result in both lists beats a #1 result in only one. This is the standard value in the original RRF paper and is the right default for a portfolio knowledge base where both retrieval modes are meaningful. If keyword results begin to dominate (lowering precision), increase `k`. If they are underweighted, decrease `k`.

---

## 11. Known Limitations and Future Work

| # | Limitation | Mitigation / Future work |
|---|------------|--------------------------|
| 1 | No webhook trigger — ingestion is manually triggered | Add GitHub webhook Lambda → SNS → ingestion trigger |
| 2 | Sequential Bedrock embed calls — 1000-chunk repo takes ~5 minutes | Introduce `p-limit(3)` parallelism after load testing |
| 3 | Single `efSearch = 40` for all HNSW queries | Expose as a `QueryParams` field; tune per query type |
| 4 | No per-file retry in Fetcher — a failed `fetchFile()` is logged and skipped | Add retry with exponential backoff (3 attempts) |
| 5 | GitHub PAT is a long-lived secret — no rotation | Migrate to a GitHub App with short-lived JWT tokens |
| 6 | Staging bucket objects are deleted in Worker `finally` — a Worker crash before `finally` leaves orphans | The S3 lifecycle rule expires orphans after 1 day |
| 7 | No real-time ingestion status API — admin must poll CloudWatch | Add `GET /ingestion/status/{repo}` backed by `repo_sync_state` |
| 8 | No support for TypeScript chunker (code-aware splitting) | Implement `TypeScriptChunker` using `@typescript-eslint/parser` AST |
