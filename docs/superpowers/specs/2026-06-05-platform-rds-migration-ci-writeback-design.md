# Platform-RDS migration auto-deploy via CI direct-apply (design)

**Date:** 2026-06-05 (pivoted same day)
**Status:** Design — approved (Option A)
**Repos:** ai-applications (workflow) + kubernetes-bootstrap (revert #109)
**Scope:** Make new platform-rds-bootstrap migration images auto-apply to dev — the `deploy-platform-rds-bootstrap` workflow runs the migration Job directly via kubectl after pushing the image. Dev now; prod-ready pattern, prod not auto-enabled.

## 0. Pivot note (B → A)

This started as **Option B (CI git-writeback)** — ai-applications CI would commit the new tag into the kubernetes-bootstrap chart, and ArgoCD's PostSync hook would apply it. B was implemented and merged (#138) but **failed at runtime**: the writeback's `git push` to kubernetes-bootstrap returned `403 — Permission denied to github-actions[bot]` because the default `GITHUB_TOKEN` is scoped to ai-applications only (a cross-repo deploy key would have been required). That cross-repo write — ai-applications reaching into kubernetes-bootstrap — was also the wrong coupling: **migrations are imperative, not desired-state**, so wedging them through GitOps (the PostSync-hook + pinned-tag hack) is what created the whole problem. We pivoted to **Option A (CI direct-apply)**: ai-applications CI applies its own migration via kubectl. No cross-repo write, no new secret.

## 1. Why (root cause recap)

The migration runner is an **ArgoCD PostSync hook Job** whose image is the Helm value `bootstrap.image.tag` in kubernetes-bootstrap, manually pinned. Nothing bumps it on a new migration → no git drift → ArgoCD never re-syncs → migrations never reach dev (live tag was `c0e075f0`, ~32 behind). ArgoCD reconciles kubernetes-bootstrap-git→cluster; it has no knowledge of a new ECR image built by ai-applications. Image Updater (PR #109) can't bridge that gap either — it needs a live workload to read the current tag from, and the bootstrap image only ever runs on an ephemeral hook Job (verified live: it silently skips). So the bridge from "ai-applications built an image" to "migration applied" must be explicit.

## 2. Decision (Option A — direct-apply)

- **Mechanism:** the `deploy-platform-rds-bootstrap` workflow, after the `push` job, runs the **existing break-glass on-demand Job** (`applications/platform-rds-bootstrap/k8s/bootstrap-job.yaml`) directly via `kubectl create`, using the image it just published to SSM. Waits for completion; **fails the run** if the Job doesn't complete (halts = red CI).
- **No cross-repo write, no new secret.** Reuses the `aws eks update-kubeconfig` + kubectl pattern already in `_build-push-image.yml` (same `AWS_OIDC_ROLE`).
- **ArgoCD scope unchanged:** ArgoCD keeps owning everything declarative (pgbouncer, workloads). Migrations stop pretending to be desired-state.
- **#109 Image Updater annotations removed** (kubernetes-bootstrap PR #110) — they were inert.
- **PostSync hook:** left in place as a manual/idempotent fallback; not the primary path anymore. (Disabling it is a deliberate later follow-up.)
- **Scope:** dev now; the same job extends to prod deliberately later.

## 3. Architecture

New `apply-migrations` job in `.github/workflows/deploy-platform-rds-bootstrap.yml` (`needs: [push]`, dev-only trigger guards, `environment: development`, `id-token: write`):
1. Checkout (for the manifest) + `configure-aws` with `AWS_OIDC_ROLE`.
2. `aws eks update-kubeconfig --name k8s-eks-development`.
3. Resolve the image from SSM `/k8s/development/job-images/platform-rds-bootstrap` (what the push job just published).
4. `sed` `${IMAGE}` into the on-demand manifest → `kubectl create -f -` (generateName, ns `platform`, SA `platform-rds-bootstrap-sa`, connects directly to RDS).
5. Stream the Job logs; `kubectl wait --for=condition=complete --timeout=300s`. Complete → exit 0; else dump describe + logs → exit 1.

`deploy-marker.needs` includes `apply-migrations`.

## 4. Components

**ai-applications**
- `.github/workflows/deploy-platform-rds-bootstrap.yml` — `apply-migrations` job (replaces the reverted writeback job).
- Reuses `applications/platform-rds-bootstrap/k8s/bootstrap-job.yaml` (the existing on-demand manifest) — no change.

**kubernetes-bootstrap** (PR #110, already open)
- `argocd-apps/eks/development/platform-rds.yaml` — remove the inert #109 Image Updater annotations.
- `charts/platform-rds/chart/values-development.yaml` — comment updated.

**Auth:** none new. The `AWS_OIDC_ROLE` already does `update-kubeconfig` + kubectl in `_build-push-image.yml`. One thing to verify at first run: the role's k8s RBAC permits `create job` in the `platform` namespace — if denied, that's a small k8s RBAC/access-entry grant in kubernetes-bootstrap (NOT a cross-repo secret), and it surfaces as red CI.

## 5. Data flow (after this change)

```
ai-applications: migration merged to develop
  → deploy-platform-rds-bootstrap: build → push image (<sha>-r<n>) → publish SSM
  → apply-migrations job: update-kubeconfig → read SSM image
     → kubectl create on-demand bootstrap Job (platform ns) → it applies DDL + every
       numbered migration idempotently against RDS → wait complete
  → green (applied) / red (halt, with logs)
```

ArgoCD is not involved in the migration path. No tag bump, no cross-repo push, no secret.

## 6. Error handling

- **Migration halts** (non-idempotent SQL / ledger checksum) → the Job doesn't reach `complete` → `kubectl wait` times out → job describe + logs dumped → **red CI**. Fix idempotency in `applications/platform-rds-bootstrap/migrations/` and re-run.
- **k8s RBAC denies create-job in platform** → red CI on `kubectl create`; grant the role create-job in `platform` (kubernetes-bootstrap access config). One-time.
- **Idempotent + safe to re-run:** the bootstrap applies `CREATE … IF NOT EXISTS` + a ledger, so re-running (or the PostSync hook also running) is harmless.
- **No silent staleness:** unlike a missed tag bump, a failed apply is a red deploy, not an invisible lag.

## 7. Testing / validation

- **Workflow lint:** actionlint (CI "Lint Workflows").
- **End-to-end:** trigger `deploy-platform-rds-bootstrap` (workflow_dispatch or a migration merge) → the `apply-migrations` job creates the Job, streams logs, and goes green → confirm a migration marker in dev (`SELECT count(*) FROM system_design_concerns` = 14, or the newest migration's table) via the tucaken-smoke MCP `smoke_sql`.

## 8. Out of scope / follow-ups

- **Prod** (`values-production.yaml` / `platform-rds-production.yaml`): the same `apply-migrations` step against the prod cluster, deliberately enabled later.
- **Disabling the PostSync hook** (now redundant) — optional later cleanup; harmless to leave (idempotent).
- Fixing any specific non-idempotent migration is ai-applications migrations work, surfaced by a red apply.

## 9. Reconciliation with #109

PR #109 (Image Updater) is merged but inert. kubernetes-bootstrap PR #110 removes those annotations. With Option A, the deploy path doesn't touch kubernetes-bootstrap git at all — the only kubernetes-bootstrap change is the #110 cleanup.
