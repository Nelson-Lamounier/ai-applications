# Ingestion Strategist — Full-Codebase Design Review

## System as Built Today

Current ingestion architecture handles `.md`/`.mdx` well and has a line-window fallback for code files. The filter config (`FileFilter.ts:99–143`) already includes `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.yaml`, `.yml`, `.json` — the gap is that `DefaultChunker` splits those files on arbitrary line boundaries (80-line windows with 10-line overlap), not semantic boundaries. A TypeScript function that spans lines 75–95 will be cut in half across two chunks, and neither chunk will embed sensibly.

```
Current chunking coverage:
  .md / .mdx  → MarkdownChunker (heading-aware, paragraph splits)  ✓
  .ts .js .py → DefaultChunker  (line-window, arbitrary)            ✗
  .yaml .json → DefaultChunker  (line-window, arbitrary)            ✗
  Code comments → not extracted, buried inside line windows          ✗
  IaC (CDK/CF/Terraform) → line-window, structure ignored            ✗
```

---

## 1. Expanding Ingestion to the Whole Codebase

### 1.1 What to Index

**Source code** — index per-function/per-class/per-export, not per-line-window. The semantic unit in code is the declaration.

**Code comments** — JSDoc blocks, Python docstrings, and inline block comments often contain the best natural-language description of what a function does. Strip comment markers and embed them as a separate `comment` chunk associated with the parent declaration.

**Infrastructure as Code** — CDK stacks (TypeScript), CloudFormation YAML, Terraform HCL, ARM JSON. These describe Cloud Account resources — their structure is declarative, and each resource block is the semantic unit.

**Configuration files** — `package.json`, `tsconfig.json`, `.env.example`. Typically small enough to embed as single chunks.

**Schema files** — SQL DDL, Prisma schema, GraphQL SDL. Each table/type definition is a semantic unit.

| File type | Semantic unit | Recommended chunker |
|---|---|---|
| `.md` / `.mdx` | Heading section | `MarkdownChunker` (current) |
| `.ts` / `.tsx` / `.js` | Function / class / export | `CodeChunker` (tree-sitter) |
| `.py` | Function / class / docstring | `CodeChunker` (tree-sitter) |
| `.yaml` / `.yml` (CloudFormation/CDK) | Top-level resource block | `YamlResourceChunker` |
| `.json` (< 100 lines) | Whole file | `DefaultChunker` (1 chunk) |
| `.tf` / `.hcl` (Terraform) | `resource` / `module` blocks | `HclChunker` |
| `.sql` | `CREATE TABLE` / `CREATE FUNCTION` | `SqlChunker` |

### 1.2 Cloud Account Lifecycle — What to Collect

"Cloud Account Lifecycle" means the data describing how cloud resources are provisioned, modified, and deprovisioned across AWS, Azure, GCP, and others. For a strategist RAG, this data answers questions like *"how did we configure the Aurora cluster?"* or *"what IAM policies exist for the ingestion Lambda?"*

**Data fields to collect from each IaC chunk:**

```typescript
interface CloudResourceChunk extends RawChunk {
  cloudProvider:    'aws' | 'azure' | 'gcp' | 'unknown';
  resourceCategory: 'compute' | 'storage' | 'network' | 'iam' | 'database' | 'ai' | 'other';
  resourceType:     string;   // e.g. 'aws::rds::dbcluster', 'azurerm_virtual_network'
  environment:      string;   // 'development' | 'staging' | 'production'
  stackName:        string;   // CDK stack or TF module name
  region:           string;   // where deployed
  lifecycle:        'create' | 'update' | 'destroy' | 'unknown';
}
```

**Detection heuristics by file type:**

```
CDK TypeScript:
  - import 'aws-cdk-lib/aws-*'              → cloudProvider = 'aws'
  - new rds.DatabaseCluster(...)            → resourceType = 'aws::rds::dbcluster'
  - new ec2.Vpc(...)                        → resourceCategory = 'network'
  - removalPolicy: DESTROY                  → lifecycle signals 'destroy'

CloudFormation YAML:
  - Resources[*].Type: 'AWS::*'             → resourceType from Type field
  - DeletionPolicy: Retain                  → lifecycle = 'retain'

Terraform HCL:
  - resource "azurerm_*"                    → cloudProvider = 'azure'
  - resource "google_*"                     → cloudProvider = 'gcp'

ARM JSON:
  - resources[*].type: 'Microsoft.*'        → cloudProvider = 'azure'
```

