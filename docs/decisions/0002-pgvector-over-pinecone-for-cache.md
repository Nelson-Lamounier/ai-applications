---
title: pgvector for semantic cache, Pinecone for the Knowledge Base
type: decision
tags: [vector-store, pinecone, pgvector, bedrock, finops, architecture]
sources:
  - applications/shared/src/cache/pg-semantic-cache.ts
  - applications/platform-rds-bootstrap/migrations/022_semantic_cache.sql
  - infra/lib/stacks/bedrock/kb-stack.ts
created: 2026-05-27
updated: 2026-05-27
---

## Status

Accepted — the split is implemented as-deployed. Semantic cache rows
live in `semantic_cache` (Aurora Postgres + pgvector), the Bedrock
Knowledge Base is backed by Pinecone via
`@cdklabs/generative-ai-cdk-constructs/lib/cdk-lib/pinecone`
([infra/lib/stacks/bedrock/kb-stack.ts:21-22](../../infra/lib/stacks/bedrock/kb-stack.ts#L21-L22)).

## Context

The platform stores embeddings in two distinct workloads with
materially different shapes:

1. **The Knowledge Base.** Curated repository documentation chunked
   by Bedrock KB and queried by the
   [chatbot RAG path](../concepts/caching-tiers.md). Read-heavy, write
   happens at ingestion time, total vectors grow with documented
   content but plateau quickly (a portfolio repo's documentation
   reaches steady-state, then trickles). Bedrock KB **requires** a
   managed vector store as the integration point — it does not allow
   pointing at a self-managed pgvector instance.
2. **The semantic response cache.** PII-scrubbed user queries +
   their LLM responses
   ([applications/shared/src/cache/pg-semantic-cache.ts](../../applications/shared/src/cache/pg-semantic-cache.ts)).
   Write-heavy (every cache miss puts a row), TTL-bounded at 7 days
   default, total vectors stay small (low thousands per active
   scope). Lookups are scope+kbTag-filtered cosine similarity over a
   small candidate set.

A single vector store could theoretically back both. The decision was
to **split**: Pinecone for the KB, pgvector for the cache.

## Decision

- **Pinecone** backs the Bedrock Knowledge Base
  ([kb-stack.ts:21-22](../../infra/lib/stacks/bedrock/kb-stack.ts#L21-L22))
  via the `@cdklabs/generative-ai-cdk-constructs` Pinecone construct.
  Pinecone connection string + Secrets Manager secret ARN are
  resolved at deploy time
  ([kb-stack.ts:62-83](../../infra/lib/stacks/bedrock/kb-stack.ts#L62-L83)).
- **pgvector** backs the semantic cache
  ([applications/platform-rds-bootstrap/migrations/022_semantic_cache.sql](../../applications/platform-rds-bootstrap/migrations/022_semantic_cache.sql))
  in the same Aurora Postgres instance that holds the platform's
  relational data, indexed by HNSW (`m=16, ef_construction=64`).

The two stores **never share embeddings.** Caching a KB-retrieved
response into the semantic cache is a separate write to pgvector;
the Pinecone-side vectors stay as the KB's source of truth.

## Consequences

**Enabled:**

- **Lower KB cost.** The kb-stack header explicitly records the
  motivation: *"Pinecone eliminates the OpenSearch Serverless minimum
  idle cost, reducing the monthly bill from ~£15–35 to ~£2–8 (token
  cost only)"*
  ([infra/lib/stacks/bedrock/kb-stack.ts:13-14](../../infra/lib/stacks/bedrock/kb-stack.ts#L13-L14)).
  Pinecone's free tier (100K vectors) is more than sufficient for the
  portfolio's documentation
  ([kb-stack.ts:80-83](../../infra/lib/stacks/bedrock/kb-stack.ts#L80-L83)).
- **Cache colocation with relational data.** Semantic-cache rows
  live in the same Aurora instance as `users`, `repository_profiles`,
  `oauth_connections`, etc. Backups, SLA, observability, IAM are
  unified — no second managed-vector-store ops surface for the cache.
- **No new SDK surface for the cache.** pgvector is just SQL
  (`<=>` cosine distance, `vector(1024)` column). The semantic cache
  reads via the same `Pool` everyone else uses
  ([pg-semantic-cache.ts:45-51](../../applications/shared/src/cache/pg-semantic-cache.ts#L45-L51));
  no Pinecone client, no auth secret per cache caller.
- **HNSW tuning lives in the codebase.** `set_config('hnsw.ef_search',
  $1, true)` per-query
  ([pg-semantic-cache.ts:84](../../applications/shared/src/cache/pg-semantic-cache.ts#L84))
  is a code change, not a Pinecone console action. The cache's
  `m=16`, `ef_construction=64`, default `ef_search=40` choices are in
  migration 022 and the cache constructor — versioned, reviewed.

**Prevented:**

- A second managed-vector-store dependency for the cache. Pinecone's
  free tier ceiling (100K vectors) would be tight against a
  write-heavy cache, and the paid tier prices would dominate the
  cache's cost story.
- Coupling the cache's TTL/invalidation model to the KB's. The KB
  reindexes on document changes (slow, controlled); the cache
  invalidates on `kbTag` rotation + 7-day TTL (fast, frequent). One
  store for both would force a single model.

**New problems / accepted residual:**

- Two backup procedures. Pinecone has its own snapshot semantics
  (managed by the provider); Aurora snapshots cover the cache. In
  practice the cache is *intentionally* discardable — the only data
  loss on cache wipe is hit rate, never user state — so the cache
  backup is "set the table back up with `IF NOT EXISTS`".
- Aurora pool budget. The cache opens a 3-connection pool
  ([pg-semantic-cache.ts:50](../../applications/shared/src/cache/pg-semantic-cache.ts#L50));
  with N services using the cache that's `3N` connections against
  the cluster's connection cap. Acceptable today; would require a
  PgBouncer-style shared pool at scale.
- HNSW recall vs latency tuning is in the application's hands. If
  the cache hit rate drops, the fix is `ef_search` tuning or
  threshold adjustment — operator skills the team must hold.

## Alternatives considered

### Pinecone for both

Tempting: one vector store, one operational surface. Rejected
because:

- Pinecone's free tier ceiling (100K vectors) is comfortable for the
  *current* KB but uncomfortable for a write-heavy cache adding tens
  of thousands of vectors per active scope per week. Cache TTL
  reclamation would keep total count bounded, but the headroom would
  be tight.
- Paid Pinecone pricing scales by vector count + queries. A
  hit-or-miss cache lookup is a query whether it hits or not; the
  semantic cache's intentional shape (every miss puts, every hit
  reads) would dominate the bill.

### pgvector for both

Tempting in the other direction: one Aurora, one SQL surface.
Rejected because Bedrock KB does not accept pgvector as a backend.
The Bedrock KB integration is the constraint that forces a managed
vector store for the KB side; pgvector is not on the list.

If Bedrock KB *did* accept pgvector, this would be a worthwhile
reconsideration — the operational simplification is real.

### OpenSearch Serverless for the KB

The previous backend before this decision (implicit in the kb-stack
header's "eliminates the OpenSearch Serverless minimum idle cost"
comment,
[kb-stack.ts:13](../../infra/lib/stacks/bedrock/kb-stack.ts#L13)).
Worked correctly but priced at the floor — £15-35/month idle even
when the KB sat unread. The decision to swap to Pinecone was driven
by cost, not by capability.

### Self-hosted Pinecone / Milvus / Weaviate

Considered briefly. Rejected because the operational cost of running
*any* self-hosted managed-grade vector store would dwarf the cost of
the managed services for this scale, and would compete for the same
operator attention as the rest of the platform.

## How this relates to the caching architecture

See [docs/concepts/caching-tiers.md](../concepts/caching-tiers.md).
The semantic cache is one of three caches; the choice of pgvector
specifically (not Redis, not Pinecone) is recorded here. The exact
and read caches use Redis for different reasons — covered in the
caching concept doc.

<!--
Evidence trail (auto-generated):
- Source: infra/lib/stacks/bedrock/kb-stack.ts (lines 1-130 on 2026-05-27)
- Source: applications/shared/src/cache/pg-semantic-cache.ts (lines 1-180 on 2026-05-27)
- Source: applications/platform-rds-bootstrap/migrations/022_semantic_cache.sql (lines 1-32 on 2026-05-27)
- Quoted cost figures (£15-35 → £2-8) from kb-stack.ts:13-14
-->
