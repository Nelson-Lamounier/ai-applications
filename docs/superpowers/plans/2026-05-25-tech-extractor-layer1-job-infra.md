# Tech Extractor Layer 1 — Plan 3: Job & Infra

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Also REQUIRED:** the `k8s-new-service` skill governs all cluster-repo work (Helm chart, ArgoCD Application, secrets, IngressRoute). Invoke it before writing any chart/ArgoCD files — do not hand-author cluster manifests against guessed conventions.

**Goal:** Package `@bedrock/tech-extractor` as a runnable container image (with the Syft binary + Tree-sitter wasm grammars), deploy it as a short-lived K8s Job per repo, and trigger it alongside the existing ingestion Job — with a deterministic Job name closing the concurrent-run race.

**Architecture:** A multi-stage Dockerfile builds `@bedrock/shared` + `@bedrock/tech-extractor`, copies the static Syft binary from the official `anchore/syft` image and bundles `web-tree-sitter` wasm grammars, runs as a non-root one-shot pod with an `emptyDir` work volume. The dispatcher that creates ingestion Jobs also creates a `tech-extract` Job carrying the `import-id` label (failure lifecycle already handled by `platform-job-watcher`).

**Tech Stack:** Docker (multi-stage, `node:22-alpine`), `anchore/syft` image, Helm, ArgoCD, `@kubernetes/client-node` (existing dispatcher).

**Depends on:** Plan 1 (migration applied to the platform RDS) and Plan 2 (`dist/run-tech-extract.js` builds).

**Spec:** `docs/superpowers/specs/2026-05-25-tech-extractor-layer1-design.md` §Infra

---

## File Structure

- Create `applications/tech-extractor/Dockerfile` (multi-stage; Syft binary + wasm grammars)
- Create `applications/tech-extractor/.dockerignore`
- Cluster repo (via `k8s-new-service`): Helm chart for the Job, ArgoCD Application, image-pull + DB/GitHub secret wiring
- Modify the ingestion-Job dispatcher to also create a `tech-extract` Job (location TBD at implementation — same component that creates the ingestion Job; one cross-repo dependency)
- Modify CI to build + push the `tech-extractor` image

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

## Task 3: Helm chart + ArgoCD (cluster repo — via k8s-new-service)

> **Invoke the `k8s-new-service` skill now.** It is authoritative for: which repo owns the chart, namespace, secret wiring (DB creds, `GITHUB_TOKEN`), ArgoCD Application placement, and IRSA/service-account for Bedrock-free DB access. Do not guess these — the skill encodes the cluster's ownership rules.

The chart must express a **Job template** (not a Deployment), parameterised per run:

- [ ] **Step 1: Run the `k8s-new-service` skill** to scaffold the chart for a Job-type workload named `tech-extractor`.

- [ ] **Step 2: Job spec essentials** (encode these in the chart the skill scaffolds)

```yaml
# values / template highlights — adapt to the skill's chart structure
spec:
  backoffLimit: 2
  activeDeadlineSeconds: 1800
  template:
    spec:
      restartPolicy: Never
      serviceAccountName: tech-extractor          # IRSA if it needs AWS; DB via secret
      securityContext: { runAsNonRoot: true, runAsUser: 1001 }
      containers:
        - name: tech-extractor
          image: <registry>/tech-extractor:<tag>
          envFrom:
            - secretRef: { name: tech-extractor-db }     # PG_* creds
          env:
            - { name: USER_ID,        value: "{{ .Values.userId }}" }
            - { name: REPO_FULL_NAME, value: "{{ .Values.repoFullName }}" }
            - { name: COMMIT_SHA,     value: "{{ .Values.commitSha }}" }
            - { name: WORK_DIR,       value: "/work" }
            - name: GITHUB_TOKEN
              valueFrom: { secretKeyRef: { name: tech-extractor-github, key: token } }
          resources:
            requests: { cpu: "500m", memory: "1Gi" }
            limits:   { cpu: "1500m", memory: "2Gi" }
          volumeMounts:
            - { name: work, mountPath: /work }
      volumes:
        - name: work
          emptyDir: { sizeLimit: 2Gi }              # disk-backed; bounds runaway repos
```

- [ ] **Step 3: ArgoCD Application** (via the skill) pointing at the chart, synced to the cluster.

- [ ] **Step 4: Commit** (in the cluster repo, per the skill's commit conventions — follow `git-commit` skill there too).

---

## Task 4: Dispatcher — trigger the Job (concurrent-run guard)

**Files:**
- Modify: the component that creates the ingestion K8s Job (locate at implementation; it uses `@kubernetes/client-node`, mirrors the `import-id` label the `platform-job-watcher` sweeps)

> This is the **one cross-repo dependency** flagged in the spec. The dispatcher may live in `api/`, `tucaken-app`, or an infra component — locate it before editing.

- [ ] **Step 1: Locate the ingestion Job creator**

Run: `grep -rn "createNamespacedJob\|batch/v1\|import-id\|REPO_FULL_NAME" --include="*.ts" . | grep -v node_modules | grep -v dist`
Expected: find where the ingestion `V1Job` is constructed and submitted.

- [ ] **Step 2: Add a tech-extract Job creation alongside it**

Construct a `V1Job` for `tech-extractor` with:
- **Deterministic name** `tech-extract-{repoIdHash}-{shaShort}` (issue #9 — second create attempt 409s/no-ops, closing the concurrent-run race; the evidence `ON CONFLICT DO NOTHING` from Plan 1 covers residual duplicates).
- The same `import-id` label the ingestion Job carries (so `platform-job-watcher`'s stale sweep marks failures generically — no new watcher code).
- Env: `USER_ID`, `REPO_FULL_NAME`, `COMMIT_SHA` (the resolved HEAD sha at dispatch), `GITHUB_TOKEN` secret ref, `PG_*` secret ref.
- Wrap the create in a `try/catch` that treats a 409 (AlreadyExists) as success (idempotent dispatch).

- [ ] **Step 3: Add a unit test for the Job-name derivation**

Mirror the repo's existing dispatcher test style. Assert `jobName(userId, repo, sha)` is deterministic and stable for the same inputs, and that a 409 from the fake k8s client is swallowed.

- [ ] **Step 4: Run the dispatcher tests**

Run: the workspace test command for the dispatcher's package (e.g. `yarn workspace <pkg> test`).
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add <dispatcher files>
git commit -m "feat(dispatch): trigger tech-extract Job alongside ingestion"
```

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
- Dedicated K8s Job (Job not Deployment, emptyDir sizeLimit, non-root, resource limits) → Task 3 ✓
- ArgoCD + Helm via `k8s-new-service` → Task 3 ✓
- Trigger alongside ingestion + `import-id` label reuse → Task 4 ✓
- Concurrent-run guard: deterministic Job name + 409-as-success + evidence ON CONFLICT (issue #9) → Task 4 ✓
- Migration apply + shadow run + parity readout (the Phase-1 success test) → Task 5 ✓

**Placeholder scan:** the dispatcher file paths and CI workflow paths are intentionally "locate at implementation" because they cross repo/package boundaries that must be discovered, not guessed — each has an exact `grep` to find the target. The chart specifics defer to `k8s-new-service` by design. No vague code placeholders.

**Type/name consistency:** env var names (`USER_ID`, `REPO_FULL_NAME`, `COMMIT_SHA`, `WORK_DIR`, `GITHUB_TOKEN`, `PG_*`, `SYFT_BIN`, `MAX_TARBALL_BYTES`) match `env.ts` and `run-tech-extract.ts` from Plan 2. The `import-id` label and `platform-job-watcher` sweep match the existing ingestion convention.
```