This metadata becomes filterable at query time: `WHERE tags @> ARRAY['aws', 'iam']` retrieves only IAM-related AWS chunks.

### 1.3 Code Comment Extraction

The most under-exploited signal in any codebase. JSDoc comments describe intent and parameters in natural language — exactly what retrieval needs.

**Strategy**: Extract comments separately as `comment` fileType chunks, linking them to the parent declaration via `filePath` + `heading`.

```typescript
// Example: for this function in AuroraVectorStore.ts
/**
 * Classify chunks — single DB round-trip.
 * Returns missing, stale, and unchanged chunk identities.
 */
async checkContentHashes(...) { ... }
```

Extracted as:
```
heading:   'checkContentHashes'
content:   'Classify chunks — single DB round-trip. Returns missing, stale, and unchanged chunk identities.'
fileType:  'jsdoc'
tags:      ['aurora', 'implementations']
```

Tools: `comment-parser` (JSDoc), `docstring-parser` (Python), or a custom regex pipeline for TypeScript/JavaScript. Tree-sitter can locate JSDoc blocks reliably by walking the `comment_block` nodes adjacent to function declarations.

---

## 2. RDS PostgreSQL vs Aurora Serverless v2

### 2.1 Critical Architecture Constraint

> **The RDS Data API is Aurora-only.** The current `AuroraVectorStore` and `AuroraSyncStateRepository` use `@aws-sdk/client-rds-data` / `RDSDataClient`. Traditional RDS PostgreSQL instances do **not** support this API. Migrating to RDS PostgreSQL requires replacing `RDSDataClient` with a VPC-resident connection driver (`pg` / `node-postgres`).

| Feature | Aurora Serverless v2 | RDS PostgreSQL (instance) |
|---|---|---|
| **RDS Data API** | Yes | No |
| **Scale to zero** | Yes (minAcu=0, ~5 min pause) | No (instance always running) |
| **Cold start** | 20–30 s after pause | None (always warm) |
| **pgvector** | Yes (1.x on pg14+) | Yes (same extension) |
| **HNSW index** | Yes (pgvector 0.5+) | Yes (same) |
| **Connection model** | HTTPS (Data API) or TCP (VPC) | TCP only (VPC required) |
| **Min cost** | $0 at zero ACU | ~$15–30/mo (db.t4g.micro) |
| **Max throughput** | Scales to 128 ACU | Fixed instance size |
| **Maintenance windows** | Automatic | Manual patching schedule |
| **RDS Proxy** | Supported | Supported |
| **Multi-AZ HA** | Automatic writer failover | Multi-AZ standby required |

### 2.2 Why You Might Want RDS Instead

- **Predictable cost**: Aurora ACUs can spike on heavy ingestion. A `db.t4g.medium` at ~$35/mo is predictable.
- **No cold starts**: Portfolio chatbot has interactive queries — 30 s cold start after Aurora pause is user-visible.
- **Direct pg connections**: `node-postgres` has a richer ecosystem (prepared statements, COPY protocol for bulk insert, LISTEN/NOTIFY).
- **Connection pooling**: PgBouncer or RDS Proxy gives fine-grained control. Aurora Data API has its own request-level connection management which cannot be tuned.
- **Cheaper at sustained medium load**: Aurora charges per ACU-hour; a fixed RDS instance at sustained load costs less than Aurora scaled to 4 ACU.

### 2.3 Why Aurora Serverless v2 Remains the Better Choice Here

- **No VPC Lambda required**: Data API lets Lambda stay outside the VPC — simpler networking, no NAT, no VPC endpoint cost.
- **True zero cost at rest**: Portfolio workload is bursty (ingest once, query occasionally). Aurora pause eliminates all idle cost.
- **Automatic scaling**: A single ingestion run that grows to 500K vectors can push Aurora to 8 ACU automatically; RDS instance would need manual resizing.

**Recommendation**: Keep Aurora Serverless v2. Add a keep-warm mechanism (EventBridge rule firing a lightweight Data API ping every 4 minutes) to eliminate cold starts for interactive resume queries. This costs ~$0.01/day.

---

## 3. Migration from Aurora Serverless v2 to RDS PostgreSQL (Step by Step)

