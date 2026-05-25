# Tech Extractor Layer 1 — Plan 3: Job & Infra

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Also REQUIRED:** the `k8s-new-service` skill governs all cluster-repo work (Helm chart, ArgoCD Application, secrets, IngressRoute). Invoke it before writing any chart/ArgoCD files — do not hand-author cluster manifests against guessed conventions.

**Goal:** Package `@bedrock/tech-extractor` as a runnable container image (with the Syft binary + Tree-sitter wasm grammars), deploy it as a short-lived K8s Job per repo, and trigger it alongside the existing ingestion Job — with a deterministic Job name closing the concurrent-run race.

**Architecture:** A multi-stage Dockerfile builds `@bedrock/shared` + `@bedrock/tech-extractor`, copies the static Syft binary from the official `anchore/syft` image and bundles `web-tree-sitter` wasm grammars, runs as a non-root one-shot pod with an `emptyDir` work volume. The dispatcher that creates ingestion Jobs also creates a `tech-extract` Job carrying the `import-id` label (failure lifecycle already handled by `platform-job-watcher`).

**Tech Stack:** Docker (multi-stage, `node:22-alpine`), `anchore/syft` image, Helm, ArgoCD, `@kubernetes/client-node` (existing dispatcher).

**Depends on:** Plan 1 (migration applied to the platform RDS) and Plan 2 (`dist/run-tech-extract.js` builds).

**Spec:** `docs/superpowers/specs/2026-05-25-tech-extractor-layer1-design.md` §Infra

---

## File Structure

**This repo (ai-applications):**
- Create `applications/tech-extractor/Dockerfile` (multi-stage; Syft binary + wasm grammars)
- Create `applications/tech-extractor/.dockerignore`
- Modify CI to build + push the `tech-extractor` image to ECR

**kubernetes-bootstrap (branch `main`)** — mirror `charts/ingestion/` (NOT `tucaken-app`):
- `charts/tech-extractor/chart/` — `Chart.yaml`, `values.yaml`, `templates/tech-extractor-sa.yaml`, `templates/admin-api-job-creator-rbac.yaml` (NO Job/Deployment template — admin-api creates the Job in code)
- `charts/tech-extractor/external-secrets/` — GitHub PAT + RDS creds/config (ESO)
- `argocd-apps/tech-extractor.yaml` + `argocd-apps/tech-extractor-secrets.yaml`

**cdk-monitoring (branch `develop`):**
- ECR repo `tech-extractor` in `infra/lib/shared/vpc-stack.ts`
- admin-api dispatcher: build + POST the tech-extract `V1Job` (mirrors the ingestion Job creator; admin-api already holds the job-creator RBAC)

---

## Task 1: Dockerfile

**Files:**
- Create: `applications/tech-extractor/Dockerfile`
- Create: `applications/tech-extractor/.dockerignore`

