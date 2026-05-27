---
title: Per-transaction RLS via SET LOCAL
type: pattern
tags: [architecture, postgres, rls, security, multi-tenancy, transactions]
sources:
  - applications/shared/src/rds/implementations/RdsUserProfileRollupRepository.ts
  - applications/shared/src/rds/implementations/RdsCareerHistoryReadRepository.ts
  - applications/chatbot-authenticated/src/session.ts
  - applications/ingestion/src/repositories/RepositoryProfileRepository.ts
created: 2026-05-27
updated: 2026-05-27
---

## Intent

Bind every user-scoped database query to a specific user id at the
Postgres session-variable level so that Row-Level Security policies
filter correctly — without trusting the application's `WHERE user_id
= …` clauses to be present on every query. The pattern uses
PostgreSQL's `SET LOCAL` to make the binding **transaction-scoped**,
guaranteeing it cannot leak across connections in the pool.

## When to apply

**Use this pattern when:**

- The target table has an RLS policy filtering by
  `current_setting('app.current_user_id')::uuid = user_id`.
- The application is multi-tenant and a per-call user identity is
  the unit of isolation.
- The persistence layer uses **connection pooling** (i.e. every
  modern Postgres app) — without `SET LOCAL`'s transaction scope,
  a stray query on a recycled connection could see a previous
  user's session variable.

**Do not apply when:**

- The table is **global reference data** (e.g. the platform's
  `technology_ontology` and `technology_aliases` tables). The
  source file says so explicitly:
  *"Reads the global technology ontology + aliases. Reference data
  is not user-scoped, so no RLS / set_config needed"*
  ([applications/shared/src/rds/implementations/TechnologyOntologyRepository.ts:5-7](../../applications/shared/src/rds/implementations/TechnologyOntologyRepository.ts#L5-L7)).
- A connection is held by a job for its entire lifetime and the
  user identity is fixed (in which case `SET SESSION` is simpler).
  All of this codebase's pool consumers prefer `SET LOCAL` for
  consistency.

## Structure

```mermaid
sequenceDiagram
    participant App as Caller<br/>(repository method)
    participant Pool as pg.Pool
    participant Client as pg.PoolClient
    participant PG as Aurora Postgres<br/>(RLS policy active)
    App->>Pool: pool.connect()
    Pool-->>App: client (possibly recycled)
    App->>Client: BEGIN
    App->>Client: SELECT set_config('app.current_user_id', $1, true)
    Note over Client,PG: transaction-scoped<br/>(true = local)
    App->>Client: SELECT … FROM user_scoped_table
    PG-->>Client: rows filtered by RLS policy
    App->>Client: COMMIT
    App->>Pool: client.release()
    Note over Pool: connection returns to pool;<br/>SET LOCAL value is gone
