---
title: Respond to Redis cache memory pressure / eviction storm
type: runbook
tags: [operations, redis, cache, finops, kubernetes]
sources:
  - applications/shared/src/cache/redis-client.ts
  - applications/shared/src/cache/redis-exact-cache.ts
  - applications/shared/src/cache/redis-read-cache.ts
created: 2026-05-27
updated: 2026-05-27
---

## When to run this

The shared Redis cluster (`redis-cache`) backs both
`RedisExactCache` (AI-generation, `aigen:v1:*` keys) and
`RedisReadCache` (BFF reads, `shared:*` keys) — see
[docs/concepts/caching-tiers.md](../concepts/caching-tiers.md).
Open this runbook when:

- Redis reports `used_memory` close to `maxmemory`
- `evicted_keys` is incrementing on a working cluster
- `redis_cache_requests_total{outcome="error"}` is spiking
  (caller-side metric labelled by cache name)
- Client logs show `[redis-exact-cache] invalidate failed — no-op` or
  `[redis-read-cache] corrupt cached value — evicting` at unusual rates
- Cache hit-rate on `redis_cache_requests_total{outcome="hit"}` falls
  off a cliff for a normally-hot scope

If `REDIS_CACHE_HOST` is empty everywhere the platform is running
**uncached on purpose** ([redis-client.ts:36-46](../../applications/shared/src/cache/redis-client.ts#L36-L46))
— that is not the same problem as eviction; do not follow this
runbook unless the cache is wired in.

## Prerequisites

- `kubectl` access to the cluster running `redis-cache`
- Optional: `redis-cli` on the bastion or via `kubectl exec` into
  a sidecar in the same namespace
- The metric scope name(s) you suspect are misbehaving
- Familiarity with which keys belong to which cache
  (`aigen:v1:scope:kbTag:hash` vs `shared:…` —
  [caching-tiers.md](../concepts/caching-tiers.md))

## Procedure

### 1. Snapshot the current state — do not change anything yet

```bash
# Identify the master pod (cluster mode aware)
REDIS_NS=redis-cache
REDIS_POD=$(kubectl -n "$REDIS_NS" get pods -l app=redis-cache,role=master \
  -o jsonpath='{.items[0].metadata.name}')

# Memory + eviction counters
kubectl -n "$REDIS_NS" exec "$REDIS_POD" -- redis-cli INFO memory | \
  grep -E 'used_memory_human|maxmemory_human|maxmemory_policy|evicted_keys'

# Key totals + per-namespace counts
kubectl -n "$REDIS_NS" exec "$REDIS_POD" -- redis-cli DBSIZE
kubectl -n "$REDIS_NS" exec "$REDIS_POD" -- \
  redis-cli --scan --pattern 'aigen:v1:*' | wc -l
kubectl -n "$REDIS_NS" exec "$REDIS_POD" -- \
  redis-cli --scan --pattern 'shared:*' | wc -l
```

Capture the numbers in the incident channel before any action so the
"before" is recorded.

### 2. Classify the cause

| Snapshot | Likely cause | Next step |
| :- | :- | :- |
| `aigen:v1:*` count grew sharply in last hour | AI-gen job storm (case-study, clustering) for one scope | Inspect scope distribution (step 3) |
| `shared:*` count grew sharply | Public traffic spike or `admin-api` invalidation failed | Check `admin-api` logs for invalidation failures |
| `maxmemory_policy: noeviction` + memory at cap | Misconfigured eviction policy | Fix policy (step 4) |
| Memory at cap, evictions steady | Cluster genuinely undersized | Resize (step 5) |
| `evicted_keys` only ticks during a specific scope's burst | TTL too long for that scope | Tune TTL (step 6) |

### 3. Find the dominant scope

```bash
kubectl -n "$REDIS_NS" exec "$REDIS_POD" -- \
  redis-cli --scan --pattern 'aigen:v1:*' | \
  awk -F: '{print $3}' | sort | uniq -c | sort -rn | head
```

`$3` in the key is `scope`
([redis-exact-cache.ts:70-73](../../applications/shared/src/cache/redis-exact-cache.ts#L70-L73)).
Top scope = where pressure originates. Cross-reference with
`redis_cache_requests_total{cache="<scope>",outcome="hit"}` to confirm
the scope is *not* the platform's most useful one — protect that
before evicting it.

### 4. Confirm eviction policy is sensible

```bash
kubectl -n "$REDIS_NS" exec "$REDIS_POD" -- \
  redis-cli CONFIG GET maxmemory-policy
```

Expected: `allkeys-lru` (or `allkeys-lfu`). If `noeviction`, Redis
will reject writes once `maxmemory` is hit — every `SET` from
`RedisExactCache.put` or `RedisReadCache.getOrCompute` becomes an
error, every cache *put* becomes a fail-open miss and the platform
serves uncached. Set to `allkeys-lru`:

```bash
kubectl -n "$REDIS_NS" exec "$REDIS_POD" -- \
  redis-cli CONFIG SET maxmemory-policy allkeys-lru
# Persist via the Helm values or chart in the cluster-bootstrap repo —
# CONFIG SET alone does not survive a pod restart.
```

If you change the policy in-cluster, **also commit the same change**
to the `redis-cache` Helm chart values in the sibling
`kubernetes-platform` / `kubernetes-bootstrap` repository.

### 5. Resize the cluster

The cluster runs as a Helm chart in the kubernetes-platform repo
(values likely under `helm/redis-cache/values.yaml`). The change
lives there, not here. Bump `master.resources.limits.memory` (and
`replica.resources.limits.memory` if replicas exist) by a step,
commit, ArgoCD syncs. **Do not** in-place `kubectl set resources`
unless this is an emergency; the change will drift back on next
ArgoCD reconcile.

For an emergency in-place bump:

```bash
kubectl -n "$REDIS_NS" set resources statefulset/redis-cache-master \
  --limits=memory=<new-size>
```

Then immediately open a PR in the cluster repo with the same change
so ArgoCD does not undo it.

### 6. Tune per-scope TTL

`RedisExactCache` TTL is per-instance, defaulting to 30 days
(`REDIS_AIGEN_TTL_SECONDS=2592000`,
[redis-exact-cache.ts:59-60](../../applications/shared/src/cache/redis-exact-cache.ts#L59-L60)).
Lower for a scope that does not need 30 days of memory by overriding
the env var on that scope's deployment / Job spec only. Do **not**
lower it globally — the exact cache's value is highest for
deterministic AI-gen outputs that are expensive to recompute.

`RedisReadCache.getOrCompute(key, ttlSeconds, …)` takes TTL per call
([redis-read-cache.ts:31-35](../../applications/shared/src/cache/redis-read-cache.ts#L31-L35)),
so tuning happens at the call site, not via env. Search for
high-TTL calls (`grep -rn "getOrCompute" applications/`) and adjust
where appropriate.

### 7. Targeted invalidation (last resort)

If a specific scope's keys are eating memory and you have evidence
they are stale anyway, invalidate them — do not let LRU pick at
random:

```bash
SCOPE=offending_scope_name
KB_TAG=v1  # or '*' for all kbTags

# Dry-run: count first
kubectl -n "$REDIS_NS" exec "$REDIS_POD" -- \
  redis-cli --scan --pattern "aigen:v1:${SCOPE}:${KB_TAG}:*" | wc -l

# Delete in batches using the SCAN+UNLINK pattern the code itself uses
# (redis-exact-cache.ts:104-114 — SCAN_COUNT 256)
kubectl -n "$REDIS_NS" exec "$REDIS_POD" -- bash -c \
  'redis-cli --scan --pattern "aigen:v1:'"$SCOPE"':'"$KB_TAG"':*" | \
   xargs -L 256 redis-cli UNLINK'
```

`UNLINK` is non-blocking unlike `DEL`. Match the cache's own
invalidation idiom so behaviour stays consistent.

## Verification

```bash
# Memory dropped below cap
kubectl -n "$REDIS_NS" exec "$REDIS_POD" -- redis-cli INFO memory | \
  grep -E 'used_memory_human|maxmemory_human'

# Eviction rate stopped
kubectl -n "$REDIS_NS" exec "$REDIS_POD" -- redis-cli INFO stats | \
  grep evicted_keys
# Note the value, wait 60s, note it again. Should not advance materially.

# Caller-side hit rate restored (Prometheus query)
# rate(redis_cache_requests_total{outcome="hit"}[5m])
#   /
# rate(redis_cache_requests_total[5m])
# Compare against the baseline you captured in step 1.
```

If the metric series cleared and the hit rate climbed back, the
incident is resolved.

## Rollback

Most steps in this runbook are reversible:

| Step | Rollback |
| :- | :- |
| `CONFIG SET maxmemory-policy` | `CONFIG SET maxmemory-policy <previous>` + cluster Helm revert |
| In-place `kubectl set resources` | Cluster Helm revert (ArgoCD reconciles back) |
| Per-scope TTL env override | Remove the env var, redeploy that workload |
| Targeted invalidation | None — keys are gone. Repopulate on cache miss. |

If the situation got worse (e.g. eviction policy change made
`evicted_keys` jump because LRU is now too aggressive on
recently-written keys), revert immediately. The cache is fail-open;
the platform tolerates the cache being effectively off while you
investigate.

<!--
Evidence trail (auto-generated):
- Source: applications/shared/src/cache/redis-client.ts (read on 2026-05-27, lines 30-75)
- Source: applications/shared/src/cache/redis-exact-cache.ts (read on 2026-05-27, lines 59-114)
- Source: applications/shared/src/cache/redis-read-cache.ts (read on 2026-05-27, lines 30-50)
- Cross-reference: docs/concepts/caching-tiers.md (key-prefix isolation, scope semantics)
-->