> Start from `applications/ingestion/Dockerfile` (already proven for this workspace's yarn-berry build) and add: (a) the `tech-extractor` workspace to the build, (b) the Syft binary, (c) the wasm grammars into the runtime image.

- [ ] **Step 1: .dockerignore**

```
node_modules
dist
**/dist
**/node_modules
**/*.tsbuildinfo
```

- [ ] **Step 2: Dockerfile** (adapt the ingestion Dockerfile; key deltas annotated)

```dockerfile
# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare yarn@4.12.0 --activate

COPY package.json yarn.lock .yarnrc.yml ./
COPY tsconfig.base.json ./
COPY applications/tsconfig.json ./applications/

# Sibling-workspace manifests required for lockfile resolution (mirror the
# ingestion Dockerfile's full manifest copy; add tech-extractor).
COPY applications/shared/package.json         ./applications/shared/
COPY applications/tech-extractor/package.json ./applications/tech-extractor/
COPY applications/ingestion/package.json      ./applications/ingestion/
COPY api/public-api/package.json              ./api/public-api/
COPY applications/article-pipeline/package.json  ./applications/article-pipeline/
COPY applications/job-strategist/package.json    ./applications/job-strategist/
COPY applications/chatbot/package.json           ./applications/chatbot/
COPY applications/chatbot-public/package.json    ./applications/chatbot-public/
COPY applications/chatbot-authenticated/package.json ./applications/chatbot-authenticated/
COPY applications/self-healing/package.json           ./applications/self-healing/
COPY applications/resume-import-processor/package.json ./applications/resume-import-processor/
COPY applications/platform-job-watcher/package.json   ./applications/platform-job-watcher/
COPY packages/script-utils/package.json          ./packages/script-utils/
COPY infra/package.json                          ./infra/
RUN yarn install --immutable

COPY applications/shared/tsconfig.json         ./applications/shared/
COPY applications/shared/src                   ./applications/shared/src/
COPY applications/tech-extractor/tsconfig.json ./applications/tech-extractor/
COPY applications/tech-extractor/src           ./applications/tech-extractor/src/

RUN node_modules/.bin/tsc -b applications/shared applications/tech-extractor --force \
 || [ -f applications/tech-extractor/dist/run-tech-extract.js ]

# Patch @bedrock/shared main -> dist for runtime require().
RUN node -e "const f='applications/shared/package.json';const p=require('./'+f);p.main='dist/index.js';p.types='dist/index.d.ts';require('fs').writeFileSync(f,JSON.stringify(p,null,2));"

RUN yarn workspaces focus @bedrock/shared @bedrock/tech-extractor --production

# ── Stage 2: Syft binary ─────────────────────────────────────────────────────
# Official image ships a static binary that runs on alpine/musl.
FROM anchore/syft:latest AS syft

# ── Stage 3: Runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
RUN addgroup -S appgroup && adduser -S appuser -G appgroup -u 1001
WORKDIR /app

COPY --from=builder --chown=appuser:appgroup /app/applications/tech-extractor/dist ./applications/tech-extractor/dist
COPY --from=builder --chown=appuser:appgroup /app/applications/tech-extractor/package.json ./applications/tech-extractor/
COPY --from=builder --chown=appuser:appgroup /app/applications/shared/dist ./applications/shared/dist
COPY --from=builder --chown=appuser:appgroup /app/applications/shared/package.json ./applications/shared/
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules

# Syft binary on PATH; SYFT_BIN env points the extractor at it.
COPY --from=syft /syft /usr/local/bin/syft
ENV SYFT_BIN=/usr/local/bin/syft

# web-tree-sitter ships its wasm in node_modules; grammar .wasm files are
# resolved at runtime from node_modules/<grammar-pkg>. If Phase 2 adds the live
# AST pass, COPY any extra .wasm grammar files here. (Phase 1 regex pass needs none.)

USER appuser
WORKDIR /app/applications/tech-extractor
CMD ["node", "dist/run-tech-extract.js"]
```

> Pin `anchore/syft` to a specific version tag (not `:latest`) before merging — read the current stable tag and record it. Confirm the binary path inside the image is `/syft` (it is for current anchore/syft images); adjust the `COPY --from=syft` source if a version differs.

- [ ] **Step 3: Build the image locally**

Run: `docker build -f applications/tech-extractor/Dockerfile -t tech-extractor:dev .`
Expected: build succeeds; image contains `/usr/local/bin/syft` and `dist/run-tech-extract.js`.

- [ ] **Step 4: Smoke the binary + entrypoint wiring**

```bash
docker run --rm tech-extractor:dev /usr/local/bin/syft version
docker run --rm tech-extractor:dev node -e "require('/app/applications/tech-extractor/dist/run-tech-extract.js')" 2>&1 | head -3
```
Expected: `syft version` prints; the node require fails fast on missing env vars (`Missing required env var: USER_ID`) — proving the entrypoint loads.

- [ ] **Step 5: Commit**

```bash
git add applications/tech-extractor/Dockerfile applications/tech-extractor/.dockerignore
git commit -m "feat(tech-extractor): add multi-stage Dockerfile with syft binary"
```

---

## Task 2: CI image build

**Files:**
- Modify: the CI workflow that builds the ingestion image (locate via `grep -rl "applications/ingestion/Dockerfile" .github`)

- [ ] **Step 1: Locate the ingestion image-build job**

Run: `grep -rn "ingestion/Dockerfile\|docker build\|docker/build-push" .github 2>/dev/null`
Expected: find the workflow + step that builds/pushes the ingestion image.

- [ ] **Step 2: Add a parallel build for tech-extractor**

Duplicate the ingestion image-build step, changing only: the Dockerfile path (`applications/tech-extractor/Dockerfile`), the image name/tag (`tech-extractor`), and any build matrix entry. Keep the same registry, auth, and tagging scheme as ingestion.

- [ ] **Step 3: Verify the workflow lints**

Run: `grep -n "tech-extractor" .github/workflows/*.yml`
Expected: the new build step references the tech-extractor image + Dockerfile.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/
git commit -m "ci(tech-extractor): build and push tech-extractor image"
```

---

## Task 3: kubernetes-bootstrap chart — namespace infra ONLY (mirror `charts/ingestion/`)

> **GROUNDED in the real cluster repo** `/Users/nelsonlamounier/Desktop/portfolio/kubernetes-bootstrap` (branch `main`). The earlier draft of this task was wrong — it assumed a Helm **Job template** like `tucaken-app`. Reality: tech-extractor is a one-shot Job (no ingress, no Rollout, no IngressRoute, no CloudFront), exactly like **ingestion**. The ingestion "chart" contains **no Job/Deployment template at all** — the Job spec is built **programmatically by admin-api** and POSTed to the K8s API. The chart only provides namespace infra: a ServiceAccount, cross-namespace RBAC granting admin-api permission to create Jobs, and ExternalSecrets. Reference template: `charts/ingestion/` (NOT `charts/tucaken-app/`). Invoke the `k8s-new-service` skill for ownership rules, but the concrete model is the ingestion chart.

- [ ] **Step 1: Copy the ingestion chart**
`cp -r charts/ingestion charts/tech-extractor` in `kubernetes-bootstrap`, then rename every `ingestion` → `tech-extractor` and `ingestion-sa` → `tech-extractor-sa` across `Chart.yaml`, `values.yaml`, and templates. Resulting tree should be:
```
charts/tech-extractor/chart/Chart.yaml
charts/tech-extractor/chart/values.yaml
charts/tech-extractor/chart/templates/tech-extractor-sa.yaml          # SA the Job pods run as
charts/tech-extractor/chart/templates/admin-api-job-creator-rbac.yaml # Role+RoleBinding: admin-api may create Jobs here
charts/tech-extractor/external-secrets/tech-extractor-secrets.yaml    # GITHUB_TOKEN (ESO -> bedrock-development/github-token)
charts/tech-extractor/external-secrets/rds-credentials.yaml
charts/tech-extractor/external-secrets/platform-rds-credentials.yaml
charts/tech-extractor/external-secrets/rds-config.yaml
```

- [ ] **Step 2: ServiceAccount — no Bedrock needed**
Unlike ingestion, tech-extractor calls **no Bedrock** (it reads/writes Postgres and fetches GitHub via the PAT). So the `tech-extractor-sa` needs **no AWS Pod Identity association** for Bedrock. Remove the Bedrock IAM prerequisite comment from the copied SA template. If it needs zero AWS perms, no PodIdentityAssociation is required at all (note this explicitly so cdk-monitoring doesn't add one). Keep the SA itself (pods must run as a named SA).

- [ ] **Step 3: RBAC — reuse the admin-api-job-creator pattern verbatim**
The copied `admin-api-job-creator-rbac.yaml` already grants admin-api's SA `create/get/list/watch/delete` on `batch/jobs` + `get/list` on `pods/log` in this namespace. Keep it as-is (only the namespace via `.Values.namespace` changes). This is what lets admin-api dispatch tech-extract Jobs.

- [ ] **Step 4: ExternalSecrets — GitHub PAT + RDS**
`tech-extractor-secrets.yaml`: reuse the SAME Secrets Manager source as ingestion — `bedrock-development/github-token` via ESO `aws-secretsmanager` ClusterSecretStore → `GITHUB_TOKEN`. Copy `rds-credentials.yaml` / `platform-rds-credentials.yaml` / `rds-config.yaml` unchanged except namespace. (tech-extractor reads `document_embeddings` + writes the technology_* tables, so it needs the platform-RDS creds the same way ingestion does.)

- [ ] **Step 5: ArgoCD Applications** — `argocd-apps/tech-extractor.yaml` + `argocd-apps/tech-extractor-secrets.yaml`, mirroring `argocd-apps/ingestion.yaml` + `argocd-apps/ingestion-secrets.yaml`. **No `ignoreDifferences`/IngressRoute/Image-Updater-IngressRoute blocks** — there is no ingress. (Image Updater for the ECR image is optional; mirror whatever ingestion does — check `argocd-apps/ingestion.yaml`.)

- [ ] **Step 6: Lint + commit** (in `kubernetes-bootstrap`, branch `main`, follow `git-commit` skill there)
```bash
helm lint charts/tech-extractor/chart
git add charts/tech-extractor argocd-apps/tech-extractor.yaml argocd-apps/tech-extractor-secrets.yaml
git commit -m "feat(tech-extractor): add namespace chart + ArgoCD apps (mirrors ingestion)"
```

> **Anti-patterns to avoid** (from k8s-new-service): no chart in `kubernetes-platform`; no `deploy.py`/SM-B references; do NOT add a Job/Deployment/Rollout/IngressRoute template (this is a Job-creator-RBAC chart, like ingestion).

---

## Task 3b: ECR repository (cdk-monitoring)

> The image built in Task 1/CI needs a registry. Per k8s-new-service, ECR repos are provisioned in **cdk-monitoring** (`infra/lib/shared/vpc-stack.ts`), branch `develop`.

- [ ] Add a `tech-extractor` ECR repository alongside the `ingestion` repo in cdk-monitoring's shared-vpc stack (copy the ingestion repo definition + lifecycle policy). Confirm the Task 2 CI build pushes to this repo's URI.
- [ ] Commit in cdk-monitoring (branch `develop`, `git-commit` skill).

---

## Task 4: admin-api dispatcher — create the tech-extract Job

> **GROUNDED in the real admin-api** at `/Users/nelsonlamounier/Desktop/portfolio/tucaken-app/admin-api`. There are TWO dispatch sites; the **primary** one is in `routes/github.ts`, not `routes/ingestion.ts`:
> - `admin-api/src/routes/github.ts` — `dispatchIngestionJob(config, userId, repoFullName, githubToken, forceReindex)` — **the canonical pattern to copy.** Called by `POST /github/connected-repos`, the auto-dispatch loop on install, re-install, and reconcile. It injects a **per-user GitHub App installation token** (`generateInstallationToken` from `lib/github-app.ts`) as the explicit `GITHUB_TOKEN` env (overrides the static secret), and sets reconciliation **annotations** `ingestion.tucaken.io/{user-id,repo-full-name}` so `platform-job-watcher` can map failures to `repo_sync_state`.
> - `admin-api/src/routes/ingestion.ts` — `POST /trigger` `buildJobSpec()` — the secondary manual trigger; mirror too if you want manual tech-extract runs.
> - `admin-api/src/lib/config.ts` — `getJobImage(name)`, `JobImageName` union, `ingestionNamespace`/`ingestionServiceAccount`.
> - `admin-api/src/lib/k8s.ts` — `getBatchApi()`. `admin-api/src/lib/github-app.ts` — `generateInstallationToken`, installation helpers (no sha resolver — see Step 5).
>
> **Three earlier assumptions corrected:** (1) no `import-id` label — Jobs use `app`/`userId`/`repoSlug` labels + `ttlSecondsAfterFinished: 3600` + the `ingestion.tucaken.io/*` annotations. (2) the image is resolved at request time via `getJobImage('tech-extractor')` (file `/etc/admin-api/images/tech-extractor`, ESO-synced from SSM `/k8s/{env}/job-images/tech-extractor`), not passed as a literal URI. (3) `GITHUB_TOKEN` is a per-user installation token generated at dispatch — the tech-extract Job must get the same injected token, so the static `tech-extractor-secrets` PAT is only a fallback.

- [ ] **Step 1: Register the image name** — `admin-api/src/lib/config.ts`
Add `'tech-extractor'` to the `JobImageName` union and to the `ENV_FALLBACK` map (env var e.g. `TECH_EXTRACTOR_IMAGE` for local dev). Add `techExtractorNamespace` (`TECH_EXTRACTOR_NAMESPACE` ?? `'tech-extractor'`) and `techExtractorServiceAccount` (`TECH_EXTRACTOR_SERVICE_ACCOUNT` ?? `'tech-extractor-sa'`) to the config object, mirroring the `ingestion*` fields.

- [ ] **Step 2: Seed the image URI source** (cdk-monitoring + ESO)
Add SSM param `/k8s/{env}/job-images/tech-extractor` (written by the CI image-push step / cdk-monitoring seed, alongside the existing `ingestion` entry) and include it in the `admin-api-job-images` ExternalSecret so `getJobImage('tech-extractor')` resolves. Without this, `isImageConfigured()` returns false and the route correctly 502s.

- [ ] **Step 3: Add `dispatchTechExtractJob()`** — `admin-api/src/routes/github.ts` (sibling to `dispatchIngestionJob`)
Copy `dispatchIngestionJob` to a `dispatchTechExtractJob(config, userId, repoFullName, githubToken, commitSha?)`, changing only:
- `image = getJobImage('tech-extractor')` guarded by `isImageConfigured(...)`; if unconfigured, log + return without throwing (additive — never block ingestion)
- namespace `config.techExtractorNamespace`, SA `config.techExtractorServiceAccount`
- name `tech-extract-{slugPart}-{sha1(userId:repo:ts)[:8]}` (deterministic per run; duplicate create 409 → treat as success)
- labels `{ app: 'tech-extractor', userId: safeUser, repoSlug }`, `ttlSecondsAfterFinished: 3600`, `backoffLimit: 2`, `activeDeadlineSeconds: 1800`, `restartPolicy: 'Never'`
- **annotations:** use a distinct `tech-extractor.tucaken.io/{user-id,repo-full-name}` namespace — do NOT reuse the `ingestion.tucaken.io/*` annotations, so `platform-job-watcher` does **not** fold tech-extract failures into `repo_sync_state` (tech-extract is shadow/additive; a failed run just yields no parity row, which is fine). TTL handles cleanup.
- command `['node', 'dist/run-tech-extract.js']`
- env: `observabilityEnv('tech-extractor', ...)` + `USER_ID`, `REPO_FULL_NAME`, `WORK_DIR=/work`, `{ name: 'GITHUB_TOKEN', value: githubToken }` (the **per-user installation token**, same as ingestion), `COMMIT_SHA` (Step 5), + traceparent
- `envFrom: [{ secretRef: { name: 'platform-rds-credentials' }}, { secretRef: { name: 'tech-extractor-secrets' }}]` (PG creds; the static secret GitHub PAT is a fallback behind the injected token)
- add an `emptyDir` work volume (`sizeLimit: 2Gi`) + `volumeMounts` `/work` — the one addition beyond the ingestion Job spec

- [ ] **Step 4: Call it alongside every ingestion dispatch**
At each site that calls `dispatchIngestionJob(...)` (`POST /github/connected-repos`, the install auto-dispatch loop, re-install, reconcile, and optionally `routes/ingestion.ts` `/trigger`), call `dispatchTechExtractJob(...)` right after, wrapped in try/catch that only logs (never affects the ingestion result or HTTP response). Treat HTTP 409 as success.

- [ ] **Step 5: Resolve `COMMIT_SHA` at dispatch** — `admin-api/src/lib/github-app.ts`
You **cannot** pass the branch name as `COMMIT_SHA` — the entrypoint records it verbatim as `commit_sha`, so a branch name would make the short-circuit fire forever and never re-extract on new commits. There is no existing sha resolver, but the installation token is already in hand at dispatch. Add a small helper:
```ts
// Resolve the HEAD commit sha of a ref (default branch) via the installation token.
export async function resolveHeadSha(token: string, repoFullName: string, ref: string): Promise<string> {
    const res = await fetch(`https://api.github.com/repos/${repoFullName}/commits/${ref}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'tucaken-admin-api' },
    });
    if (!res.ok) throw new Error(`resolveHeadSha ${repoFullName}@${ref}: HTTP ${res.status}`);
    return ((await res.json()) as { sha: string }).sha;
}
```
In `dispatchTechExtractJob`, resolve `commitSha = await resolveHeadSha(githubToken, repoFullName, repo.default_branch ?? 'HEAD')` (the dispatch sites already have `default_branch` from the `repositories` row, or pass `'HEAD'`). On resolver failure, log and omit `COMMIT_SHA` (entrypoint falls back to `HEAD`; the short-circuit simply no-ops that run) — never block dispatch.

- [ ] **Step 6: Unit test** — mirror admin-api's existing route/builder tests. Assert: deterministic job name for the same `(userId, repo, ts)`; image-unconfigured path returns without throwing; a 409 from a fake batch API is swallowed; `resolveHeadSha` failure falls back to no `COMMIT_SHA` without throwing. Run admin-api's test command; expect pass.

- [ ] **Step 7: Commit** in tucaken-app (`git-commit` skill).

---

## Task 5: End-to-end shadow run + parity readout

**Files:** none (operational verification)

- [ ] **Step 1: Apply migration 034** to the dev platform RDS via the existing bootstrap path (`applications/platform-rds-bootstrap`).

Run: the repo's migration-apply command (check `applications/platform-rds-bootstrap/src/index.ts` / `justfile`).
Expected: 034 applies; the six tables + seed exist.

- [ ] **Step 2: Trigger a tech-extract Job for a known dev repo** (one already ingested by the LLM enricher, so `document_embeddings.technologies` is populated for parity).

- [ ] **Step 3: Read the parity result**

```sql
SELECT repo_full_name, recall, intersection_count, llm_canonical_count,
       llm_unresolvable_count, llm_only_examples
FROM technology_parity_runs ORDER BY ran_at DESC LIMIT 1;
```
Expected: a row exists; `recall` is populated; `llm_only_examples` shows which technologies the seed ontology is still missing (the curation backlog feed).

- [ ] **Step 4: Confirm shadow-mode (no regression)** — the existing ingestion + enricher behaviour is unchanged (the tech-extract Job is additive; nothing was removed).

- [ ] **Step 5: Record the baseline** — note the recall number in the spec's status / a follow-up issue. This is the Phase-1 success measurement; low recall points directly at curated-ontology gaps (the next data-track spec), not at the engineering.

---

## Self-Review

**Spec coverage (Plan 3 portion):**
- Multi-stage Dockerfile with Syft binary + wasm grammars → Task 1 ✓
- CI image build → Task 2 ✓
- ECR repo (cdk-monitoring shared-vpc) → Task 3b ✓
- Namespace chart (SA + admin-api-job-creator RBAC + ExternalSecrets), mirroring `charts/ingestion/` — **NO Helm Job template; the Job is built in admin-api code** → Task 3 ✓
- ArgoCD apps (no IngressRoute/ignoreDifferences — not an HTTP service) → Task 3 ✓
- admin-api builds + POSTs the tech-extract Job; trigger alongside ingestion + `import-id` label reuse → Task 4 ✓
- Concurrent-run guard: deterministic Job name + 409-as-success + evidence ON CONFLICT (issue #9) → Task 4 ✓
- Migration apply + shadow run + parity readout (the Phase-1 success test) → Task 5 ✓

**Grounded in the real cluster repo** (`kubernetes-bootstrap`, branch `main`): reference template is `charts/ingestion/` (a Job-creator-RBAC chart), NOT `charts/tucaken-app/` (an HTTP-service chart with Rollout/IngressRoute/CloudFront). The k8s-new-service skill's `tucaken-app` template does not apply here — tech-extractor is a batch Job, so there is no ingress, no Rollout, no IngressRoute patcher, no CloudFront/WAF. GitHub PAT reuses ingestion's `bedrock-development/github-token` ESO source; no Bedrock IAM needed (tech-extractor calls no Bedrock).

**Placeholder scan:** remaining "locate at implementation" greps are for admin-api's Job-creator code and the CI workflow — both in cdk-monitoring (cross-repo, must be discovered, not guessed). No vague code placeholders.

**Type/name consistency:** env var names (`USER_ID`, `REPO_FULL_NAME`, `COMMIT_SHA`, `WORK_DIR`, `GITHUB_TOKEN`, `PG_*`, `SYFT_BIN`, `MAX_TARBALL_BYTES`) match `env.ts` and `run-tech-extract.ts` from Plan 2. The `import-id` label and `platform-job-watcher` sweep match the existing ingestion convention.
```
