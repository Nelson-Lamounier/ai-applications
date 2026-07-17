<!-- @format -->

# C0 Ingestion Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the entire ingestion system (shared ingestion lib, IngestionPipeline, tech-extractor sources) under `applications/ingestion/` with zero behaviour change, per phase C0 of `docs/superpowers/specs/2026-07-17-jd-concept-ledger-design.md`.

**Architecture:** Contract types the rest of `shared` needs are extracted into `shared` first (so no shared code ever imports from an app); then three pure `git mv` waves with a resolution-based import rewriter; the tech-extractor image keeps shipping from a Dockerfile that now builds the merged ingestion sources with its own CMD.

**Tech Stack:** TypeScript (composite `tsc -b`), yarn 4 workspaces, jest (ts-jest), Docker (node:22-alpine), GitHub Actions.

## Global Constraints

- Zero behaviour change: no export renames, no logic edits; only moves, import-path rewrites, and the contract extraction in Task 1.
- All prose UK English; no AI co-author trailers on commits.
- ESLint must pass on touched files before every commit (pre-existing `complexity` errors on untouched function bodies are exempt).
- Gate for every task: `npx tsc -b` over all packages listed in Task 6 step 1 + full jest in `applications/shared` and `applications/ingestion`.
- `applications/tech-extractor/` keeps its Dockerfile and deploy workflow (deleted only at P2 per spec); everything else in that folder moves.
- Work on branch `refactor/c0-ingestion-consolidation` off `origin/develop`; one PR at the end.

---

### Task 1: Extract the shared contract (unblocks all moves)

Four `shared` modules import from `shared/src/ingestion`; after the move that would be a shared→app edge. Extract the contract into `shared` first.

**Files:**

- Create: `applications/shared/src/repo-entities.ts`
- Move: `applications/shared/src/ingestion/implementations/github-errors.ts` → `applications/shared/src/github-errors.ts` (with its test → `applications/shared/src/github-errors.test.ts`)
- Modify: `applications/shared/src/ingestion/interfaces/IRepoAdapter.ts`, `applications/shared/src/ingestion/implementations/CommitChunker.ts`, `applications/shared/src/projects/change-impact/change-metrics.ts`, `applications/shared/src/rds/backfillGithubRepoId.ts`, `applications/shared/src/rds/implementations/RdsVectorStore.ts`, `applications/shared/src/rds/implementations/RdsRepoActivityStore.ts`, `applications/shared/src/index.ts`, plus the tests that import the old paths (`projects/change-impact/__tests__/change-metrics.test.ts`, `rds/backfillGithubRepoId.test.ts`, `rds/implementations/RdsRepoActivityStore.test.ts`)

**Interfaces:**

- Produces: `@bedrock/shared` exports `RepoCommit`, `RepoPullRequest`, `RepoContributor`, `RepoFile`, `CommitDetail`, `CommitFileChange`, `ListCommitsOptions`, `ListPullRequestsOptions`, `COMMIT_HISTORY_PATH_PREFIX` (from `repo-entities.ts`) and `RepoNotFoundError`, `GitHubResponseShapeError` (from `github-errors.ts`). Later tasks rely on these exact names.

- [ ] **Step 1: Verify the current suites are green (baseline)**

Run: `cd applications/shared && npx jest 2>&1 | grep -E "^(Tests|Test Suites):"`
Expected: all pass (140 suites / 1218 tests at time of writing).

- [ ] **Step 2: Create `repo-entities.ts`**

Cut the entity **type** declarations (`RepoCommit`, `RepoPullRequest`, `RepoContributor`, `RepoFile`, `CommitDetail`, `CommitFileChange`, `ListCommitsOptions`, `ListPullRequestsOptions`) out of `ingestion/interfaces/IRepoAdapter.ts` into the new file verbatim (keep doc comments). Also cut `export const COMMIT_HISTORY_PATH_PREFIX = '_commits/';` out of `CommitChunker.ts` into it. Then make the old locations re-import:

```ts
// applications/shared/src/ingestion/interfaces/IRepoAdapter.ts (top)
export type {
    RepoCommit, RepoPullRequest, RepoContributor, RepoFile,
    CommitDetail, CommitFileChange, ListCommitsOptions, ListPullRequestsOptions,
} from '../../repo-entities.js';
import type { RepoCommit, RepoFile /* ...as needed by the interface */ } from '../../repo-entities.js';
```

```ts
// applications/shared/src/ingestion/implementations/CommitChunker.ts (top)
import { COMMIT_HISTORY_PATH_PREFIX } from '../../repo-entities.js';
export { COMMIT_HISTORY_PATH_PREFIX }; // preserve existing export surface
```