### Step 1 — Provision RDS PostgreSQL instance

```typescript
// In CDK (replaces aurora-pgvector-stack.ts)
import * as rds from 'aws-cdk-lib/aws-rds';

const dbInstance = new rds.DatabaseInstance(this, 'VectorDb', {
  engine: rds.DatabaseInstanceEngine.postgres({
    version: rds.PostgresEngineVersion.VER_16_3,
  }),
  instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
  vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  credentials: rds.Credentials.fromGeneratedSecret('postgres'),
  databaseName: 'portfolio_kb',
  storageEncrypted: true,
  multiAz: false,  // single-AZ for dev/staging
  deletionProtection: false,
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});
```

### Step 2 — Install pgvector extension (bootstrap SQL unchanged)

Same SQL as Aurora bootstrap:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS document_embeddings (..., embedding vector(1024));
CREATE INDEX IF NOT EXISTS idx_hnsw ON document_embeddings USING hnsw (embedding vector_cosine_ops);
```

Run via a custom resource Lambda that connects with `pg` (node-postgres) instead of `RDSDataClient`.

### Step 3 — Replace `RDSDataClient` with `pg`

Current `AuroraVectorStore.execute()`:
```typescript
// BEFORE (Aurora Data API)
private async execute(sql: string, parameters: SqlParameter[]) {
  return this.client.send(new ExecuteStatementCommand({ resourceArn, secretArn, sql, parameters }));
}
```

New `RdsVectorStore.execute()`:
```typescript
// AFTER (node-postgres)
import { Pool } from 'pg';

private pool: Pool;

constructor(config: { host: string; port: number; database: string; user: string; password: string }) {
  this.pool = new Pool({ ...config, max: 5, idleTimeoutMillis: 30_000 });
}

private async execute(sql: string, values: unknown[]) {
  const client = await this.pool.connect();
  try {
    return await client.query(sql, values);
  } finally {
    client.release();
  }
}
```

> **Note**: SQL parameters change syntax from named (`:userId`) to positional (`$1`, `$2`). Rewrite all queries in `AuroraVectorStore` and `AuroraSyncStateRepository`.

### Step 4 — Lambda must be VPC-resident

RDS PostgreSQL requires TCP connection from within the VPC. Lambda must be placed in the same VPC:

```typescript
const ingestionLambda = new lambda.Function(this, 'IngestionLambda', {
  vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  securityGroups: [lambdaSecurityGroup],
  // ...
});

// Allow Lambda SG → RDS SG on port 5432
dbSecurityGroup.addIngressRule(lambdaSecurityGroup, ec2.Port.tcp(5432));
```

### Step 5 — Data migration

```bash
# On Aurora (source)
pg_dump \
  --host=<aurora-endpoint> \
  --username=postgres \
  --dbname=portfolio_kb \
  --format=custom \
  --file=portfolio_kb.dump

# On RDS (target)
pg_restore \
  --host=<rds-endpoint> \
  --username=postgres \
  --dbname=portfolio_kb \
  --no-owner \
  portfolio_kb.dump
```

Vector data (`embedding vector(1024)`) migrates transparently — `pg_dump` serializes the vector type as its text representation `[0.1, 0.2, ...]`.

### Step 6 — Update SSM parameters

```typescript
// Remove /bedrock/aurora/cluster-arn (not needed without Data API)
// Update /bedrock/aurora/secret-arn → /bedrock/rds/secret-arn
// Add /bedrock/rds/host, /bedrock/rds/port
```

### Step 7 — Update environment variables in Lambda

```
AURORA_CLUSTER_ARN   → remove (no longer needed)
AURORA_SECRET_ARN    → keep (read password from Secrets Manager)
AURORA_DB_NAME       → keep (database name unchanged)
RDS_HOST             → add (RDS endpoint)
RDS_PORT             → add (5432)
```

---

## 4. Security Implications

### 4.1 Token and Credential Security

**GitHub PAT** — `GitHubAdapter.ts:89` reads `process.env.GITHUB_TOKEN`. In Lambda, this should come from Secrets Manager (not environment variable directly):

```typescript
// Risky: token in plaintext env var, visible in Lambda console
process.env.GITHUB_TOKEN

