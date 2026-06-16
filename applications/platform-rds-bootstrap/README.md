# platform-rds-bootstrap

Idempotent DDL + migration runner for the platform RDS (`tucaken` DB). Builds
into a container whose entrypoint (`dist/index.js` → `runBootstrap`) connects
**directly** to RDS and applies, in lexical order:

1. the base DDL in [`src/bootstrap.ts`](src/bootstrap.ts) (`users`, `repositories`,
   `pipeline_runs`, the `tucaken_app` role, the `set_updated_at` trigger fn, …),
2. every numbered file in [`migrations/`](migrations/).

Adding a migration = drop a new `NNN_*.sql` in `migrations/`; it ships in the
image and applies on the next bootstrap.

## Migration ledger

The runner tracks applied migrations in a checksummed `schema_migrations`
ledger (`name` PRIMARY KEY + SHA-256 `checksum`), so each migration runs
**exactly once** — see [ADR 0010](../../docs/decisions/0010-checksummed-migration-ledger.md).
Per migration, `applyMigrations` either:

- **applies** it (never seen before) and records `(name, checksum)`,
- **skips** it (already applied, same checksum), or
- **rejects** it (already applied, **different** checksum).

> **Historical migrations are immutable.** Editing a migration that has already
> been applied changes its checksum and **fails the bootstrap**. To change
> behaviour, add a *new* `NNN_*.sql` — never edit a shipped one. (Migrations are
> still written idempotently — `CREATE … IF NOT EXISTS`, etc. — as defence in
> depth.)

**Adoption / baseline:** the first ledgered run against a database the old
re-apply runner already populated **baselines** — it records every current
migration as applied *without re-running it* (a non-idempotent historical
migration must never re-run). Existing-vs-fresh is detected via a `users`
sentinel before the base DDL. A truly fresh DB applies everything normally.

## How it runs in-cluster (canonical path)

The runner is deployed by the **`kubernetes-bootstrap`** GitOps repo, not from
here:

- **Chart:** `charts/platform-rds/chart` → `templates/bootstrap-job.yaml`
- **ArgoCD app:** `platform-rds-eks-development` (namespace `argocd`)
- **Hook:** the Job carries `argocd.argoproj.io/hook: PostSync` +
  `hook-delete-policy: BeforeHookCreation`, so on every sync ArgoCD deletes the
  old completed Job and creates a fresh one.
- **Namespace:** `platform`. **ServiceAccount:** `platform-rds-bootstrap-sa`.
- **Env:** from secrets `platform-rds-credentials` + `platform-rds-config`
  (`PGHOST` → RDS endpoint directly, **not** PgBouncer; PgBouncer may not be up
  on first deploy).
- **Image:** `771826808455.dkr.ecr.eu-west-1.amazonaws.com/platform-rds-bootstrap:<tag>`,
  where `<tag>` is pinned in `values-<env>.yaml`.

## CI: image build

[`.github/workflows/deploy-platform-rds-bootstrap.yml`](../../.github/workflows/deploy-platform-rds-bootstrap.yml)
runs on every push to `develop` that touches `applications/platform-rds-bootstrap/**`:
builds the image, tags it `<git-sha>-r<run_attempt>`, pushes to ECR, and
publishes the URI to SSM `/k8s/development/job-images/platform-rds-bootstrap`.

## ⚠️ Deploying migrations — the gotcha

Building the image does **not** run the migrations. The PostSync Job only ever
runs the tag **pinned** in `kubernetes-bootstrap/.../values-<env>.yaml`. ArgoCD
Image Updater is **not** wired to this chart yet, so the tag is bumped
**manually**. If you merge a migration but never bump the tag, the new SQL sits
in ECR while the cluster keeps re-running an old image — the DB silently lags.

> This is exactly what happened with migrations 025–043: the dev tag was stuck
> at the migration-024-era image (`c0e075f0…`).

### Permanent fix — bump the pinned tag (do this for every migration)

1. Merge the migration to `develop`; let CI build + push the image.
2. Grab the freshly published image:
   ```bash
   aws ssm get-parameter \
     --name /k8s/development/job-images/platform-rds-bootstrap \
     --profile dev-account --query Parameter.Value --output text
   ```
3. In **`kubernetes-bootstrap`**, set `bootstrap.image.tag` in
   `charts/platform-rds/chart/values-development.yaml` to that tag, commit, push.
4. ArgoCD auto-syncs → PostSync Job runs the new image → migrations apply.

(A lasting automation would wire ArgoCD Image Updater to this chart so the tag
bumps itself; until then, step 3 is manual and mandatory.)

### Break-glass — apply now without a GitOps round-trip

When you need the schema applied immediately (or want to verify an image before
pinning it), run the latest image as a one-shot Job via
[`k8s/bootstrap-job.yaml`](k8s/bootstrap-job.yaml):

```bash
AWS_PROFILE=dev-account just db-bootstrap-run
# or pin a specific image:
IMAGE=771826808455.dkr.ecr.eu-west-1.amazonaws.com/platform-rds-bootstrap:<tag> \
  AWS_PROFILE=dev-account just db-bootstrap-run
```

The on-demand Job uses `generateName: platform-rds-bootstrap-ondemand-`, so it
never collides with or looks like drift against the ArgoCD-managed
`platform-rds-bootstrap` Job. It is **not** a substitute for the tag bump —
always do the permanent fix too, or the next ArgoCD sync re-runs the stale tag
(harmless, since migrations are idempotent, but it means the GitOps source of
truth still lies about what's deployed).

## Rollback / expand-contract

See [ROLLBACK.md](ROLLBACK.md). All migrations must follow expand/contract so a
re-run of any prior image is safe.

## Local testing

Unit tests cover the ledger logic (apply / skip / reject / baseline) with a mock
client — no database needed:

```bash
yarn workspace @bedrock/platform-rds-bootstrap test
```

End-to-end migration test against a real Postgres:

```bash
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres PGSSL=disable \
  just test-projects-migration
```
