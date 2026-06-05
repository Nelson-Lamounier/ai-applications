# Platform-RDS Migration CI Git-Writeback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-apply new platform-rds migration images to dev — the `deploy-platform-rds-bootstrap` workflow git-writes the new tag into the kubernetes-bootstrap chart, so ArgoCD's PostSync hook applies the migrations (no manual tag bump).

**Architecture:** Add a `writeback` job (after `push`) to ai-applications' `deploy-platform-rds-bootstrap.yml` that checks out kubernetes-bootstrap via an SSH deploy key, sets `bootstrap.image.tag` in `values-development.yaml` to the just-pushed `IMAGE_TAG`, and commits+pushes to `main` (idempotent, `[skip ci]`). ArgoCD auto-sync then runs the PostSync migration hook. Separately, revert the inert #109 Image Updater annotations on kubernetes-bootstrap.

**Tech Stack:** GitHub Actions, `yq` v4 (pre-installed on ubuntu-latest runners), git over SSH deploy key, ArgoCD/Helm. Two repos: ai-applications (workflow) + kubernetes-bootstrap (revert).

**Spec:** `docs/superpowers/specs/2026-06-05-platform-rds-migration-ci-writeback-design.md`

> **⚠️ PIVOTED to Option A (direct-apply).** Tasks 1/3 here (CI git-writeback job + deploy-key) are SUPERSEDED — git-writeback failed at runtime (`403` cross-repo push; the deploy-key coupling was wrong). The shipped design: an `apply-migrations` job runs the existing on-demand bootstrap Job via kubectl (no cross-repo write, no secret). See spec §0 pivot note + §2-3. Task 2 (#109 revert, kubernetes-bootstrap PR #110) and Task 4 (e2e validation) still stand.

---

## Manual prerequisite (user-provisioned, not a code task)
Generate an SSH keypair; add the **public** key as a **write-enabled Deploy Key** on `Nelson-Lamounier/kubernetes-bootstrap`; store the **private** key as the ai-applications Actions secret **`KUBERNETES_BOOTSTRAP_DEPLOY_KEY`**. The workflow's `writeback` job depends on this secret. The workflow change can merge before the secret exists (the job just fails until the secret is set).

---

## File Structure

**Modify (ai-applications):**
- `.github/workflows/deploy-platform-rds-bootstrap.yml` — add the `writeback` job; add `writeback` to `deploy-marker.needs`.

**Modify (kubernetes-bootstrap, branch off `main` in a worktree):**
- `argocd-apps/eks/development/platform-rds.yaml` — remove the 8 Image Updater annotations from #109 (revert to `sync-wave` + `description` only).
- `charts/platform-rds/chart/values-development.yaml` — update the comment: tag auto-bumped by ai-applications CI git-writeback.

---

## Task 1: Add the `writeback` job to the deploy workflow

**Files:**
- Modify: `.github/workflows/deploy-platform-rds-bootstrap.yml`

- [ ] **Step 1: Add the `writeback` job after the `push` job**

Insert this job into `jobs:` (after the `push` job, before `deploy-marker`). It uses the workflow-level `IMAGE_TAG` env (`${{ github.sha }}-r${{ github.run_attempt }}`).

```yaml
  writeback:
    name: "[PlatformRdsBootstrap] Writeback tag to kubernetes-bootstrap"
    needs: [push]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read   # writes to ANOTHER repo via the deploy key, not GITHUB_TOKEN
    steps:
      - name: Checkout kubernetes-bootstrap (main)
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          repository: Nelson-Lamounier/kubernetes-bootstrap
          ref: main
          ssh-key: ${{ secrets.KUBERNETES_BOOTSTRAP_DEPLOY_KEY }}
          path: kb
          persist-credentials: true

      - name: Bump bootstrap.image.tag in values-development.yaml
        env:
          IMAGE_TAG: ${{ env.IMAGE_TAG }}
        run: |
          set -euo pipefail
          VALUES=kb/charts/platform-rds/chart/values-development.yaml
          yq -i '.bootstrap.image.tag = strenv(IMAGE_TAG)' "$VALUES"
          echo "Set bootstrap.image.tag = ${IMAGE_TAG}"
          yq '.bootstrap.image.tag' "$VALUES"

      - name: Commit + push (idempotent)
        working-directory: kb
        env:
          IMAGE_TAG: ${{ env.IMAGE_TAG }}
        run: |
          set -euo pipefail
          git config user.name  "platform-rds-bootstrap-ci[bot]"
          git config user.email "platform-rds-bootstrap-ci@users.noreply.github.com"
          if git diff --quiet -- charts/platform-rds/chart/values-development.yaml; then
            echo "Tag already ${IMAGE_TAG} — nothing to write back."
            exit 0
          fi
          git add charts/platform-rds/chart/values-development.yaml
          git commit -m "chore(platform-rds): bump bootstrap image to ${IMAGE_TAG} [skip ci]"
          git push origin main
          echo "Wrote back bootstrap.image.tag=${IMAGE_TAG} to kubernetes-bootstrap main."
```

- [ ] **Step 2: Add `writeback` to the deploy-marker's needs**

Change `deploy-marker`'s `needs: [build, push]` to `needs: [build, push, writeback]` so the Loki marker's aggregate status reflects the writeback too. (Leave `if: always()`.)

- [ ] **Step 3: Lint the workflow**

Run (actionlint is what CI's "Lint Workflows" job uses):
```bash
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications
bash <(curl -s https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash) >/dev/null 2>&1 || true
./actionlint .github/workflows/deploy-platform-rds-bootstrap.yml 2>&1 | head -20 || echo "(if actionlint unavailable locally, rely on CI Lint Workflows)"
```
Expected: no errors. If `actionlint` can't be fetched locally, verify YAML validity instead:
`python3 -c "import yaml; d=yaml.safe_load(open('.github/workflows/deploy-platform-rds-bootstrap.yml')); assert 'writeback' in d['jobs']; assert d['jobs']['writeback']['needs']==['push']; assert 'writeback' in d['jobs']['deploy-marker']['needs']; print('OK')"`
Expected: `OK`.

- [ ] **Step 4: Dry-run the yq/idempotency logic locally** (no push)

```bash
cd /tmp && rm -rf kbtest && cp -r /Users/nelsonlamounier/Desktop/portfolio/kubernetes-bootstrap/charts/platform-rds/chart kbtest
IMAGE_TAG="testsha-r1" yq -i '.bootstrap.image.tag = strenv(IMAGE_TAG)' kbtest/values-development.yaml
yq '.bootstrap.image.tag' kbtest/values-development.yaml   # expect: testsha-r1
```
Expected: prints `testsha-r1` (confirms the yq path + write are correct against the real values file).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy-platform-rds-bootstrap.yml
git commit -m "feat(ci): writeback bootstrap image tag to kubernetes-bootstrap (auto-deploy migrations)"
```

---

## Task 2: Revert the inert #109 Image Updater annotations (kubernetes-bootstrap)

**Files (in a worktree off kubernetes-bootstrap `main`):**
- Modify: `argocd-apps/eks/development/platform-rds.yaml`
- Modify: `charts/platform-rds/chart/values-development.yaml`

- [ ] **Step 1: Create a worktree off `main`** (kubernetes-bootstrap main checkout is busy with unrelated WIP)

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/kubernetes-bootstrap
git fetch origin main -q
git worktree add .worktrees/revert-imageupdater -b chore/platform-rds-revert-imageupdater origin/main
cd .worktrees/revert-imageupdater
```

- [ ] **Step 2: Remove the 8 Image Updater annotations**

In `argocd-apps/eks/development/platform-rds.yaml`, delete the 8 `argocd-image-updater.argoproj.io/...` annotation lines added in #109, leaving only `argocd.argoproj.io/sync-wave: "7"` and `kubernetes.io/description: ...` under `metadata.annotations`.

Verify:
```bash
python3 -c "import yaml; a=yaml.safe_load(open('argocd-apps/eks/development/platform-rds.yaml'))['metadata']['annotations']; assert not any('image-updater' in k for k in a), a; assert a['argocd.argoproj.io/sync-wave']=='7'; print('OK')"
```
Expected: `OK` (no image-updater keys remain; sync-wave preserved).

- [ ] **Step 3: Update the values comment**

In `charts/platform-rds/chart/values-development.yaml`, replace the `bootstrap.image` comment with:
```yaml
    # ECR image for the DDL bootstrap / migration PostSync hook.
    # AUTO-BUMPED by the ai-applications `deploy-platform-rds-bootstrap` workflow
    # (CI git-writeback) on each new migration image; do NOT hand-edit the tag.
    # Break-glass manual apply: ai-applications `just db-bootstrap-run`.
```
Leave `repository:` and `tag:` lines as-is. Verify YAML: `python3 -c "import yaml; yaml.safe_load(open('charts/platform-rds/chart/values-development.yaml')); print('YAML OK')"` → `YAML OK`.

- [ ] **Step 4: Commit + push + PR (base `main`)**

```bash
git add argocd-apps/eks/development/platform-rds.yaml charts/platform-rds/chart/values-development.yaml
git commit -m "revert(platform-rds): drop inert Image Updater annotations; tag now CI-writeback managed"
git push -u origin chore/platform-rds-revert-imageupdater
gh pr create --base main --head chore/platform-rds-revert-imageupdater \
  --title "revert(platform-rds): Image Updater -> CI git-writeback" \
  --body "Image Updater (#109) can't track the hook-only bootstrap image (no live workload). Removing the inert annotations; the ai-applications deploy-platform-rds-bootstrap workflow now git-writes the tag (CI writeback). Spec: ai-applications docs/superpowers/specs/2026-06-05-platform-rds-migration-ci-writeback-design.md"
```

---

## Task 3: Open the ai-applications PR + sequence the rollout

- [ ] **Step 1: Push + PR (base `develop`)**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications
git push -u origin feat/platform-rds-migration-ci-writeback
gh pr create --base develop --head feat/platform-rds-migration-ci-writeback \
  --title "feat(ci): auto-deploy platform-rds migrations via git-writeback" \
  --body "Adds a writeback job to deploy-platform-rds-bootstrap: after pushing the image, it git-writes the new tag into kubernetes-bootstrap values-development.yaml (main), so ArgoCD's PostSync hook applies migrations automatically. Needs the KUBERNETES_BOOTSTRAP_DEPLOY_KEY secret (write Deploy Key on kubernetes-bootstrap). Replaces the inert Image Updater (#109; reverted in a kubernetes-bootstrap PR). Spec/plan: docs/superpowers/{specs,plans}/2026-06-05-platform-rds-migration-ci-writeback*"
```

- [ ] **Step 2: Sequencing (document in the PR / to the user)**

Merge order that avoids a window where neither mechanism works:
1. Provision the `KUBERNETES_BOOTSTRAP_DEPLOY_KEY` secret (manual prereq).
2. Merge the ai-applications writeback PR (workflow gains the job; harmless until it next runs).
3. Merge the kubernetes-bootstrap revert PR (drops the inert annotations).
Order 2↔3 is interchangeable (the annotations were already inert). The first migration merge (or a `workflow_dispatch`) after the secret exists triggers the writeback end-to-end.

---

## Task 4: End-to-end validation (post-merge, after the secret is provisioned)

- [ ] **Step 1: Trigger the workflow**

`gh workflow run deploy-platform-rds-bootstrap.yml` (or merge a migration). Watch the `writeback` job succeed.

- [ ] **Step 2: Confirm the tag was written to kubernetes-bootstrap main**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/kubernetes-bootstrap && git fetch origin main -q
git show origin/main:charts/platform-rds/chart/values-development.yaml | grep -E "tag:"
```
Expected: `tag:` equals the latest `<sha>-r<n>` (no longer the old pin), and the commit message ends `[skip ci]`.

- [ ] **Step 3: Confirm ArgoCD synced + the hook applied**

The `platform-rds-eks-development` app should sync to the new revision; the PostSync hook runs. Validate a migration marker via the tucaken-smoke MCP:
```
smoke_sql → SELECT count(*) FROM system_design_concerns   -- expect 14 (or the newest migration's marker)
```
Expected: present. If the hook halts, ArgoCD goes Degraded — fix the migration's idempotency in ai-applications and re-run; break-glass `just db-bootstrap-run` is the manual fallback.

---

## Self-review notes
- Spec §3 (writeback job) → Task 1; §4 kubernetes-bootstrap revert + values comment → Task 2; §9 #109 reconcile → Task 2; §6 error handling (idempotent, [skip ci], red-CI on failure) → Task 1 Steps 1; §7 testing → Tasks 1/4.
- The deploy key is the one manual prereq; the workflow change is safe to merge before it exists (job fails red until then).
- `yq` v4 is pre-installed on ubuntu-latest; `strenv(IMAGE_TAG)` reads the env var as a string (avoids quoting issues).
- No application code/tests change — verification is actionlint/YAML + the local yq dry-run + the post-merge e2e.
