# lib/db

Connection/RLS/persistence primitives shared by every job-strategist
entrypoint (run-pipeline, run-coach, run-case-study, run-clustering).

## Files

- `pg.ts` -- Postgres connection pool singleton for the Strategist analysis
  K8s Job (small max pool, no client TLS -- pgbouncer handles it).
- `rls.ts` -- row-level-security helper for writes against platform RDS
  tables that carry per-user RLS (resumes, job_applications, pipeline_runs);
  sets the `app.current_user_id` GUC inside the same transaction as the write.
- `pipeline-runs.ts` -- helpers for the `pipeline_runs` status table and the
  strategist-specific persistence (job_applications, resumes).

## Invariant

Every write against a per-user RLS table sets `app.current_user_id` in the
SAME transaction as the write, via `set_config(..., true)` (never a
parameterised `SET LOCAL`). No file here bypasses that contract.

## Adding a file here

Add to `db/` only if the file is a connection, RLS, or persistence primitive
consumed by more than one entrypoint. Domain logic that happens to touch a
table (e.g. a repository scoped to one concept) belongs in that concept's
domain folder instead -- see `leadership-principles-repository.ts` in
`coach/` for the precedent.
