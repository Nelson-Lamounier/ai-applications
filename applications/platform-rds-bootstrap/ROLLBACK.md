# Rollback & Schema-Change Safety Runbook

Scope: the `tucaken` Postgres database driven by this bootstrap Job, and the
admin-api / tucaken-app workloads that read it. Closes the §9 production-
checklist gap (no documented rollback procedure, no expand/contract rule).

## Mental model

- **App rollback is instant; schema rollback is not.** admin-api and
  tucaken-app deploy via **Argo Rollouts blue/green** — the previous
  ReplicaSet stays warm, so reverting code is one `argo rollouts undo`.
  The database has no equivalent: a dropped column is gone.
- Therefore **schema changes must be backward-compatible with the currently
  running app version at all times**, so an app rollback never meets a
  schema it cannot read.

## Expand / Contract (mandatory for every migration)

Never change a column's meaning in one step. Split across deploys:

1. **Expand** — additive only. New tables/columns are `NULL`able or have a
   safe `DEFAULT`. New code writes both old and new shape. Old code keeps
   working untouched.
2. **Migrate** — backfill data; dual-read with new shape preferred.
3. **Contract** — only after the old app version is fully retired and will
   not be rolled back to: drop the old column/table, guarded by
   `IF EXISTS` inside a `DO $$ … $$` existence check.

Conventions enforced in `migrations/*.sql`:
- Every statement uses `IF NOT EXISTS` / `IF EXISTS` or a `pg_catalog`
  existence guard (idempotent — safe to re-run).
- No destructive rename/drop in the same migration that introduces the
  replacement. Drops land in a **later** numbered migration.
- One concern per numbered file; lexical order is the apply order.

## Version tracking

`src/index.ts` records every applied migration in `schema_migrations`
(`name` PK, `applied_at`). Each migration runs once, in its own
transaction — a partial failure rolls back and is **not** recorded, so the
K8s Job's `backoffLimit` retries from a clean state. Idempotency guards
remain as defence in depth.

Inspect state:
```sql
SELECT name, applied_at FROM schema_migrations ORDER BY name;
```

## Procedures

### A. Roll back the application only (schema unchanged)
1. `kubectl -n <ns> argo rollouts undo <rollout>` (admin-api / tucaken-app).
2. Verify `argo rollouts status <rollout>` is Healthy.
   Safe whenever the live schema is a superset of what the old code reads —
   which the expand/contract rule guarantees.

### B. A migration failed mid-deploy
- The failing migration rolled back (own transaction) and is absent from
  `schema_migrations`. The DB is at the last good migration.
- Fix the `.sql`, let the bootstrap Job re-run (it resumes at the first
  pending file). Do **not** hand-edit `schema_migrations` to skip it.

### C. A bad-but-committed migration must be reverted
1. Roll the app back first (procedure A) if the new schema breaks old code.
2. Write a **new forward migration** (next number) that reverses the change
   following expand/contract — never delete or renumber an applied file.
3. Remove the bad row only if you also wrote a compensating migration:
   `DELETE FROM schema_migrations WHERE name = '0NN_bad.sql';` is a last
   resort and must be paired with a corrective migration.

### D. Catastrophic data loss
Restore from the RDS automated snapshot / PITR (AWS console or
`aws rds restore-db-instance-to-point-in-time`). Out of band of this Job;
owned by the platform-rds CDK/Crossplane definition.

## Pre-merge checklist for any schema change
- [ ] Additive only, or drop is in a later migration than its replacement.
- [ ] New columns `NULL`able or safe `DEFAULT`.
- [ ] Idempotent guards present (`IF [NOT] EXISTS`).
- [ ] Currently-deployed app version still works against the new schema.
- [ ] Indexes added for any new hot query path (see `020_query_path_indexes.sql`).
