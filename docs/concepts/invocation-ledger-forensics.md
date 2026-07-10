---
title: Invocation-ledger forensics and cost attribution
type: concept
tags: [observability, llm-cost, finops, postgres, bedrock, incident-response]
sources:
  - applications/shared/src/rds/bedrock-cost.ts
  - applications/shared/src/agent-runner.ts
created: 2026-07-10
updated: 2026-07-10
---

## Overview

Every Bedrock invocation in this platform — LLM agents, Titan embedding
calls, guards, rewrites — books a row into the `prompt_invocations` Postgres
table with user, pipeline, agent name, model id, token counts, recomputed
cost, latency, prompt version, and timestamps
([applications/shared/src/rds/bedrock-cost.ts](../../applications/shared/src/rds/bedrock-cost.ts#L131)).
Its first purpose is cost attribution, but the same rows form a complete,
queryable execution record: **which model did what, for whom, when, and at
what price**. During the July 2026 incident investigations this ledger
repeatedly answered questions that logs could not — because K8s Job pods are
TTL-cleaned and Lambda logs rotate, while the ledger persists.

## How the ledger is populated

Two write paths converge on the same table:

- `recordInvocationToRds(pool, pipeline, context)` adapts the shared agent
  runner's invocation log into a cost record — pricing is recomputed from
  the model id as the single source of truth, and records without a `userId`
  are skipped rather than fabricated
  ([bedrock-cost.ts](../../applications/shared/src/rds/bedrock-cost.ts#L194)).
- `setDefaultAgentInvocationSink(...)` registers a process-wide fallback at
  worker startup, so helper agents that build their own contexts (guards,
  condense/expand passes, keyword surfacing) still record with user
  attribution ([agent-runner.ts](../../applications/shared/src/agent-runner.ts#L331)).
  job-strategist registers it once at pipeline entry
  ([run-pipeline.ts](../../applications/job-strategist/src/run-pipeline.ts)).

Rows carry a per-layer `pipeline` and `agent` name — e.g. `repo-sync` /
`titan-embed`, `profile-synthesis` / `profile-mirror`, `job-strategist` /
`strategist-writer` — which is what makes the forensic queries below precise.

## Forensic queries this enabled

Four real investigations from 2026-07-08/10, each answered by one query:

- **Which upstream serves production?** Per-agent last-seen timestamps
  showed the legacy chatbot Lambda idle since 2026-06-23 while the pgvector
  Lambda was active — locating the stale-Pinecone routing fault (see
  [chatbot-stale-pinecone-answers](../troubleshooting/chatbot-stale-pinecone-answers.md)).
- **Was paid work discarded?** A `profile-mirror` invocation at 06:20:43
  with no matching `user_profile_rollup.refreshed_at` advance proved a
  completed Sonnet synthesis was lost at the persistence step (see
  [loud-persistence pattern](../patterns/loud-persistence-in-best-effort-pipelines.md)).
- **Is content-hash gating working?** A quiet incremental sync of a
  3,545-chunk repo booked only 83 `titan-embed` calls — and the surplus over
  changed files exposed the commit-chunk churn (see
  [commit-chunks-vanish-after-sync](../troubleshooting/commit-chunks-vanish-after-sync.md)).
- **Is the enrichment cache paying off?** The same run booked zero
  `chunk-enrich` Haiku calls: the content-hash cache plus deterministic
  Tier-1 covered every new chunk.

```sql
-- The workhorse: who ran, how often, at what cost, in a window
SELECT pipeline, agent, model_id, count(*),
       round(sum(total_cost_cents)::numeric / 100, 4) AS usd
FROM prompt_invocations
WHERE invoked_at BETWEEN $1 AND $2
GROUP BY 1, 2, 3 ORDER BY 4 DESC;
```

## Why a ledger, not just logs or Cost Explorer

- **Logs expire; rows persist.** The mirror-only rollup run could not be
  diagnosed from pod logs (TTL-cleaned) — the ledger was the only surviving
  record of what executed.
- **Cost Explorer aggregates by model, not by feature.** The ledger's
  `pipeline`/`agent`/`user_id`/`application_id` dimensions attribute spend
  to a product surface, which CE cannot do (it splits Bedrock spend
  per-model only).
- **Fail-open architectures convert failures into silence.** When every
  layer degrades gracefully, cost governance must ride on usage
  attribution — "does each paid artefact have a verified reader and
  writer?" — and the ledger is the paid-work side of that join.

The trade-off: one Postgres write per invocation (fire-and-forget,
non-fatal on failure) and the discipline that every new agent must register
a sink — which the process-wide default makes near-automatic.

## Related concepts

- [Loud persistence in best-effort pipelines](../patterns/loud-persistence-in-best-effort-pipelines.md)
  — the write-side counterpart: making the step that persists paid work loud.
- [ADR 0011 — retire Bedrock Agent + Pinecone KB](../decisions/0011-retire-bedrock-agent-pinecone-kb.md)
  — the decommission whose exit criterion ("who still calls the old path?")
  the ledger answered.

<!--
Evidence trail (auto-generated):
- Source: applications/shared/src/rds/bedrock-cost.ts (read on 2026-07-10, at 9be0c31)
- Source: applications/shared/src/agent-runner.ts (read on 2026-07-10)
- Live: prompt_invocations queries on dev RDS — per-agent breakdown 2026-06-20..07-09, 83 titan-embed calls on the 2026-07-08 incremental sync, mirror-without-upsert at 06:20:43 (read 2026-07-09 via SSM tunnel)
-->