// Better: resolve from Secrets Manager at cold start
const secret = await secretsManager.getSecretValue({ SecretId: '/ingestion/github-token' });
const token = JSON.parse(secret.SecretString!).token;
```

**Aurora/RDS credentials** — current design uses Secrets Manager (`AURORA_SECRET_ARN`). Do not rotate the secret while an ingestion is running — add a rotation window check.

### 4.2 User Data Isolation

`AuroraVectorStore` correctly scopes all queries with `WHERE user_id = :userId`. **Risk**: if `userId` is derived from a user-supplied JWT claim without server-side validation, a malicious user could query another user's embeddings by sending a spoofed `userId`. Validate `userId` against Cognito/IAM identity before passing to the vector store — never trust client-provided user IDs.

### 4.3 SQL Injection

Current parameterized queries via Data API are **safe** — the `parameters: SqlParameter[]` array prevents injection. The only unsafe pattern is string interpolation:

```typescript
// Current code in AuroraVectorStore.ts:182 — safe, value from code not user
const repoFilter = repoFullName ? 'AND d.repo_full_name = :repoFullName' : '';
```

Watch for future changes that interpolate user input directly into SQL strings.

### 4.4 PII in Indexed Content

Code repositories may contain API keys, passwords, and tokens in comments or test fixtures. Before embedding:

1. Run `git-secrets` or `detect-secrets` on each file before chunking
2. Reject files that match common secret patterns (regex for `AKIA`, `sk-`, `ghp_`, etc.)
3. Log rejected files but do not log their content

```typescript
// Add to FileFilter or as a pre-chunking step in RepoIngestionOrchestrator
const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,                          // AWS Access Key
  /ghp_[a-zA-Z0-9]{36}/,                       // GitHub PAT
  /sk-[a-zA-Z0-9]{48}/,                        // OpenAI key
  /-----BEGIN (RSA|EC) PRIVATE KEY-----/,
];
```

### 4.5 VPC Security (Aurora/RDS)

Current Aurora setup uses isolated subnets — correct. No internet gateway means no egress attack surface. If you add RDS Proxy, ensure the proxy security group only allows inbound from Lambda security group (not `0.0.0.0/0`).

### 4.6 Encryption

- Aurora cluster: `storageEncrypted: true` (CMK via KMS) — verify in stack
- Embeddings contain semantic representations of your code. A stolen vector database can be used to reconstruct approximate original text via embedding inversion attacks. Ensure at-rest encryption uses customer-managed KMS keys, not AWS-managed.

---

## 5. Testing — Step by Step

### 5.1 Unit Tests (existing — extend these)

```bash
# Run existing unit tests
yarn test --filter=applications/shared
```

**Add tests for code chunking** when `CodeChunker` is implemented:
```typescript
// FileFilter — currently tested (FileFilter.test.ts)
// MarkdownChunker — currently tested (MarkdownChunker.test.ts)
// DefaultChunker — add tests for overlap correctness
// CodeChunker — new: verify function boundary detection
```

### 5.2 Integration Test — Pipeline End to End

```typescript
// Test: real Aurora + real Titan Embed + small fixture repo

const vectorStore = new AuroraVectorStore({
  resourceArn: process.env.TEST_AURORA_ARN!,
  secretArn:   process.env.TEST_AURORA_SECRET!,
  database:    'portfolio_kb_test',  // separate test DB
});

const embedder   = new TitanEmbeddingProvider('us-east-1', 256);  // 256-dim cheaper for tests
const syncState  = new AuroraSyncStateRepository({ ... });
const pipeline   = new IngestionPipeline(vectorStore, syncState, embedder);

const result = await pipeline.ingestChunks('test-user', 'test-org/test-repo', sampleChunks);
assert(result.embedded > 0);
assert(result.upsertResult.errors === 0);

// Re-run → should skip all (content hash unchanged)
const result2 = await pipeline.ingestChunks('test-user', 'test-org/test-repo', sampleChunks);
assert(result2.skipped === sampleChunks.length);
```

### 5.3 Retrieval Quality Test (RAGAS Framework)

RAGAS (Retrieval Augmented Generation Assessment) measures retrieval and generation quality automatically using an LLM as judge.

**Step 1** — Build a golden dataset:
```typescript
interface GoldenQA {
  question: string;
  groundTruth: string;       // the correct answer
  sourceChunks: string[];    // which file:heading chunks contain the answer
}