- [ ] **Step 3: git mv github-errors into shared root**

```bash
git mv applications/shared/src/ingestion/implementations/github-errors.ts applications/shared/src/github-errors.ts
git mv applications/shared/src/ingestion/implementations/github-errors.test.ts applications/shared/src/github-errors.test.ts
```

Add a re-export shim so nothing else changes yet:
create `applications/shared/src/ingestion/implementations/github-errors.ts` containing only
`export * from '../../github-errors.js';`

- [ ] **Step 4: Repoint the four shared consumers at the new homes**

- `change-metrics.ts:11` → `import type { CommitDetail } from '../../repo-entities.js';` (mirror in its test)
- `backfillGithubRepoId.ts:44` → `import { RepoNotFoundError } from '../github-errors.js';` (mirror in its test)
- `RdsVectorStore.ts:17` → `import { COMMIT_HISTORY_PATH_PREFIX } from '../../repo-entities.js';`
- `RdsRepoActivityStore.ts:3` → `import type { RepoCommit, RepoPullRequest, RepoContributor, CommitDetail } from '../../repo-entities.js';` (mirror in its test)

- [ ] **Step 5: Barrel**

In `applications/shared/src/index.ts` add:

```ts
export * from './repo-entities.js';
export { RepoNotFoundError, GitHubResponseShapeError } from './github-errors.js';
```

(The existing type re-exports of `RepoCommit` etc. from `./ingestion/index.js` around lines 229-250 stay for now; they now resolve through the shim and are removed in Task 2.)

- [ ] **Step 6: Verify green**

