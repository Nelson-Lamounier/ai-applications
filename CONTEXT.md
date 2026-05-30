<!-- @format -->

# Context — ai-applications

A glossary of the domain language. Definitions only — no implementation detail.

## Caching

- **Exact AI-gen cache** — a Redis cache keyed by a content **hash** of a
  deterministic input. An identical input returns the stored response with no
  Bedrock call. Backed by `RedisExactCache`. Used by AI-generation work
  (job-strategist clustering and case-study generation).

- **Read cache** — a Redis cache of read-model responses (e.g. a project case
  study served to portfolio visitors). Backed by `RedisReadCache`; the writer
  (admin-api) invalidates keys on mutation.

- **Semantic cache** — a **Postgres/pgvector** cache (NOT Redis). Matches a new
  query against prior responses by embedding cosine-similarity. Backed by
  `pg-semantic-cache`. Distinct from the two Redis caches above.

- **scope** — the app/caller identity a cache entry belongs to (e.g. a specific
  service + operation). The unit by which we ask "is *this* path caching."

- **kbTag** — a knowledge-base-version / model tag. Changing it rotates keys,
  giving invalidation-on-version-change for free.

- **Cache effectiveness** — whether a given **scope** is actually served from
  cache: its hit / miss / error ratio. A *per-scope* question. Distinct from
  **Redis server health**.

- **Redis server health** — whether a Redis *instance* is healthy: memory vs
  maxmemory, evictions, connected clients, ops/sec, persistence, reachability.
  A *per-instance* question, global across all scopes on that instance.