const goldenSet: GoldenQA[] = [
  {
    question: 'How does the HNSW index get created at deploy time?',
    groundTruth: 'Via a chained AwsCustomResource against the RDS Data API in aurora-pgvector-stack.ts',
    sourceChunks: ['infra/lib/stacks/bedrock/aurora-pgvector-stack.ts#Schema Bootstrap'],
  },
  {
    question: 'What chunking strategy does MarkdownChunker use for large sections?',
    groundTruth: 'Split at paragraph boundaries (double newlines), carrying the heading as context prefix',
    sourceChunks: ['applications/shared/src/ingestion/implementations/MarkdownChunker.ts#splitAtParagraphs'],
  },
];
```

**Step 2** — Retrieval evaluation metrics:

```typescript
// Hit Rate (recall@k): fraction of questions where correct chunk appears in top-k results
function hitRate(results: SimilarityResult[], goldChunks: string[], k: number): number {
  const topK = results.slice(0, k).map(r => `${r.filePath}#${r.heading ?? ''}`);
  return goldChunks.some(gc => topK.includes(gc)) ? 1 : 0;
}

// Mean Reciprocal Rank: rewards finding the answer chunk higher in the ranking
function mrr(results: SimilarityResult[], goldChunks: string[]): number {
  for (let i = 0; i < results.length; i++) {
    const key = `${results[i].filePath}#${results[i].heading ?? ''}`;
    if (goldChunks.includes(key)) return 1 / (i + 1);
  }
  return 0;
}
```

**Step 3** — Generation evaluation (answer quality):

```typescript
// Use Claude to judge whether the generated answer is faithful to retrieved chunks
const prompt = `
  Question: ${question}
  Retrieved context: ${retrievedChunks.join('\n---\n')}
  Generated answer: ${answer}

  Score from 0–1: Is the generated answer factually grounded in the retrieved context?
  Output JSON: { "faithfulness": 0.0–1.0, "answer_relevance": 0.0–1.0 }
`;
```

**Step 4** — Run and track over time:

```bash
# Automated in CI after each ingestion pipeline change
yarn test:retrieval-quality --report-json=retrieval-report.json
```

Target metrics for a healthy retrieval system:
- Hit rate @ 5: > 0.80
- MRR: > 0.60
- Faithfulness: > 0.85
- Answer relevance: > 0.75

### 5.4 Embedding Quality Evaluation

**Intrinsic — Cosine similarity distribution:**

```sql
-- Healthy: most pairs have similarity 0.3–0.7 (not all near 1.0 = embedding collapse)
SELECT
  percentile_cont(0.10) WITHIN GROUP (ORDER BY 1 - (a.embedding <=> b.embedding)) AS p10,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY 1 - (a.embedding <=> b.embedding)) AS p50,
  percentile_cont(0.90) WITHIN GROUP (ORDER BY 1 - (a.embedding <=> b.embedding)) AS p90
FROM document_embeddings a
CROSS JOIN LATERAL (
  SELECT embedding FROM document_embeddings
  WHERE id != a.id
  ORDER BY RANDOM() LIMIT 50
) b;
```

Red flags:
- P50 similarity > 0.95 → embedding collapse (model producing near-identical vectors)
- P10 similarity > 0.80 → poor discrimination, all text looks the same
- P90 similarity < 0.20 → chunks too dissimilar, chunking too coarse

**Extrinsic — Embedding consistency test:**

```typescript
// Two paraphrases of the same concept should have high similarity
const v1 = await embedder.embed('HNSW index builds incrementally from empty');
const v2 = await embedder.embed('Hierarchical navigable small world graph supports online inserts');
const similarity = cosineSimilarity(v1, v2);
assert(similarity > 0.75, `Paraphrase similarity ${similarity} too low`);

// Unrelated concepts should have low similarity
const v3 = await embedder.embed('Aurora ACU cold start after pause');
const v4 = await embedder.embed('Python list comprehension syntax');
const dissimilarity = cosineSimilarity(v3, v4);
assert(dissimilarity < 0.40, `Unrelated similarity ${dissimilarity} too high`);
```

---

## 6. Performance Improvements

### 6.1 Batch Embedding (Highest Impact)

Current `IngestionPipeline.ts:111` embeds one chunk at a time sequentially. Parallelize with a concurrency cap:

```typescript
// Replace sequential for-loop with p-limit controlled concurrency
import pLimit from 'p-limit';

