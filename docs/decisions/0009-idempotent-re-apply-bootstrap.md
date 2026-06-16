---
title: Idempotent re-apply bootstrap (no migration ledger)
type: decision
tags: [postgres, migrations, bootstrap, idempotent, schema, risk]
sources:
  - applications/platform-rds-bootstrap/src/bootstrap.ts
  - applications/platform-rds-bootstrap/migrations/030_projects.sql
  - applications/platform-rds-bootstrap/migrations/044_enable_project_features.sql
created: 2026-06-16
updated: 2026-06-16
---

## Status

**Superseded by [ADR 0010 — checksummed migration ledger](0010-checksummed-migration-ledger.md).**
This ADR records the original no-ledger, re-apply-every-boot model and why it was a
risk (it diverged from the repository rule requiring a checksummed ledger). The
remediation described below has been implemented — the runner now uses a
`schema_migrations` ledger. Kept for the historical record.

## Context

The `platform-rds-bootstrap` Job applies a base DDL block then every `.sql` in
`migrations/`, sorted lexically, each via `client.query(sql)` — with **no
`schema_migrations` table and no checksum tracking**
([bootstrap.ts:327-330](../../applications/platform-rds-bootstrap/src/bootstrap.ts#L327-L330)).
The model is recorded in migration comments as
"re-applies every .sql on every bootstrap (no schema_migrations tracking table)"
([030_projects.sql:22](../../applications/platform-rds-bootstrap/migrations/030_projects.sql#L22),
[044_enable_project_features.sql:10](../../applications/platform-rds-bootstrap/migrations/044_enable_project_features.sql#L10)).

The implicit decision was simplicity: no ledger to drift or repair, and a fresh DB
and an existing DB take the identical code path. Idempotence is delegated to SQL
guards (`IF NOT EXISTS`, `OR REPLACE`, `DROP POLICY IF EXISTS` + `CREATE POLICY`,
`DO $$ … END$$`).

## Decision

Apply the base DDL and **re-run every migration file on every bootstrap**, relying
on each file being idempotent. Do not track applied migrations or their checksums.

## Consequences

**Enabled:**

- No ledger state to get out of sync, back up, or repair.
- Fresh DB and existing DB use one code path; the Job is safe to re-run.

**New problems / accepted risk:**

- **Non-idempotent migrations are dangerous.** Any file whose effect is not fully
  guarded (a data backfill, an unguarded `ALTER`, a one-shot `UPDATE`) re-runs on
  every boot. A migration that errors on re-run **halts the whole bootstrap** —
  this has occurred for historically non-idempotent migrations, blocking deploys
  until the file was made re-runnable.
- **No protection against edited history.** Changing an already-shipped migration
  is undetectable — the rule's "reject changed historical migrations" guarantee is
  absent; the edited file simply re-applies.
- **Boot cost grows with file count.** Re-running 80+ files every boot is linear in
  the migration count.

## Recommended remediation (to satisfy the rule)

Add a checksummed `schema_migrations` ledger to the runner:

1. On boot, for each migration file compute a checksum (e.g. SHA-256 of the SQL).
2. If the name is in the ledger with the **same** checksum → skip.
3. If in the ledger with a **different** checksum → **error** (reject changed
   historical migration).
4. If not in the ledger → apply, then record `(name, checksum, applied_at)`.
5. **Baseline** the 80 existing migrations as already-applied when introducing the
   ledger (the live DB already has them), so they are not re-run.

Data-only migrations would then run exactly once, and edits to shipped migrations
would be caught instead of silently re-applied. This is a contained change to
`bootstrap.ts` plus one ledger table.

## Alternatives considered

### A standard migration tool (node-pg-migrate, Flyway, etc.)

Brings a ledger + checksums out of the box. Rejected historically in favour of the
in-house re-apply runner's simplicity; reconsidering it (or the minimal ledger
above) is the remediation path.

<!--
Evidence trail (auto-generated):
- Source: applications/platform-rds-bootstrap/src/bootstrap.ts (read on 2026-06-16, lines 295-335)
- Source: applications/platform-rds-bootstrap/migrations/030_projects.sql:22 (read on 2026-06-16)
- Source: applications/platform-rds-bootstrap/migrations/044_enable_project_features.sql:10 (read on 2026-06-16)
- Note: diverges from the CLAUDE.md rule requiring a checksummed ledger.
-->
