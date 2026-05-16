# RAG Sub-project 3 — Semantic Cache Design

**Date:** 2026-05-16
**Status:** Approved (design)
**Author:** Nelson Lamounier (with Claude Code)
**Depends on:** SP1 shared modules + SP2 `PiiScrubber` wiring (branch `rls-secure-by-default`). Closes checklist §9 (Semantic Cache) for the query apps.

## Context

The 2026-05-16 audit found chatbot and job-strategist have no response
caching — every query runs the full retrieval+generation pipeline.
resume-import's Postgres-backed Tavily cache (`tools/tavily-cache.ts`,
migration 017) is the precedent for store/TTL/hit-count; `RdsVectorStore`
is the precedent for pgvector cosine search; `TitanEmbeddingProvider`
(1024-dim, `amazon.titan-embed-text-v2:0`) is the embedder. This
sub-project adds a shared semantic cache and wires it into both query apps.

Decisions (brainstormed): store = **Postgres + pgvector**; invalidation =
**TTL + KB-version/model tag** (filter, not delete); scope = **both query
apps** (chatbot + job-strategist).

## Goals

1. Shared `@bedrock/shared` semantic cache: embed an incoming query, do a
   pgvector cosine lookup scoped by app/caller + a KB-version/model tag,
   return the cached response when similarity ≥ a strict threshold;
   otherwise miss. Store successful clean responses for future hits.
2. Wire it into chatbot (per-role) and job-strategist (per
   user/role/company), short-circuiting the expensive pipeline on a hit.
3. Fail-open everywhere; instrument hit/miss/error + hit_count for §9
   "hit rate visible in monitoring".

Non-goals: Redis/ElastiCache, in-memory LRU, caching for the pipeline
apps (ingestion/resume-import/article-pipeline), CDK/infra changes.

## A. Store — migration `022_semantic_cache.sql`

`applications/platform-rds-bootstrap/migrations/022_semantic_cache.sql`,
idempotent (`IF NOT EXISTS`), next lexical number after `021`, loaded by
the existing bootstrap runner.

```sql
CREATE TABLE IF NOT EXISTS semantic_cache (
  id              BIGSERIAL PRIMARY KEY,
  scope           TEXT NOT NULL,
  kb_tag          TEXT NOT NULL,
  query_text      TEXT NOT NULL,
  query_embedding vector(1024) NOT NULL,
  response        JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hit_count       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_semantic_cache_hnsw
  ON semantic_cache USING hnsw (query_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_semantic_cache_scope_tag
  ON semantic_cache (scope, kb_tag, created_at);
```

`scope` = app + caller scoping string; `kb_tag` = KB-version + model id;
`response` = app-defined JSON payload (chatbot: the answer string;
job-strategist: `{ analysisXml, research, fitSummary }`).

## B. Shared module `applications/shared/src/cache/`

- `cache-types.ts` — `ISemanticCache`, `SemanticCacheGetInput`,
  `SemanticCacheGetResult`, `SemanticCachePutInput`,
  `SemanticCacheConfig`.
- `pg-semantic-cache.ts` — `PgSemanticCache implements ISemanticCache`.
  Reuses the `RdsVectorStore` pool/env pattern (`RDS_HOST` … `RDS_PASSWORD`)
  and `TitanEmbeddingProvider.fromEnvironment()`. A module-level
  `PiiScrubber` (from SP2) redacts `queryText` before embed/store.
- `index.ts` barrel; added to `applications/shared/src/index.ts`.
- Colocated jest tests (mock `pg` Pool + embedder).

Interface:

```
get(input: { scope: string; kbTag: string; queryText: string })
  → Promise<{ hit: boolean; response?: unknown; similarity?: number }>
put(input: { scope: string; kbTag: string; queryText: string; response: unknown })
  → Promise<void>
```

`get`: scrub → normalise (lower/collapse-ws/trim, mirroring
`tavily-cache.normaliseQuery`) → embed → 
`SELECT id, response, 1 - (query_embedding <=> $q::vector) AS similarity
FROM semantic_cache WHERE scope=$1 AND kb_tag=$2 AND created_at > NOW() -
($ttl||' days')::interval ORDER BY query_embedding <=> $q::vector LIMIT 1`,
accept only if `similarity >= threshold`. On hit, fire-and-forget
`UPDATE … SET hit_count = hit_count + 1 WHERE id=$`.

`put`: scrub+normalise+embed, `INSERT` a row.

Config (env, with defaults): `SEMANTIC_CACHE_THRESHOLD` = `0.95` (strict,
per §9 "avoid wrong cache hits"); `SEMANTIC_CACHE_TTL_DAYS` = `7`;
`hnsw.ef_search` set per query like `RdsVectorStore` (default 40).

**Fail-open:** any error (DB unreachable, embed failure, malformed row) →
`get` returns `{ hit: false }`, `put` is a no-op; log + emit
`emitEmfMetric` `CacheError`. `get` also emits `CacheHit`/`CacheMiss`.
The cache must never throw into the host request path.