const limit = pLimit(5);  // 5 concurrent Bedrock requests

const embeddedChunks = await Promise.all(
  chunksToEmbed.map(({ chunk, contentHash }) =>
    limit(async () => {
      const embedding = await this.embedder.embed(chunk.content);
      return { ...chunk, userId, repoFullName, contentHash, embedding };
    })
  )
);
```

Expected improvement: 5× throughput for the embedding phase.

### 6.2 Bulk Upsert via Multi-row VALUES

Current `AuroraVectorStore.upsertBatch` calls `upsertOne` in a sequential loop — N round trips for N chunks. Replace with a single multi-row INSERT:

```sql
-- Multi-row INSERT with ON CONFLICT (works via Data API)
INSERT INTO document_embeddings (user_id, repo_full_name, file_path, ...)
VALUES ($1,$2,$3,...), ($4,$5,$6,...), ...
ON CONFLICT (user_id, repo_full_name, file_path, chunk_index)
DO UPDATE SET embedding = EXCLUDED.embedding, ...
WHERE document_embeddings.content_hash <> EXCLUDED.content_hash;
```

For traditional RDS PostgreSQL, use the `COPY` protocol for bulk loads (100× faster than INSERT for initial loads):
```typescript
const copyStream = client.query(
  copyFrom(`COPY document_embeddings (user_id, file_path, embedding, ...) FROM STDIN WITH CSV`)
);
```

### 6.3 HNSW Index Tuning

Current defaults (`m=16`, `ef_construction=64`) are conservative. For a dataset with 100K–1M vectors:

```sql
-- Higher ef_construction = slower build, better recall
-- Higher m = more edges per node = more memory, better recall
CREATE INDEX idx_hnsw ON document_embeddings
USING hnsw (embedding vector_cosine_ops)
WITH (m = 32, ef_construction = 128);

-- At query time, higher ef_search = slower but more accurate
SET hnsw.ef_search = 100;  -- default 40 in current AuroraVectorStore.ts:181
```

Trade-off table for 100K vectors:

| m | ef_construction | ef_search | Recall@10 | Query time |
|---|---|---|---|---|
| 16 | 64 | 40 | ~94% | 10 ms |
| 32 | 128 | 40 | ~97% | 15 ms |
| 32 | 128 | 100 | ~99% | 35 ms |
| 64 | 256 | 200 | ~99.5% | 80 ms |

For a portfolio RAG (not real-time latency-sensitive), `m=32`, `ef_construction=128`, `ef_search=100` is a good default.

### 6.4 Hybrid Search (BM25 + Vector)

Pure vector search misses exact keyword matches. BM25 (full-text search) catches exact function names, error codes, and proper nouns that embedding models often generalize away.

```sql
-- Add a tsvector column for BM25
ALTER TABLE document_embeddings ADD COLUMN fts_content tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX idx_fts ON document_embeddings USING gin(fts_content);

-- Hybrid query: combine BM25 rank and cosine similarity
WITH vector_results AS (
  SELECT id, 1 - (embedding <=> $1::vector) AS vec_score
  FROM document_embeddings WHERE user_id = $2
  ORDER BY embedding <=> $1::vector LIMIT 50
),
bm25_results AS (
  SELECT id, ts_rank(fts_content, plainto_tsquery($3)) AS bm25_score
  FROM document_embeddings WHERE user_id = $2
  AND fts_content @@ plainto_tsquery($3)
  LIMIT 50
)
SELECT COALESCE(v.id, b.id) AS id,
       COALESCE(vec_score, 0) * 0.7 + COALESCE(bm25_score, 0) * 0.3 AS hybrid_score
