# Retire Pinecone + Managed Bedrock KB → Self-Managed RDS pgvector — Design & Plan

- **Date:** 2026-07-05
- **Repo:** `ai-applications` (infra + applications) with a docs sweep
- **Status:** Design for review — **no infra/code edits yet** (this document only)
- **Trigger:** The published BFF article surfaced that the platform is meant to be
  off Pinecone, but the live account still runs it.

## Verified current state (dev account `771826808455`, eu-west-1, 2026-07-05)

- **Bedrock KB `bedrock-dev-kb` (`8JH5UKMD6T`) is ACTIVE and backed by Pinecone**
  (`storageConfiguration.type = PINECONE`, connection `portfolio-kb-*.pinecone.io`,
  secret `bedrock-dev/pinecone-api-key`, namespace `portfolio-dev`, updated
  2026-05-29). **Not** decommissioned.
- **No Aurora cluster** (`describe-db-clusters` empty). The platform DB is a
  **standalone RDS PostgreSQL instance** (`k8s-dev-platform-rds-iso`). No
  OpenSearch Serverless collection.
- **Two retrieval paths coexist in code:**
  - Managed KB path: article-pipeline `research-agent.ts` issues a Bedrock
    `RetrieveCommand` against `KNOWLEDGE_BASE_ID`
    ([research-agent.ts:198](../../applications/article-pipeline/src/agents/research-agent.ts#L198));
    `chatbot` / `chatbot-public` use `@aws-sdk/client-bedrock-agent-runtime`.
  - Self-managed pgvector path: `RdsVectorStore`
    ([RdsVectorStore.ts:126](../../applications/shared/src/rds/implementations/RdsVectorStore.ts#L126))
    and `PgVectorRetriever` (hybrid pgvector + BM25 via RRF), plus the ingestion
    pipeline that writes `document_embeddings`.
- **Docs/infra still say Pinecone** in ~30 files, incl. `infra/lib/stacks/bedrock/kb-stack.ts`
  (constructs `PineconeVectorStore`), `docs/decisions/0002-pgvector-over-pinecone-for-cache.md`,
  README, `docs/concepts/*`, `docs/runbooks/bedrock-kb-reindex.md`.

## Load-bearing constraint (verified against AWS docs)

Amazon Bedrock Knowledge Bases support these managed vector stores: **OpenSearch
Serverless, Aurora PostgreSQL-Compatible Edition, Pinecone, Redis Enterprise
Cloud, MongoDB Atlas**. **Plain Amazon RDS PostgreSQL is NOT a supported Bedrock
KB vector store — only Aurora PostgreSQL is.**

**Therefore the KB cannot be "repointed" at the existing RDS pgvector.** The only
ways to reach an RDS-pgvector end-state are:

1. **(Chosen) Retire the managed Bedrock KB entirely** and serve all retrieval
   from the self-managed pgvector path (`RdsVectorStore` + BM25 RRF) already
   built for the chatbot; extend it to the article-pipeline research agent. This
   matches "RDS PostgreSQL, not Aurora."
2. (Rejected) Migrate the DB to **Aurora** PostgreSQL and keep the managed KB —
   contradicts the user's "not Aurora" and re-introduces a managed store.

ADR 0002's claims that the store is "Aurora Postgres" and that "Bedrock KB
requires a managed store, cannot point at self-managed pgvector" are the exact
reasons this migration exists; both get corrected here.

## Goal

Remove Pinecone and the managed Bedrock KB from the platform; consolidate **all**
RAG retrieval and ingestion on **self-managed RDS PostgreSQL + pgvector**
(`document_embeddings`, hybrid pgvector + BM25 RRF), with retrieval-quality
parity proven before teardown.

## Non-goals

- The article-pipeline **disclosure guardrails** work (separate branch
  `feat/article-disclosure-guardrails`).
- Changing the embedding model (stay on Titan Embeddings V2 for dimension
  compatibility with existing `document_embeddings`) — unless parity testing
  forces it, which would be its own decision.
- Editing infra/code **in this document** — this is design only.

## Architecture — target

```text
BEFORE (dual):
  repo S3 ─▶ Bedrock KB (Titan v2) ─▶ Pinecone ─▶ RetrieveCommand ─▶ research-agent / chatbot
  ingestion pipeline ─▶ document_embeddings (pgvector) ─▶ PgVectorRetriever ─▶ chatbot (hybrid)

AFTER (single, self-managed):
  ingestion pipeline (FileFilter chunks) ─▶ document_embeddings (pgvector, Titan v2)
        └─▶ PgVectorRetriever (pgvector + BM25, RRF) ─▶ research-agent AND chatbot
  (no Bedrock managed KB, no Pinecone, no pinecone-api-key secret)
```

## Phased plan (execution is a later step; this is the design)

### Phase 0 — Parity harness (no cutover)
Stand up an offline eval comparing KB-Retrieve vs `PgVectorRetriever` on the same
queries. Reuse the existing RAG golden set
(`applications/job-strategist/src/evals/rag/golden.json`) and any
`article-pipeline` retrieval evals. Metric: top-k overlap + downstream answer
quality. **Gate:** pgvector path must match or beat the KB path before cutover.

### Phase 1 — Ingestion consolidation
Confirm every source the Bedrock KB ingested from S3 is also embedded into
`document_embeddings` by the ingestion pipeline (FileFilter globs). Backfill any
gaps. Verify embedding model + dimensions match (Titan v2) so vectors are
comparable. No reads change yet.

### Phase 2 — Retrieval cutover (feature-flagged)
Replace the `RetrieveCommand` / `KNOWLEDGE_BASE_ID` calls in
`research-agent.ts` (and the chatbot agents) with `PgVectorRetriever`, behind a
flag (e.g. `RETRIEVAL_BACKEND=pgvector|bedrock-kb`, default `bedrock-kb` until
Phase 0 passes). Keep the Bedrock reranker if it still adds value, or replace
with the RRF ordering. Roll out dev-first.

### Phase 3 — Verify in the live path
Run the smoke/eval flows (chatbot + article-pipeline research) on `pgvector`.
Confirm no regression in retrieval quality or latency. Keep the Bedrock KB in
place (rollback path) until this passes.

### Phase 4 — Teardown (infra change, own PR)
Once parity holds in dev for an agreed soak period:
- Delete the Bedrock KB `8JH5UKMD6T` and its data source.
- Remove the Pinecone index + the `bedrock-dev/pinecone-api-key` secret.
- Remove `PineconeVectorStore` and the KB wiring from
  `infra/lib/stacks/bedrock/kb-stack.ts`, `index.ts`, `config/bedrock/*`,
  `.github/workflows/deploy-bedrock.yml`.
- Drop `KNOWLEDGE_BASE_ID` and Pinecone env from deploy manifests.

### Phase 5 — Docs accuracy sweep
Correct every ingested doc so the KB stops grounding future generations on
Pinecone:
- Rewrite `docs/decisions/0002-*` → a superseding ADR: store is **RDS
  PostgreSQL + pgvector**, retrieval is self-managed (correct the "Aurora" and
  "KB requires managed store" errors); mark the Pinecone decision **Superseded**.
- Sweep README, `docs/concepts/{caching-tiers,bedrock-rag-surface,titan-embedding-provider,multi-query-retrieval}.md`,
  `docs/runbooks/bedrock-kb-reindex.md`, and the sibling article
  `content/articles/agentic-content-pipeline-bedrock-rag-publishing.md`.

### Phase 6 — Article follow-up
Once Phase 4 is deployed, update the BFF article's forward-looking note (added
2026-07-05) from "is consolidating onto RDS pgvector" to past tense, and decide
whether the Pinecone Secrets-Manager-ARN challenge stays as a historical war
story (recommended: keep, labelled as prior architecture).

## Verification
- Phase 0 eval gate (retrieval parity) is the primary quality gate.
- Post-cutover: existing chatbot + article-pipeline smoke/eval suites green on
  `RETRIEVAL_BACKEND=pgvector`.
- Post-teardown: `aws bedrock-agent list-knowledge-bases` no longer lists the KB;
  `secretsmanager list-secrets` no longer lists `bedrock-dev/pinecone-api-key`;
  `grep -ri pinecone` in the repo returns only historical/ADR-superseded mentions.

## Risks & mitigations
- **Retrieval-quality regression:** Phase 0 parity gate + keep the KB as rollback
  until Phase 3 passes.
- **Ingestion gaps:** Phase 1 backfill + a count/parity check between what the KB
  indexed and `document_embeddings`.
- **Embedding mismatch:** pin Titan v2 + assert vector dimensions before cutover.
- **Hidden consumers of `KNOWLEDGE_BASE_ID`:** grep all workspaces + deploy
  manifests before Phase 4; the flag makes cutover reversible.
- **Cost note for the article/docs:** the original Pinecone rationale (avoiding
  OpenSearch Serverless idle cost) is moot once retrieval is self-managed on the
  already-running RDS instance — call this out in the superseding ADR.

## Open questions for the owner
1. Soak period for Phase 3 before teardown (e.g. 1 week dev)?
2. Keep the Bedrock **reranker** (`BedrockReranker`) on the pgvector path, or move
   to pure RRF ordering?
3. Prod vs dev: this is verified in **dev**. Is there a separate prod KB/Pinecone
   to include in the teardown?