## C. Per-app wiring

### chatbot — `applications/chatbot/src/index.ts`
- **Check:** after `scrubbedPrompt` is computed (~L404) and before
  `invokeChatbotAgent(...)`. On hit, return the cached answer via the
  normal `buildResponse(200, { response, sessionId }, origin)` path,
  skipping the agent and grounding entirely.
- **Store:** after `sanitisedResponse` is produced **and only if grounding
  did not block/substitute** (do not cache the fallback, errors, or
  zero-result answers). `response` payload = the sanitised answer string.
- `scope = "chatbot:" + resolvedRole` (cache is per caller role).
- `kbTag = ${AGENT_ALIAS_ID}:${CHATBOT_MODEL}`. The chatbot's knowledge
  base is the managed Bedrock Agent; a corpus reindex ships a new agent
  alias / deployment, so alias+model is the correct invalidation token.
  Chatbot does not access `repo_sync_state`.
- chatbot does not currently import `TitanEmbeddingProvider`; the shared
  cache module owns embedding, so the handler only calls `cache.get/put`.

### job-strategist — `applications/job-strategist/src/run-pipeline.ts`
- **Check:** after `ctx` is built (~L104) and before
  `executeResearchAgent(ctx)`. PII-scrub `env.jobDescription` for the
  cache key. On hit, skip research + strategist + grounding and proceed
  directly to `updatePipelineRunMetadata` with the cached
  `{ analysisXml, research, fitSummary }` (and the normal run-status
  updates), then exit success.
- **Store:** after `finalAnalysis` is produced **and only if grounding did
  not substitute the fallback**. `response` payload =
  `{ analysisXml: finalAnalysis, research: research.data,
  fitSummary: analysis.data.fitSummary }`.
- `scope = "jobstrat:" + env.userId + ":" + env.targetRole + ":" +
  env.targetCompany`.
- `kbTag` derived from `repo_sync_state` for `env.userId`
  (max `last_synced_at` across the user's rows + the
  `kb_quality_breakdown.version`) + `STRATEGIST_MODEL`. A reindex updates
  `last_synced_at` → tag changes → prior entries no longer match (TTL
  reaps them). If the sync-state lookup fails, fall back to a tag of just
  the model id (still fail-open; correctness degrades to model-scoped
  only, never errors).

## D. Data / Control Flow (uniform)

```
query ──PiiScrubber──► normalise ──Titan embed──► pgvector lookup
   (scope + kb_tag + TTL filter, cosine ORDER BY, LIMIT 1)
     similarity ≥ threshold ─► HIT  → return cached response (skip pipeline) + CacheHit
     else / error            ─► MISS → run pipeline
                                        └─ answer GROUNDED & clean ─► put(response) 
                                        └─ blocked/error/empty     ─► do NOT cache
cache infra error ─► treat as miss / no-op put + CacheError (never breaks host)
```

## Testing

Shared module (mock pg Pool + embedder): hit above threshold; miss below
threshold; expired row (TTL) → miss; wrong `kb_tag` → miss; wrong `scope`
→ miss; fail-open on DB error (get→miss, put→no-op, no throw); fail-open
on embed error; `hit_count` increment fired on hit; PII in `queryText` is
scrubbed before embed/store.

Per-app: a mocked cache hit short-circuits the agent/pipeline (assert the
agent / research+strategist were NOT invoked and the cached payload is
returned/persisted); a NOT_GROUNDED/blocked answer is NOT stored; a cache
`get`/`put` throw does not fail the request/run.

## Scope / Sequencing

One spec. Plan sequenced: (1) migration `022`, (2) shared cache module +
tests, (3) chatbot wiring + tests, (4) job-strategist wiring + tests,
(5) final verification. Subagent-driven, per-task TDD + two-stage review.
Branch off `rls-secure-by-default` (carries the SP1/SP2 shared modules
this depends on). Touch only: `migrations/022_semantic_cache.sql`, the
shared `cache/` module + `shared/src/index.ts`, and the two query apps'
entrypoints.

## Success Criteria

- `022_semantic_cache.sql` present, idempotent, follows the 020 convention.
- `PgSemanticCache`/`ISemanticCache` exported from `@bedrock/shared`, all
  unit tests green, `applications/shared` typecheck clean.
- chatbot returns a cached answer (skipping agent+grounding) on a
  semantic hit and stores only GROUNDED clean answers, scoped by role +
  agent-alias/model tag.
- job-strategist short-circuits research+strategist+grounding on a hit and
  stores only non-substituted analyses, scoped by user/role/company +
  sync-state/model tag.
- Cache infra failure never breaks a chatbot request or a job-strategist
  run; hit/miss/error + hit_count instrumented.
- No new TS errors vs baseline in the touched apps; shared suite
  unaffected.
