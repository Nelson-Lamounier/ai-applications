# Redis AI-Generation Cache — Design

- **Date:** 2026-05-22
- **Status:** Approved (design); ready for implementation plan
- **Scope:** Redis use case #2 (AI-generation cache) for the case-study and clustering K8s jobs only. Use cases #1, #3–#8 are explicitly out of scope.
- **Repo:** `ai-applications` (Yarn 4 monorepo, Node 22, TypeScript 5.9, Jest)

## Problem

The case-study K8s job already caches its Sonnet output, but through the wrong
backing store. It feeds a **deterministic** input hash into `PgSemanticCache`,
which then:

1. Embeds the sha256 hex string via Titan (an AWS Bedrock call — cost + latency), and
2. Runs a pgvector HNSW cosine-similarity query against RDS at threshold 0.95.

Embedding a hash and fuzzy-matching it is semantically meaningless — the 0.95
threshold just forces a near-exact match anyway. The correct primitive for a
deterministic key is an exact key-value `GET`, which Redis serves in <1ms with
no embedding call and no RDS round-trip.

Clustering has **no caching at all** today, despite being just as deterministic
(signal extraction → Haiku).

The cluster already runs a purpose-built Redis cache instance. This design wires
both jobs to it.

## Existing cluster Redis (verified live, 2026-05-22)

| | redis-cache |
|---|---|
| Service DNS | `redis-cache-master.redis-cache.svc.cluster.local:6379` |
| TLS | no |
| Auth | required (`ALLOW_EMPTY_PASSWORD=no`) |
| K8s secret | `redis-cache-auth` / key `redis-password` |
| SSM source | `/k8s/development/redis-cache-auth` (key `password`) via External Secrets Operator, store `aws-ssm` |

(`redis-broker` exists too — reserved for the future job-queue use case #6, not
touched here. `argocd-redis` is ArgoCD-internal.)

**Reachability constraint:** `*.svc.cluster.local` resolves only inside the
cluster. The case-study and clustering jobs are in-cluster K8s Jobs, so they can
reach it. Lambda apps (chatbot*) cannot and are out of scope — they keep the
pgvector cache reachable via RDS.

## Approach (chosen: A — drop-in `RedisExactCache`)

Implement the existing `ISemanticCache` interface
(`applications/shared/src/cache/cache-types.ts`) with an exact-key Redis store.
The case-study orchestrator is already coded against `ISemanticCache` with a
content hash as `queryText`, so it needs **zero changes** — only the injected
implementation at `applications/job-strategist/src/run-case-study.ts:127` swaps.

Rejected alternatives:
- **B — new `IExactCache` interface:** cleaner naming but refactors the
  orchestrator, types, and tests for cosmetic gain. YAGNI.
- **C — two-tier Redis L1 + pgvector L2:** pointless for deterministic hash
  keys; semantic fallback on hashes adds cost and complexity with zero value.

## Architecture

```
K8s job (case-study / clustering)
   │
   ├─ loadContext() ──► computeInputHash()  [project + commits + stack → sha256]
   │                         │
   │                    cache.get(scope, kbTag, hash)
   │                         │ miss
   ├─ agent.invoke() ──► Sonnet / Haiku   ◄── skipped on hit
   │                         │
   ├─ persist()              │
   └─ cache.put(scope, kbTag, hash, output)
                             │
                    ┌────────▼─────────┐
                    │ RedisExactCache  │  implements ISemanticCache
                    │  GET / SETEX /   │
                    │  SCAN+UNLINK     │
                    └────────┬─────────┘
            redis-cache-master.redis-cache.svc.cluster.local:6379
```

## Components

### New: `applications/shared/src/cache/redis-client.ts`

`ioredis` singleton factory.

- Env: `REDIS_CACHE_HOST`, `REDIS_CACHE_PORT` (default `6379`),
  `REDIS_CACHE_PASSWORD`, `REDIS_CACHE_TLS` (default `false`).
- Fail-open tuning: `lazyConnect: true`, `enableOfflineQueue: false`, low
  `maxRetriesPerRequest` (2), bounded `commandTimeout` (e.g. 500ms) and
  `connectTimeout`. A capped `retryStrategy`.
- Connection and timeout errors must never propagate into the job. When the
  client is unhealthy, cache operations behave as miss / no-op.

### New: `applications/shared/src/cache/redis-exact-cache.ts` (`implements ISemanticCache`)

- **Key schema:** `${prefix}:${scope}:${sha256(kbTag ‖ queryText)}`. The scope
  is kept literal (not folded into the hash) so `invalidate` can `SCAN`
  `${prefix}:${scope}:*`. Default prefix `aigen:v1`.
- `get(input)` → `GET key`. `null` → `{ hit: false }`. Else `JSON.parse` →
  `{ hit: true, response, similarity: 1.0 }`. Any throw → `{ hit: false }`
  (fail-open).
- `put(input)` → `SET key JSON EX ttl`. Any throw → ignore (fail-open).
- `invalidate(input)` → `SCAN` + `UNLINK` by scope prefix (batched); returns
  count of deleted keys.
