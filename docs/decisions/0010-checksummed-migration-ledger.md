---
title: Checksummed migration ledger
type: decision
tags: [postgres, migrations, bootstrap, idempotent, checksum, schema, safety]
sources:
  - applications/platform-rds-bootstrap/src/bootstrap.ts
  - applications/platform-rds-bootstrap/src/bootstrap-ledger.test.ts
created: 2026-06-16
updated: 2026-06-16
---

## Status

Accepted — implemented. Supersedes
[ADR 0009](0009-idempotent-re-apply-bootstrap.md) (the prior no-ledger,
re-apply-every-boot model). The runner now tracks applied migrations in a
`schema_migrations` ledger keyed by name + SHA-256 checksum
([bootstrap.ts](../../applications/platform-rds-bootstrap/src/bootstrap.ts)).

## Context

The previous bootstrap re-applied every migration on every boot with no ledger
(ADR 0009). That diverged from the repo rule ("Numbered SQL migration runners must
use a ledger with checksums and must reject changed historical migrations") and
carried real risk: a non-idempotent migration re-ran on every boot and could halt
the whole bootstrap, and an edited historical migration was re-applied undetected.

## Decision

Add a `schema_migrations(name PRIMARY KEY, checksum, applied_at)` ledger and make
the runner apply each migration **exactly once**
([SCHEMA_MIGRATIONS_DDL + applyMigrations](../../applications/platform-rds-bootstrap/src/bootstrap.ts)):

- **Never applied** → apply, then record `(name, checksum)`.
- **Applied, same checksum** → skip.
- **Applied, different checksum** → **reject** (the historical migration was edited;
  add a new migration instead).

The decision is a pure function `decideMigration(current, recorded)`, and the DB
plumbing reads through a small `QueryClient` interface so the whole flow is
unit-tested with a mock client (no database).

### Adoption — baseline on an existing database

Introducing a ledger on a database the old runner already populated must **not**
re-run the historical migrations (some are non-idempotent and would error). So on
the first ledgered run, when `schema_migrations` is absent but application schema
already exists, the runner **baselines** — records every current migration as
applied **without running it**. Existing-vs-fresh is detected by checking the
`users` table sentinel *before* the base DDL runs. A truly fresh DB (no schema)
applies every migration normally.

## Consequences

**Enabled:**

- Migrations run exactly once — safe to add data-only migrations (backfills,
  one-shot `UPDATE`s) that the re-apply model could never run safely.
- Edited history is caught with a clear error instead of silently re-applied.
- Boot cost no longer scales with the migration count (already-applied files are
  skipped after a cheap ledger read).

**New problems / accepted residual:**

- A trivial reformat of an already-applied migration now **fails** the bootstrap
  (checksum mismatch). That is intentional — historical migrations are immutable —
  but contributors must add a new migration rather than touch an old one.
- The ledger is now state that must be backed up with the DB (it is, as an ordinary
  table) and baselined correctly on first adoption (handled by the sentinel check).

## Alternatives considered

### Keep the re-apply model (ADR 0009)

Rejected — it is the very risk this ADR removes.

### Adopt a third-party tool (node-pg-migrate, Flyway)

Brings a ledger out of the box but a heavier dependency and a different file format
for the 80 existing migrations. The in-house ledger is a contained change to one
file plus one table, reusing the existing numbered `.sql` files unchanged.

<!--
Evidence trail (auto-generated):
- Source: applications/platform-rds-bootstrap/src/bootstrap.ts (authored on 2026-06-16: SCHEMA_MIGRATIONS_DDL, checksum, decideMigration, applyMigrations)
- Source: applications/platform-rds-bootstrap/src/bootstrap-ledger.test.ts (9 tests: apply/skip/reject/baseline, 2026-06-16)
-->