Run: `cd applications/shared && npx tsc --noEmit && npx jest 2>&1 | grep -E "^(Tests|Test Suites):"`
Expected: same totals as baseline.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "refactor(shared): extract repo-entities + github-errors contract from ingestion lib"
```

---

### Task 2: Move `shared/src/ingestion` into the app

**Files:**

- Move (destination folders): `interfaces/IRepoAdapter.ts` + `implementations/{GitHubAdapter,github-errors-shim}` + all `GitHubAdapter*` tests → `applications/ingestion/src/acquisition/`; `interfaces/{IFileFilter,IChunker}.ts` + `implementations/{FileFilter,file-classifier,ChunkerRegistry,MarkdownChunker,CodeChunker,DefaultChunker}.ts` (+ their tests incl. `CodeChunker.eval.test.ts`) → `applications/ingestion/src/knowledge/`; `implementations/CommitChunker.ts` (+ test) → `applications/ingestion/src/activity/`; `orchestrator/RepoIngestionOrchestrator.ts` (+ test) → `applications/ingestion/src/RepoIngestionOrchestrator.ts` (root; it is the entrypoint's engine until P1 dissolves it into stages)
- Delete: `applications/shared/src/ingestion/**` barrels (`index.ts` files) and the Task-1 github-errors shim; remove the `./ingestion/index.js` re-export block from `applications/shared/src/index.ts` (lines ~229-250)
- Modify: `applications/ingestion/src/run-ingestion.ts`, `applications/ingestion/src/friendly-error.ts`, `applications/ingestion/src/agents/ProfileInputCollector.ts`, `applications/ingestion/src/util/goldenSkills.ts` (+ tests) — imports of moved symbols switch from `@bedrock/shared` to relative paths
- Modify: `applications/ingestion/package.json` — add explicit `"@bedrock/shared": "workspace:*"`, `"pg": "^8.20.0"`, `"prom-client": "^15.1.3"` to dependencies and `"@types/pg": "^8.20.0"` to devDependencies (previously hoisting-implicit; the moved code imports them directly)

**Interfaces:**

- Consumes: Task 1's `@bedrock/shared` exports (`repo-entities`, `github-errors`).
- Produces: app-internal modules `src/acquisition/GitHubAdapter.js`, `src/knowledge/{FileFilter,ChunkerRegistry,...}.js`, `src/activity/CommitChunker.js`, `src/RepoIngestionOrchestrator.js`. Task 3/4 import these relatively.

- [ ] **Step 1: git mv per the mapping above** (one command per file; keep filenames unchanged).

- [ ] **Step 2: Rewrite imports with the resolution script**

Reuse the projects-reorg rewriter pattern: for every moved file, resolve each relative specifier against its OLD location; if the target also moved, point at its NEW location; if the target stayed in `shared`, replace with the `@bedrock/shared` barrel import for that symbol (Task 1 exported everything needed: `RawChunk` and `IngestionReport` are already barrel-exported via `./rds/index.js`; `deriveRepoSignals` / `deriveEvidenceTopology` were barrel-exported in PR #501). App files that imported moved symbols from `@bedrock/shared` switch to relative paths.

- [ ] **Step 3: Trim the shared barrel** — delete the `from './ingestion/index.js'` export block; delete `applications/shared/src/ingestion/` entirely (barrels + shim are all that remain).

- [ ] **Step 4: Verify green**

Run: `cd applications && npx tsc -b shared ingestion tech-extractor job-strategist 2>&1 | tail -3`
Expected: clean. Then full jest in `shared` AND `ingestion` — expected: suite counts shift (moved tests now run under ingestion) but zero failures.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(ingestion): absorb shared ingestion lib (acquisition/knowledge/activity)"
```

---

### Task 3: Move `IngestionPipeline` into `knowledge/`

**Files:**

- Move: `applications/shared/src/rds/pipeline/{IngestionPipeline.ts,IngestionPipeline.test.ts}` → `applications/ingestion/src/knowledge/`; delete `applications/shared/src/rds/pipeline/index.ts` and the `rds/pipeline` re-export inside `applications/shared/src/rds/index.ts`; remove `IngestionPipeline` from `applications/shared/src/index.ts:320`
- Modify: `applications/shared/src/index.ts` — ADD barrel exports for the deep `rds` internals `IngestionPipeline` consumes that are not yet exported (verify each; known set from its imports: `IChunkEnricher`, `IEmbeddingProvider`, `ISyncStateRepository`, `IVectorStore` interfaces, the `rds/enrichment/*` helpers, `rds/quality/*` scoring fns). Rule: run `tsc -b`, add an export for every unresolved symbol, nothing more.
- Modify: `applications/ingestion/src/run-ingestion.ts` — `IngestionPipeline` import becomes `./knowledge/IngestionPipeline.js`; same in `src/RepoIngestionOrchestrator.ts` (type-only import) and `util/goldenSkills.ts`.

**Interfaces:**

- Produces: `applications/ingestion/src/knowledge/IngestionPipeline.js` (class `IngestionPipeline`, unchanged API).

- [ ] **Step 1: git mv + delete barrels as listed**
- [ ] **Step 2: Rewrite its relative imports** — everything it used lives in `shared`, so its `../interfaces/...`, `../enrichment/...`, `../quality/...`, `../types.js` imports all become `@bedrock/shared` barrel imports; add missing barrel exports until `tsc -b` is clean.
- [ ] **Step 3: Verify green** — same command + jest as Task 2 Step 4.
- [ ] **Step 4: Commit** — `refactor(ingestion): absorb IngestionPipeline into knowledge/`

---

### Task 4: Move tech-extractor sources into `facts/`

**Files:**

- Move: `applications/tech-extractor/src/extractors/**` (incl. `iac/`, tests, fixtures) → `applications/ingestion/src/facts/extractors/`; `manifests/**` → `facts/manifests/`; `orchestrator/TechExtractOrchestrator*` → `facts/TechExtractOrchestrator*`; `parity/**` → `facts/parity/`; `tarball/**` → `src/acquisition/tarball/`; `util/{fileWalk,isTestFile,reconcileTechStack}*` → `facts/util/`; `config/sdkCallPatterns.json` → `facts/config/sdkCallPatterns.json`; `src/run-tech-extract.ts` → `applications/ingestion/src/run-tech-extract.ts`; `src/env.ts` → `applications/ingestion/src/env-tech-extract.ts` (name collision with ingestion's own `env.ts`; update `run-tech-extract.ts` to `import { parseEnv } from './env-tech-extract.js';`); `__tests__/**` (integration + fixtures) → `applications/ingestion/src/facts/__tests__/`
- Modify: `applications/ingestion/package.json` — add `"smol-toml": "^1.7.0"`, `"tar": "^7.4.3"`, `"web-tree-sitter": "^0.25.0"`, `"yaml": "^2.6.0"`
- Modify: `applications/ingestion/tsconfig.json` — add `"resolveJsonModule": true` to compilerOptions and `"files": ["src/facts/config/sdkCallPatterns.json"]`
- Delete: `applications/tech-extractor/{package.json,tsconfig.json,jest.config.js,src/}` (folder keeps ONLY `Dockerfile`); remove `{ "path": "tech-extractor" }` from `applications/tsconfig.json` references
- Modify: `applications/tech-extractor/Dockerfile` — build the ingestion workspace instead:
  - `yarn workspaces focus @bedrock/shared @bedrock/ingestion --production` (replacing the tech-extractor focus)
  - `tsc -b applications/shared applications/ingestion --force || [ -f applications/ingestion/dist/run-tech-extract.js ]`
  - runtime `WORKDIR /app/applications/ingestion`; copy `applications/ingestion/dist` + focused `node_modules`; **keep** the syft stage (`FROM anchore/syft:v1.44.0 AS syft`, `COPY --from=syft --chmod=0555 /syft /usr/local/bin/syft`, `ENV SYFT_BIN=/usr/local/bin/syft`) and the read-only `--chmod` hardening; `CMD ["node", "dist/run-tech-extract.js"]`
- Modify: `.github/workflows/deploy-tech-extractor.yml` — trigger paths become `applications/tech-extractor/**` (Dockerfile), `applications/ingestion/**`, `applications/shared/**`, self; `dockerfile:` input unchanged (`applications/tech-extractor/Dockerfile`); ECR/SSM params unchanged
- Run `yarn install` at repo root to refresh the lockfile for the workspace membership change, and commit `yarn.lock` with this task

**Interfaces:**

- Consumes: `@bedrock/shared` (`OntologyResolver`, evidence repositories, observability) exactly as today — no import changes needed for those.
- Produces: `dist/run-tech-extract.js` inside the **ingestion** build output; the tech-extractor image CMD depends on this exact path.

- [ ] **Step 1: git mv per the mapping; apply the env rename**
- [ ] **Step 2: Rewrite relative imports** (script; `tarball/` moved to a different folder than its former siblings — the resolver handles it)
- [ ] **Step 3: package.json + tsconfig + workspace edits as listed; `yarn install`**
- [ ] **Step 4: Dockerfile + workflow edits as listed**
- [ ] **Step 5: Verify green** — `npx tsc -b` (note: `tech-extractor` no longer in the list) + full jest in ingestion (its suite count now includes the extractor tests) + `npx eslint applications/ingestion/src applications/shared/src`
- [ ] **Step 6: Commit** — `refactor(ingestion): absorb tech-extractor sources under facts/ (image + workflow preserved)`

---

### Task 5: Rename app-local folders to the spec layout

**Files:**

- Move: `applications/ingestion/src/agents/**` → `applications/ingestion/src/narrative/`; `applications/ingestion/src/repositories/**` → `applications/ingestion/src/persistence/`
- Modify: importers of those paths inside the app (`run-ingestion.ts`, `run-rollup.ts`, eval runners, `util/*`)
- `util/` stays as-is at C0 (fine-graining into `ontology/` happens at P3 per spec).

- [ ] **Step 1: git mv both folders; run the rewriter; verify green (tsc + jest); commit** — `refactor(ingestion): narrative/ + persistence/ folder names per unified-ingestion spec`

---

### Task 6: Full verification + PR

- [ ] **Step 1: Build every package**

Run from `applications/`: `pkgs=$(for d in */; do [ -f "$d/tsconfig.json" ] && echo "${d%/}"; done | grep -v '^dist$'); npx tsc -b $pkgs`
Expected: clean (tech-extractor absent from the list).

- [ ] **Step 2: Full jest** in `shared` and `ingestion`; combined totals must equal the pre-move totals of shared+ingestion+tech-extractor (no test lost in the move — compare counts).

- [ ] **Step 3: Grep for stragglers**

`grep -rn "shared/src/ingestion\|shared/dist/ingestion\|rds/pipeline\|tech-extractor/src" applications scripts .github --include='*.ts' --include='*.yml'` → only hits allowed: deploy-tech-extractor.yml comments and `applications/tech-extractor/Dockerfile`.

- [ ] **Step 4: README stubs** — update `applications/shared/src/projects/README.md` line that names `applications/shared/src/ingestion` (data-flow section) to the new path, and add a 20-line `applications/ingestion/README.md` describing the folder layout (acquisition/facts/knowledge/narrative/activity/persistence + two images, one source tree).

- [ ] **Step 5: Commit, push, PR to develop** titled `refactor(ingestion)!: consolidate the ingestion system under applications/ingestion (C0)`; body per impact-commits; wait for CI **including both image-build workflows** (deploy-ingestion and deploy-tech-extractor fire on merge — verify both push images; the C0 gate in the spec requires both green).

---

## Self-review notes

- Spec coverage: C0 section fully mapped (moves, stays-in-shared list honoured — `RdsVectorStore`, `retrieval/`, `OntologyResolver`, `TitanEmbeddingProvider`, `projects/evidence/*` are never touched). Reverse-dependency blocker handled by Task 1. Two-image constraint handled by Task 4.
- The `ontology/` folder from the spec layout intentionally does not exist yet (P3); recorded in Task 5.
- Type consistency: contract names (`RepoCommit` et al.) identical across Tasks 1-4; `COMMIT_HISTORY_PATH_PREFIX` keeps its exact name and export surface.
