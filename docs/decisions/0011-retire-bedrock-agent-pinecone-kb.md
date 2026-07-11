---
title: Retire the Bedrock Agent and Pinecone knowledge base for RDS pgvector
type: decision
tags: [aws-bedrock, pinecone, pgvector, rag, aws-cdk, migration, chatbot]
sources:
  - infra/lib/projects/bedrock/factory.ts
  - infra/lib/stacks/bedrock/api-stack.ts
  - api/public-api/src/routes/chatbot.ts
  - applications/chatbot-public/src/index.ts
created: 2026-07-10
updated: 2026-07-10
---

## Status

Accepted — executed 2026-07-10. Merge commits `f520e1e` (PR #456, routing)
and `114ba24` (PR #457, removal). The live teardown completed the same day:
CloudFormation stacks `Bedrock-Agent-development` and `Bedrock-Kb-development`
deleted, the Pinecone indexes deleted, and the API-key secret scheduled for
deletion. Extends [ADR 0002](0002-pgvector-over-pinecone-for-cache.md), which
made the same call for the semantic cache only.

## Context

The original portfolio chatbot was a managed **Bedrock Agent** answering from
a **Pinecone-backed Bedrock Knowledge Base**, fronted by an `invoke-agent`
Lambda on a `POST /invoke` API Gateway route. Retrieval later moved to the
platform's RDS pgvector store — the same `document_embeddings` /
`repository_profile_embeddings` tables that serve ingestion and job-strategist
— behind two new Lambdas (`chatbot-public`, `chatbot-authenticated`) queried
through `PgVectorRetriever`
([applications/chatbot-public/src/retrieval.ts](../../applications/chatbot-public/src/retrieval.ts)).

By July 2026 the agent path carried no production traffic (its Lambda's last
CloudWatch invocation was 2026-06-23, verified 2026-07-10) yet remained fully
provisioned: agent, knowledge base, Lambda, route, IAM grants, a dual-path
feature flag in `chatbot-public`, and the Pinecone index billing behind it.
The KB's content was also stale — it reflected the last S3 document sync, not
the continuously re-ingested pgvector corpus — so any caller that reached the
legacy path received outdated answers (see the companion troubleshooting doc
below for how that actually happened in production).

## Decision

Remove the agent path entirely rather than keep it as a fallback:

- The bedrock CDK project drops from four stacks to two — `Data` and `Api`
  ([infra/lib/projects/bedrock/factory.ts](../../infra/lib/projects/bedrock/factory.ts)).
  `KbStack` and `AgentStack` are deleted from the codebase.
- The `ApiStack` loses the `invoke-agent` Lambda, the `POST /invoke` route,
  and every agent IAM grant; `chatbot-public` keeps only `bedrock:Converse`
  and `bedrock:InvokeModel`
  ([infra/lib/stacks/bedrock/api-stack.ts](../../infra/lib/stacks/bedrock/api-stack.ts)).
- The `CHATBOT_RETRIEVAL_SOURCE` feature flag and the dual-path handler are
  deleted — `chatbot-public` has exactly one retrieval path
  ([applications/chatbot-public/src/index.ts](../../applications/chatbot-public/src/index.ts)).
- public-api's legacy `/api/chat` and `/api/chatbot/invoke` aliases proxy to
  the session-aware pgvector Lambda via a shared `proxyToAuthUpstream` helper
  ([api/public-api/src/routes/chatbot.ts](../../api/public-api/src/routes/chatbot.ts#L156)).
- The article pipeline's research-retrieval default flips from `bedrock-kb`
  to `pgvector`, so a missing env var can never select the deleted KB
  ([applications/article-pipeline/src/agents/research-agent.ts](../../applications/article-pipeline/src/agents/research-agent.ts)).

## Teardown order

The order mattered because a CDK factory removal does not delete
already-deployed CloudFormation stacks, and the API stack read the agent's
SSM parameters at deploy time:

1. Merge the code removal; deploy `Bedrock-Api-development` so nothing
   references the agent (route and Lambda removed in the same deploy).
2. Delete the `Bedrock-Agent-development` CloudFormation stack, then
   `Bedrock-Kb-development` (verified: zero agents and zero knowledge bases
   remain in eu-west-1, 2026-07-10).
3. Delete the Pinecone indexes via the Pinecone API using the
   `bedrock-dev/pinecone-api-key` secret — index billing stops only here,
   not at KB deletion.
4. Schedule the Pinecone API-key secret for deletion (30-day recovery
   window) once no index remains.

## Consequences

- One retrieval architecture instead of two: every conversational surface —
  site widget, direct API callers, smoke tests — answers from the same
  continuously-ingested pgvector corpus.
- The infra unit tests now assert the absence of the legacy surface (no
  `invoke-agent` Lambda, no `/invoke` resource, no `bedrock:InvokeAgent`
  grant), so it cannot silently return
  ([infra/tests/unit/stacks/bedrock/api-stack.test.ts](../../infra/tests/unit/stacks/bedrock/api-stack.test.ts)).
- Rollback to the agent is no longer a flag flip — it would require
  re-provisioning the agent, the KB, and a new vector index. This is
  accepted: the fallback had already rotted (stale data), and a rotted
  fallback is worse than none.
- The VPC-wide Bedrock interface endpoints were deliberately **kept**: they
  are `privateDnsEnabled` and serve every in-VPC Bedrock consumer
  (ingestion, job-strategist), not just the chatbot
  ([infra/lib/stacks/bedrock/api-stack.ts](../../infra/lib/stacks/bedrock/api-stack.ts)).

## Alternatives considered

- **Keep the agent as a dormant fallback.** Rejected: its KB no longer
  tracked the corpus, so the fallback answered with stale data — and its
  continued existence was precisely what let production traffic reach it
  unnoticed (see companion doc).
- **Repoint the Bedrock KB at an S3 export of the pgvector corpus.** Rejected:
  duplicates the corpus into a second store with its own sync pipeline,
  reintroducing the drift this decision removes.
- **Keep the `/invoke` route but integrate it with the pgvector Lambda.**
  Partially adopted at the BFF layer (the public-api aliases were repointed
  rather than deleted, preserving API compatibility), but the API Gateway
  route itself was removed — nothing external called it.

## Deeper detail

- [Chatbot served stale Pinecone answers after the pgvector migration](../troubleshooting/chatbot-stale-pinecone-answers.md)
  — the unpointed-alias failure mode that motivated finishing this
  decommission, and the invocation-ledger forensics that located it.

<!--
Evidence trail (auto-generated):
- Source: infra/lib/projects/bedrock/factory.ts (read on 2026-07-10, at aab8ccd)
- Source: infra/lib/stacks/bedrock/api-stack.ts (read on 2026-07-10)
- Source: api/public-api/src/routes/chatbot.ts (read on 2026-07-10)
- Commit: f520e1e (PR #456), 114ba24 (PR #457)
- Live: aws bedrock-agent list-agents / list-knowledge-bases returned empty, eu-west-1 (2026-07-10)
- Live: CloudFormation stack-delete-complete for Bedrock-Agent-development + Bedrock-Kb-development (2026-07-10)
- Live: Pinecone API GET /indexes returned zero indexes after deletion (2026-07-10)
-->