FROM vector_results v
FULL OUTER JOIN bm25_results b ON v.id = b.id
ORDER BY hybrid_score DESC LIMIT 10;
```

The 70/30 vector/BM25 weighting is a starting point — tune via the retrieval evaluation metrics from Section 5.3.

---

## 7. Cost Analysis and Trade-offs

### 7.1 Embedding Cost

Titan Embed v2: $0.00002 per 1,000 tokens (us-east-1, 2025 pricing).

| Dataset size | Avg chunk tokens | Total tokens | Cost |
|---|---|---|---|
| 1,000 chunks (small repo) | 500 | 500K | $0.01 |
| 50,000 chunks (10 repos) | 500 | 25M | $0.50 |
| 1M chunks (100 repos, full orgs) | 500 | 500M | $10.00 |
| 100M docs | 500 | 50B | $1,000 |

**Incremental hashing** (`checkContentHashes` in `IngestionPipeline`) is the primary cost control — only re-embed changed chunks. For a codebase that changes 5% per week, re-embedding cost is 5% of initial cost per run.

### 7.2 Vector Storage Cost

Aurora Serverless v2 charges per GB-month for storage. Each embedding row:
- `embedding vector(1024)`: 4 bytes × 1024 = 4 KB
- Content + metadata: ~2 KB
- Total per row: ~6 KB

| Vectors | Storage | Aurora cost/mo |
|---|---|---|
| 10,000 | ~60 MB | ~$0.12 |
| 100,000 | ~600 MB | ~$1.20 |
| 1,000,000 | ~6 GB | ~$12.00 |
| 10,000,000 | ~60 GB | ~$120.00 |

### 7.3 Indexing vs Querying Trade-offs

| Configuration | Indexing cost | Indexing time | Query recall | Query latency |
|---|---|---|---|---|
| No index (sequential scan) | $0 | 0 | 100% | O(n) — unusable > 10K |
| IVFFlat, lists=100 | Low RAM | Fast build | ~95% | 2–5 ms |
| HNSW m=16, ef=64 | High RAM | Slow build | ~97% | 5–15 ms |
| HNSW m=32, ef=128 | Higher RAM | Slower | ~99% | 10–35 ms |

HNSW requires holding the graph in shared_buffers. For 100K × 1024-dim vectors, estimate ~2 GB RAM for the HNSW graph. Aurora with `maxAcu=4` provides ~8 GiB — adequate. At 1M vectors, upgrade `maxAcu` to 8 (16 GiB).

### 7.4 Reducing Embedding Regeneration Cost

1. **Content hash deduplication** (already implemented) — most powerful tool
2. **Dimension reduction**: use 512-dim or 256-dim Titan v2 output. 512-dim costs 50% of 1024-dim storage; retrieval recall drops ~1–2%. Switch `EMBEDDING_DIMENSION` env var.
3. **Selective re-indexing**: only re-embed files changed since `last_synced_at` in `repo_sync_state`. Add a git diff check in `GitHubAdapter` — compare tree SHA against stored SHA before fetching any file content.
4. **Cache popular embeddings**: if multiple users index the same public repo (e.g., `aws/aws-cdk`), share embeddings by `(repo_full_name, file_path, content_hash)` across users.

---

## 8. Summary Gaps Identified

| # | Gap | Severity | Current state | Fix |
|---|---|---|---|---|
| 1 | Code files chunked arbitrarily | High | `DefaultChunker` line-window | Add `CodeChunker` (tree-sitter) |
| 2 | Code comments not extracted | High | Buried in line-window chunks | Extract JSDoc/docstring as separate chunks |
| 3 | IaC structure ignored | High | YAML/CDK treated as generic text | `YamlResourceChunker` + cloud metadata |
| 4 | No hybrid BM25+vector search | Medium | Pure cosine only | Add `fts_content` tsvector column |
| 5 | Sequential embedding (slow) | Medium | 1 chunk/request | Parallel with `p-limit(5)` |
| 6 | Sequential upsert (slow) | Medium | 1 INSERT per chunk | Multi-row INSERT batch |
| 7 | No secret scanning pre-embed | High | PII risk | Add `detect-secrets` filter step |
| 8 | userId trust issue | High | Caller-supplied, unvalidated | Validate against Cognito before vector ops |
| 9 | HNSW defaults conservative | Low | m=16, ef=64 | Tune to m=32, ef=128 for > 50K vectors |
| 10 | No retrieval evaluation pipeline | High | No metrics | Build RAGAS golden set + CI runner |
| 11 | Aurora cold start affects queries | Medium | 20–30 s on first query | Add EventBridge keep-warm ping |
| 12 | No dimension reduction option | Low | Fixed 1024-dim | Expose 512/256 via `EMBEDDING_DIMENSION` |
| 13 | No shared embedding cache | Low | Per-user re-embedding of public repos | Shared `(repo, path, hash)` lookup table |
| 14 | GitHub PAT in env var (plaintext) | Medium | `process.env.GITHUB_TOKEN` | Resolve from Secrets Manager at cold start |