```

### Two equivalent invocations

The codebase uses two forms; both are correct:

**Function form** (preferred, dominant):

```ts
await client.query(
    `SELECT set_config('app.current_user_id', $1, true)`,
    [userId],
);
```

Used by every `Rds<X>Repository` under
[applications/shared/src/rds/implementations/](../../applications/shared/src/rds/implementations/)
and by the ingestion repositories under
[applications/ingestion/src/repositories/](../../applications/ingestion/src/repositories/).
The third argument `true` is the **`is_local` flag** — restricts the
setting to the current transaction.

**Statement form** (used in chatbot-authenticated session.ts):

```ts
await client.query('SET LOCAL app.current_user_id = $1', [userId]);
```

Equivalent behaviour. The function form parameterises cleanly with
`pg`'s `[userId]` bindings; the statement form is more readable but
some `SET LOCAL` syntax variants don't accept positional parameters
under all `pg` driver versions, hence the function form's dominance.

### Why `SET LOCAL` and not `SET`

A `pg.Pool` recycles connections. A query that runs
`SET app.current_user_id = '<user-A>'` on connection #5, then
returns it to the pool, leaves the variable in place. The next
caller to grab connection #5 — possibly serving a different user —
inherits user A's session variable. Without an intervening `RESET`,
**any RLS query on that connection filters as user A**.

`SET LOCAL` scopes the setting to the **current transaction**.
`COMMIT` (or `ROLLBACK`) discards the value. The connection
returns to the pool clean. The pattern is non-negotiable for any
RLS-protected query in a pooled environment.

### The full scaffold

Every user-scoped query follows this shape
([RdsUserProfileRollupRepository.ts:18-50](../../applications/shared/src/rds/implementations/RdsUserProfileRollupRepository.ts#L18-L50)):

```ts
const client = await this.pool.connect();
try {
    await client.query('BEGIN');
    await client.query(
        `SELECT set_config('app.current_user_id', $1, true)`,
        [userId],
    );
    // … one or more user-scoped queries …
    await client.query('COMMIT');
} catch (err) {
    // Best-effort: do not shadow the original error if ROLLBACK fails.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
} finally {
    client.release();
}
```

Three load-bearing details:

1. **`BEGIN` before `SET LOCAL`.** `SET LOCAL` only works inside an
   explicit transaction. Outside a transaction, Postgres treats
   each statement as its own implicit transaction that auto-commits
   — the `SET LOCAL` would apply only to itself.
2. **`ROLLBACK.catch(() => {})`.** If the original query throws,
   the ROLLBACK should not shadow the original error. The pattern
   swallows ROLLBACK failures and re-throws the original.
3. **`client.release()` in `finally`.** Pool connections must
   return to the pool whether the transaction succeeded or failed.

## Implementation in this codebase

| Caller | File |
| :- | :- |
| `RdsUserProfileRollupRepository.listProfilesForRollup` | [RdsUserProfileRollupRepository.ts:18-50](../../applications/shared/src/rds/implementations/RdsUserProfileRollupRepository.ts#L18-L50) |
| `RdsUserProfileRollupRepository.upsert` | [RdsUserProfileRollupRepository.ts:69+](../../applications/shared/src/rds/implementations/RdsUserProfileRollupRepository.ts#L69) |
| `RdsCareerHistoryReadRepository` | [RdsCareerHistoryReadRepository.ts:19](../../applications/shared/src/rds/implementations/RdsCareerHistoryReadRepository.ts#L19) |
| `RdsDiagnosticInputsReadRepository` | [RdsDiagnosticInputsReadRepository.ts:17](../../applications/shared/src/rds/implementations/RdsDiagnosticInputsReadRepository.ts#L17) |
| `RepositoryProfileRepository` (3 methods) | [RepositoryProfileRepository.ts:35,104,131](../../applications/ingestion/src/repositories/RepositoryProfileRepository.ts) |
| `RepositoryProfileEmbeddingsRepository` | [RepositoryProfileEmbeddingsRepository.ts:26](../../applications/ingestion/src/repositories/RepositoryProfileEmbeddingsRepository.ts#L26) |
| `PgVectorRetriever.queryProfileLayer` | [PgVectorRetriever.ts:74](../../applications/shared/src/retrieval/implementations/PgVectorRetriever.ts#L74) |
| `chatbot-authenticated` session validation/creation | [session.ts:7](../../applications/chatbot-authenticated/src/session.ts#L7) |

10+ call sites across 8 distinct files. Test files inspect for the
`set_config` call as a behavioural assertion
([RdsUserProfileRollupRepository.test.ts:37](../../applications/shared/src/rds/implementations/RdsUserProfileRollupRepository.test.ts#L37)).

## Variants

### Read-vs-write symmetry

Both read paths (`listProfilesForRollup`, `getRollup`,
`queryProfileLayer`) and write paths (`upsert`,
`saveProfile`) follow the same scaffold. The `is_local = true` arg
is identical; the surrounding `BEGIN` / `COMMIT` is identical. No
asymmetry between read and write transactions.

### Test-time bypass

Tests do not need to set up real RLS. The mock `pg.Client` simply
records the SQL strings and the test asserts that `set_config`
was called with the expected `userId`. Example:

```ts
const cfg = client.calls.find(c => c.sql.includes('set_config'));
expect(cfg.params).toEqual([userId, true]);
```

The pattern asserts the **intent** (set_config was called) without
needing a Postgres engine in the test bundle.

## Deeper detail

- [docs/patterns/hexagonal-rds-architecture.md](hexagonal-rds-architecture.md)
  — the broader interfaces-vs-implementations pattern this is
  embedded in. This per-transaction-RLS pattern lives inside every
  `Rds<X>Repository` adapter.
- [docs/concepts/bedrock-rag-surface.md](../concepts/bedrock-rag-surface.md)
  — the `chatbot-authenticated` Lambda uses this pattern for the
  `chat_sessions` table; same scaffold, no hexagonal abstraction
  because it's a single-service caller.
- (planned) docs/concepts/postgres-rls-policies.md — what the
  actual policies look like on `users`, `repository_profiles`,
  `chat_sessions`, etc. Migration 003 onwards.

## Related concepts

- [docs/concepts/profile-synthesis-chain.md](../concepts/profile-synthesis-chain.md)
  — the largest single consumer of this pattern (the synthesis
  chain reads/writes user-scoped data through 4 repositories, each
  using the scaffold).

<!--
Evidence trail (auto-generated):
- Source: applications/shared/src/rds/implementations/RdsUserProfileRollupRepository.ts (lines 18-50, 69, 125 on 2026-05-27)
- Source: applications/shared/src/rds/implementations/RdsCareerHistoryReadRepository.ts (line 19 on 2026-05-27)
- Source: applications/shared/src/rds/implementations/RdsDiagnosticInputsReadRepository.ts (line 17 on 2026-05-27)
- Source: applications/shared/src/rds/implementations/TechnologyOntologyRepository.ts (lines 5-7 on 2026-05-27)
- Source: applications/chatbot-authenticated/src/session.ts (line 7 on 2026-05-27)
- Source: applications/ingestion/src/repositories/RepositoryProfileRepository.ts (lines 35, 104, 131 on 2026-05-27)
- Source: applications/ingestion/src/repositories/RepositoryProfileEmbeddingsRepository.ts (line 26 on 2026-05-27)
-->
