# Platform-RDS migration auto-deploy via CI git-writeback (design)

**Date:** 2026-06-05
**Status:** Design — pending review
**Repos:** ai-applications (workflow) + kubernetes-bootstrap (revert #109, values comment)
**Scope:** Make new platform-rds-bootstrap migration images auto-apply to dev — the `deploy-platform-rds-bootstrap` workflow git-writes the new tag into the kubernetes-bootstrap chart, so ArgoCD's PostSync hook applies the migrations. Dev now; prod-ready pattern, prod not auto-enabled.

## 1. Why (root cause recap)

The platform-rds migration runner is an **ArgoCD PostSync hook Job** whose image is the Helm value `bootstrap.image.tag` in `kubernetes-bootstrap/charts/platform-rds/chart/values-development.yaml`. That tag is **manually pinned**; nothing bumps it on a new migration → no git drift → ArgoCD never re-syncs → migrations never reach dev (live tag was `c0e075f0`, ~32 behind).

The first attempt (PR #109, ArgoCD Image Updater) **does not work** for this case: Image Updater determines the "current" image from a **live workload** matching the image, but the bootstrap image only ever runs on an **ephemeral PostSync hook Job** (deleted via `BeforeHookCreation`). With no live workload, Image Updater silently skips it (verified live: `images_considered=4, updated=1` but the bootstrap tag never changed). So Image Updater is removed and replaced by deterministic CI git-writeback.

## 2. Decisions (locked in brainstorming)

- **Mechanism:** CI git-writeback — the ai-applications `deploy-platform-rds-bootstrap` workflow commits the new tag into the kubernetes-bootstrap chart on `main`; ArgoCD's existing PostSync hook stays the applier (GitOps-pure).
- **PostSync hook:** kept (it is the applier). The ineffective **#109 Image Updater annotation is removed**.
- **Auth:** an **SSH deploy key** with write access on kubernetes-bootstrap, private key stored as the ai-applications Actions secret `KUBERNETES_BOOTSTRAP_DEPLOY_KEY`. Mirrors the existing argocd-image-updater SSH writeback key.
- **Scope:** dev (`values-development.yaml`) now; the same step extends to `values-production.yaml` deliberately later.

## 3. Architecture

Add a `writeback` job to `.github/workflows/deploy-platform-rds-bootstrap.yml` (ai-applications), running **after** the existing `push` job (`needs: [push]`, same dev-only trigger guards). It:
1. Checks out **kubernetes-bootstrap** `main` using the deploy key (`actions/checkout` with `ssh-key: ${{ secrets.KUBERNETES_BOOTSTRAP_DEPLOY_KEY }}` + `repository: Nelson-Lamounier/kubernetes-bootstrap`).
2. Sets `bootstrap.image.tag` in `charts/platform-rds/chart/values-development.yaml` to the workflow's `IMAGE_TAG` (`${{ github.sha }}-r${{ github.run_attempt }}` — the exact tag just built/pushed).
3. If the tag changed, commits + pushes to `main` with message `chore(platform-rds): bump bootstrap image to <tag> [skip ci]`. If unchanged, no-op.

ArgoCD's automated sync (already enabled on `platform-rds-eks-development`) detects the git change → runs the PostSync hook with the new image → idempotent migrations apply.

## 4. Components

**ai-applications**
- `.github/workflows/deploy-platform-rds-bootstrap.yml` — new `writeback` job (checkout kubernetes-bootstrap via deploy key → yq/sed the tag → commit+push to main, idempotent, `[skip ci]`). Uses `IMAGE_TAG` (already defined at workflow `env`).

**kubernetes-bootstrap**
- `argocd-apps/eks/development/platform-rds.yaml` — **remove** the 8 Image Updater annotations added in #109 (revert to just `sync-wave` + `description`).
- `charts/platform-rds/chart/values-development.yaml` — update the comment: tag is **auto-bumped by the ai-applications `deploy-platform-rds-bootstrap` workflow** (CI git-writeback); do not hand-edit.

**Auth (user-provisioned, one-time)**
- Generate an SSH keypair; add the **public** key as a write-enabled **Deploy Key** on kubernetes-bootstrap; store the **private** key as the ai-applications Actions secret `KUBERNETES_BOOTSTRAP_DEPLOY_KEY`.

## 5. Data flow (after this change)

```
ai-applications: migration merged to develop
  → deploy-platform-rds-bootstrap workflow: build → push image (<sha>-r<n>) → publish SSM
  → writeback job: checkout kubernetes-bootstrap (deploy key) → set bootstrap.image.tag=<sha>-r<n>
     in values-development.yaml → commit + push main ([skip ci], idempotent)
  → ArgoCD auto-sync (drift on main) → PostSync hook Job runs new image → migrations apply (idempotent)
```

## 6. Error handling

- **Deploy-key missing / push rejected** → the writeback step fails → **red CI** (visible); image is still in ECR/SSM, so the break-glass on-demand Job (`just db-bootstrap-run`) remains the manual fallback. No silent failure.
- **Tag unchanged** (re-run) → no commit; idempotent.
- **Migration hook halts** → ArgoCD app Degraded + retries (existing behavior); break-glass fallback. Fix idempotency in `applications/platform-rds-bootstrap/migrations/`.
- **Loop safety:** the writeback targets a *different* repo (kubernetes-bootstrap), so no ai-applications CI loop; `[skip ci]` guards any kubernetes-bootstrap CI on values changes.

## 7. Testing / validation

- **Dry-run:** run the writeback step logic locally against a checkout — confirm it computes the correct tag and would change `bootstrap.image.tag` (and is a no-op when unchanged).
- **Workflow lint:** `actionlint` on the edited workflow (CI already runs Lint Workflows).
- **End-to-end:** trigger `deploy-platform-rds-bootstrap` (workflow_dispatch or a real migration merge) → confirm `bootstrap.image.tag` bumped on kubernetes-bootstrap `main` → ArgoCD syncs → PostSync hook applies → a new migration's marker exists in dev (e.g. `SELECT count(*) FROM system_design_concerns` = 14, or the next migration's table). The tucaken-smoke MCP `smoke_sql` is the verification tool.

## 8. Out of scope / follow-ups

- **Prod** (`values-production.yaml` + `platform-rds-production.yaml`): same writeback step, gated/enabled deliberately later.
- Fixing any specific non-idempotent migration is ai-applications migrations work, surfaced if the hook halts.
- The #109 revert is part of this change (kubernetes-bootstrap side).

## 9. Reconciliation with #109

PR #109 (Image Updater annotations) is merged on kubernetes-bootstrap `main` but inert (can't track a hook-only image). This change **removes those annotations** so the only mechanism is CI git-writeback — no two-mechanism ambiguity.