- `fromEnvironment(extra?)` static factory mirroring `PgSemanticCache`. TTL from
  `REDIS_AIGEN_TTL_SECONDS`, default **2592000 (30 days)** — inputs rarely
  change, and content-hash keying makes staleness impossible.
- Emits the same EMF metrics as `PgSemanticCache`: `CacheHit`, `CacheMiss`,
  `CacheError`.

**Why no Titan embed:** the key is already deterministic. An exact `GET`
replaces (embed → pgvector HNSW), driving cache-path embedding cost to 0.

### Invalidation — solved by content addressing

The key embeds the content hash (`computeInputHash` already covers project id,
name, tagline, pitch, components, repos + tech stack + topics, and commit SHAs).
A user editing their pitch or pushing commits changes the hash → a new key →
the old entry is orphaned and expires by TTL. No explicit `DELETE` is required
and stale-serving is impossible. `invalidate()` exists for an optional explicit
project-edit purge (e.g. a future cross-repo hook from `tucaken-app`), but is not
required for correctness.

## Clustering integration (new caching)

Mirror the case-study pattern exactly:

- `applications/shared/src/projects/clustering-orchestrator.ts`: add optional
  `cache?: ISemanticCache` and `kbTag` to the input. Add
  `computeClusteringInputHash()` over the deterministic signals already produced
  by `extractSignals()` (project id, component/repo set, tech stack, commit
  velocity, test/CI maturity). `get` before the agent runs; `put` after persist.
  Same fail-open try/catch shape as case-study.
- Scope: `clustering:${userId}:${projectId}`.
- `applications/job-strategist/src/run-clustering.ts`: instantiate
  `RedisExactCache.fromEnvironment()`, inject it, and add a `cache_hit` outcome
  matching the case-study outcome enum.

## Case-study wiring

`applications/job-strategist/src/run-case-study.ts:127`: replace
`PgSemanticCache.fromEnvironment(...)` with `RedisExactCache.fromEnvironment(...)`.
The variable stays typed as `ISemanticCache`; `cacheScope`, `kbTag`, and the
orchestrator are unchanged.

## K8s / secret wiring (separate-repo handoff)

The application-repo PR is safe to merge before cluster wiring lands: the code is
fail-open, so absent or unreachable Redis env silently disables the cache and
jobs run exactly as today.

Cluster-side changes live in `kubernetes-bootstrap` (not on this machine) — a
separate PR, documented here as a required deploy step:

- `ExternalSecret` in the `job-strategist` namespace → SSM
  `/k8s/development/redis-cache-auth` (key `password`) → K8s secret
  `redis-cache-auth` / `redis-password`.
- Job env: `REDIS_CACHE_HOST=redis-cache-master.redis-cache.svc.cluster.local`,
  `REDIS_CACHE_PORT=6379`, `REDIS_CACHE_TLS=false`, `REDIS_CACHE_PASSWORD` from
  the secret.
- NetworkPolicy egress `job-strategist → redis-cache:6379` (if NetworkPolicies
  are enforced).

## Testing

- **Unit** (Jest, alongside `pg-semantic-cache.test.ts`), backed by
  `ioredis-mock`:
  - `RedisExactCache`: hit, miss, put, TTL expiry, invalidate-by-scope, key
    determinism, and fail-open (client throws → `get` returns miss, `put`
    swallows, neither propagates).
  - `computeClusteringInputHash` stability (same inputs → same hash; changed
    signal → different hash).
- **E2E** (extends `scripts/test-projects-case-study.ts` + a new clustering
  equivalent):
  - `kubectl port-forward svc/redis-cache-master -n redis-cache 6379:6379`, set
    `REDIS_CACHE_*` env, run each job **twice**.
  - Assert run 2 returns `cacheHit: true` and makes **no Bedrock call**. This is
    the end-to-end verification against the live cluster Redis.

## Cost / speed outcomes

- Cache-path Titan embedding cost → **0** (previously paid on every `get` and
  every `put`).
- Cache hits already skip Sonnet (case-study) and Haiku (clustering); detection
  is now a <1ms Redis `GET` with no RDS round-trip.
- Clustering gains caching it never had.
- Optional: EMF `EstimatedDollarsSaved` per hit (model token baseline).

## New dependencies

- `ioredis` (runtime)
- `ioredis-mock` (dev / test)

## Out of scope

- Lambda apps (chatbot, chatbot-public, chatbot-authenticated,
  resume-import-processor) — not cluster-reachable; keep pgvector cache.
- Redis use cases #1 (DB query cache), #3 (GitHub API cache), #4 (sessions),
  #5 (rate limiting), #6 (BullMQ job queue on `redis-broker`), #7 (pub/sub),
  #8 (distributed locks) — each a future spec.
- Removing `PgSemanticCache` — it remains in use by the chatbot Lambda for
  genuine semantic (free-text) caching.
- The `kubernetes-bootstrap` cluster-wiring PR (documented handoff above).
