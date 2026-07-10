---
title: Chatbot served stale Pinecone answers after the pgvector migration
type: troubleshooting
tags: [rag, pinecone, pgvector, strangler-migration, observability, aws-lambda]
sources:
  - api/public-api/src/routes/chatbot.ts
  - applications/chatbot-authenticated/src/index.ts
created: 2026-07-10
updated: 2026-07-10
---

## Symptom

The portfolio chatbot answered from an outdated knowledge base — old stack
claims, missing recent projects — weeks after retrieval had been migrated to
the continuously re-ingested RDS pgvector store. Both pgvector Lambdas were
deployed, healthy, and correctly configured; one of them showed almost no
CloudWatch invocations.

## Root cause

A classic strangler-migration failure: the new path was built, deployed, and
flag-enabled, but the **oldest consumer-facing alias was never repointed**.
public-api's `POST /api/chat` route — the one direct API callers actually
used — was documented as an "alias for /api/chatbot/invoke" and proxied to
`${BEDROCK_API_URL}/invoke`: the legacy `invoke-agent` Lambda, the Bedrock
Agent, and the decommissioned Pinecone knowledge base behind it. The KB's
content was frozen at its last S3 sync, so every caller on that alias got
stale answers while the pgvector Lambdas sat idle.

A second, compounding cause: the routing comment in the code was wrong. It
claimed "Traefik routes /api/* here so the Next.js handler is unreachable in
production" — but Traefik had been decommissioned; the live edge was an ALB
sending `nelsonlamounier.com/*` to the Next.js app (whose handler correctly
targeted pgvector) and only `api.nelsonlamounier.com` to public-api. Trusting
that stale comment initially misdirected the diagnosis.

## How to diagnose

The invocation trail identifies which upstream actually serves traffic —
no guesswork required:

```bash
# 1. Which Lambda is production actually invoking? Compare last-event times.
aws logs describe-log-streams \
  --log-group-name /aws/lambda/bedrock-dev-chatbot-authenticated \
  --order-by LastEventTime --descending --max-items 1
# Repeat for chatbot-public and the legacy invoke-agent log groups.

# 2. What does the edge really route? Do not trust code comments — dump the
#    ALB listener rules and read the host/path -> target-group mapping.
aws elbv2 describe-rules --listener-arn <listener-arn>

# 3. Which upstream URL does each BFF route call? Check the deployed env,
#    not just the source.
kubectl -n public-api get secret public-api-bedrock -o json  # BEDROCK_*_URL keys
```

The decisive signal in the 2026-07-10 investigation: the legacy Lambda's last
invocation was 2026-06-23 and `chatbot-public` had zero traffic since the
same date, while `chatbot-authenticated` was active — proving the live widget
path (ALB → Next.js → `/api/chatbot/authenticated`) was already on pgvector
and the stale surface was the direct-API-host aliases.

## How to fix

Repoint every alias at the pgvector upstream and remove the legacy surface so
it cannot regress:

1. `POST /api/chat` and `POST /api/chatbot/invoke` now proxy to
   `BEDROCK_AUTH_API_URL` through the shared `proxyToAuthUpstream` helper
   ([api/public-api/src/routes/chatbot.ts](../../api/public-api/src/routes/chatbot.ts#L156))
   — merged as PR #456 (`f520e1e`).
2. The legacy agent, KB, Lambda, and route were then deleted outright — see
   [ADR 0011](../decisions/0011-retire-bedrock-agent-pinecone-kb.md) for the
   removal and teardown order (PR #457, `114ba24`).
3. Route tests pin both aliases to the `invoke-authenticated` upstream so a
   regression to a legacy URL fails CI
   ([api/public-api/__tests__/routes/chatbot.test.ts](../../api/public-api/__tests__/routes/chatbot.test.ts)).

Post-fix verification (2026-07-10): `POST api.nelsonlamounier.com/api/chat`
answered with current corpus content, the invocation appeared in
`chatbot-authenticated` logs, and the legacy log group stayed silent.

## How to prevent

- **Migrations end when the old path is dead, not when the new path works.**
  Track "who still calls the old upstream" as an explicit exit criterion;
  last-invocation timestamps per Lambda log group answer it in one query.
- **Log the resolved upstream per request** in any BFF that fans out to
  multiple backends — the chatbot Lambdas already log `retrievalSource`,
  which is what made the attribution provable.
- **Treat routing comments as claims requiring live verification.** The ALB
  rule dump is one API call; the stale Traefik comment cost the first pass
  of this diagnosis. This repository's CLAUDE.md rule — verify infrastructure
  facts against the live account — applies to comments quoted *from* the
  codebase too.
- A useful permanent smoke prompt: ask the chatbot *which vector database it
  uses*. The corpus documents the migration itself, so the answer is wrong
  the moment routing regresses.

<!--
Evidence trail (auto-generated):
- Source: api/public-api/src/routes/chatbot.ts (read on 2026-07-10, at aab8ccd)
- Live: CloudWatch describe-log-streams last-event timestamps for all three chatbot Lambdas (2026-07-10)
- Live: ALB k8s-public listener-rule dump, dev account eu-west-1 (2026-07-10)
- Live: post-fix smoke test of api.nelsonlamounier.com/api/chat + nelsonlamounier.com/api/chat (2026-07-10)
- Incident: production chat serving stale Pinecone data via the /api/chat alias; fixed in PR #456, removed in PR #457
-->
