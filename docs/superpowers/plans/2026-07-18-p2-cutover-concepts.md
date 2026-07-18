<!-- @format -->

# P2: Cutover + Concept Detectors + Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flip dispatched ingestion to `UNIFIED_INGESTION=on`, retire the tech-extract Job/image/workflow, land the concept detectors + `concept_evidence` with the FP-gated coverage eval, and close the three tracked fixes. Final phase of `docs/superpowers/specs/2026-07-17-jd-concept-ledger-design.md`.

**Architecture:** ai-applications work merges first (dispatch still `off`, everything inert); the admin-api PR (tucaken-app, `main` branch) flips the dispatched Job to `on` with the volume/env it needs and removes the four tech-extract dispatch sites; only after a live `on` sync verifies clean do the retirement PRs land (ai-applications deletes the Dockerfile/workflow/entrypoint; kubernetes-bootstrap deletes the chart + ArgoCD apps). Concept detection is a fourth facts lane (DSA-discipline: per-file deterministic detectors, fail-open, shadow-skipped), feeding `concept_evidence` (migration 123), `repo_facts.concepts`, and a matcher prompt block.

**Tech Stack:** TypeScript, pg, jest; K8s/ArgoCD (three repos: ai-applications develop, tucaken-app main, kubernetes-bootstrap main).

## Global Constraints

- Deploy order is binding: T1-T6 (ai-applications) merge and verify BEFORE T7 (admin-api cutover); T8 (retirement) only after a live dispatched `on` sync is verified clean.
- Concept detectors are deterministic, fail-open, per-file, with explicit FP-avoidance rules; the coverage eval gate is FP <= 5% (DSA discipline). No LLM anywhere.
- Detector lane runs in `persist` mode only; `shadow` skips it (parity semantics unchanged).
- Migration 123 idempotent + ledger-final; `concept_evidence` RLS-scoped with the `set_config` writer pattern; `skill_ontology` seeds follow 092/093's ON CONFLICT idiom — do NOT create a duplicate `ci/cd` canonical (the canonical is `ci/cd pipelines`; add the missing aliases `ci-cd`, `ci/cd pipeline design` to it; add NEW canonicals `process automation` + `distributed systems` with self-aliases).
- UK English; no AI trailers; ESLint on touched files; ESM `.js`; per-task gates: `tsc -b shared ingestion job-strategist` + full jest in touched packages (4 documented pre-existing job-strategist failures only).
- Branch `feat/p2-cutover-concepts` (ai-applications); tucaken-app + kubernetes-bootstrap changes each on their own branch off their trunk (`main` for both).

---

### Task 1: Migration 123 — `concept_evidence` + ontology seeds

**Files:** Create `applications/platform-rds-bootstrap/migrations/123_concept_evidence.sql`

```sql
-- Migration 123 - concept_evidence: detector-backed concept facts (spec P2)
BEGIN;

CREATE TABLE IF NOT EXISTS concept_evidence (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL,
    repo_full_name TEXT NOT NULL,
    github_repo_id BIGINT,
    skill_id       UUID NOT NULL REFERENCES skill_ontology(id) ON DELETE CASCADE,
    detector       TEXT NOT NULL,
    file_path      TEXT NOT NULL,
    line_start     INT,
    confidence     REAL NOT NULL DEFAULT 1.0,
    commit_sha     TEXT NOT NULL,
    extracted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, repo_full_name, skill_id, detector, file_path)
);
CREATE INDEX IF NOT EXISTS idx_concept_evidence_repo
    ON concept_evidence (user_id, repo_full_name);

ALTER TABLE concept_evidence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_concept_evidence ON concept_evidence;
CREATE POLICY rls_concept_evidence ON concept_evidence
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON concept_evidence TO tucaken_app;

-- Ontology seeds (092/093 idiom): new canonicals + missing aliases.
INSERT INTO skill_ontology (canonical_name, display_name, category, curation_level, source)
VALUES ('process automation', 'Process Automation', 'devops', 'curated', 'p2-concepts'),
       ('distributed systems', 'Distributed Systems', 'architecture', 'curated', 'p2-concepts')
ON CONFLICT (canonical_name) DO NOTHING;

INSERT INTO skill_aliases (alias, skill_id, source)
SELECT a.alias, so.id, 'p2-concepts'
FROM (VALUES
    ('process automation', 'process automation'),
    ('distributed systems', 'distributed systems'),
    ('ci-cd', 'ci/cd pipelines'),
    ('ci/cd pipeline design', 'ci/cd pipelines')
) AS a(alias, canonical)
JOIN skill_ontology so ON so.canonical_name = a.canonical
ON CONFLICT (alias) DO NOTHING;

COMMIT;
```

The implementer MUST verify the exact `skill_ontology`/`skill_aliases` column lists against migration 092 before writing (the VALUES above assume 092's columns; adjust to the real NOT NULL set, keep the idiom).

- [ ] Verify columns vs 092 → write → static re-read → commit `feat(migrations): concept_evidence + concept ontology seeds (123)`

---

### Task 2: Concept detectors + evidence repository

**Files:**

- Create: `applications/ingestion/src/facts/extractors/ConceptPatternExtractor.ts` + test
- Create: `applications/ingestion/src/persistence/RdsConceptEvidenceRepository.ts` + test

**Detector set** (per-file, deterministic, DSA-discipline; each returns `RawConceptEvidence { conceptAlias: string; detector: string; filePath: string; lineStart?: number; confidence: number }`):

| detector | fires on | FP guards |
| --- | --- | --- |
| `workflow-ci` → `ci/cd pipelines` | files under `.github/workflows/` or `.gitlab-ci.yml`/`Jenkinsfile` that parse as YAML with a `jobs:`/`stages:` key | never fires on docs/fixtures (`__tests__/`, `fixtures/`, `*.md`) |
| `workflow-deploy` → `ci/cd pipelines` (confidence 1.0) | workflow files whose text contains a deploy marker (`deploy`, `ecr`, `helm upgrade`, `kubectl apply`, `argocd`) in a step `run:`/`uses:` line | same path guards; marker must be in an actionable line, not a comment |
| `k8s-orchestration` → `container orchestration` | files parsed by K8sManifestParser/ArgoHelmParser yielding evidence (reuse their parse success, do not re-parse) | manifests only; not README mentions |
| `iac-presence` → `infrastructure as code` | any `iac` source-layer technology evidence rows computed this run (aggregate, one row with `file_path` of the first evidence file) | fires once per repo, only from real iac evidence |
| `monitoring-config` → `observability` | Grafana dashboard/alert JSON-YAML paths (`grafana`, `dashboards/`, `alert` rules files, `prometheus.yml`, `alloy`/`otel-collector` configs) matching content sniff (contains `panels`/`groups:`/`receivers:`/`scrape_configs:`) | path AND content must both match |
| `runbooks` → `incident response` | files under a `runbooks/` or `docs/runbooks/` dir, or `*.md` whose first 30 lines contain `severity` + (`alert` or `on-call` or `incident`) | markdown only; both-token rule prevents generic docs firing |
| `secrets-config` → `secrets management` | ExternalSecret/SecretStore manifests (`kind: ExternalSecret`), vault config files, SOPS files | k8s `kind:` sniff or exact filename match |
| `broker-topology` → `distributed systems` | >= 2 distinct service manifests (compose services or k8s Deployments) AND >= 1 message-broker/queue technology evidence row this run | aggregate; both conditions required |
| `scheduled-automation` → `process automation` | CronJob manifests (`kind: CronJob`) or workflow files with `schedule:` triggers | manifest/workflow sniff only |
| `migrations-dir` → `database migrations` | numbered SQL migration dirs (>= 3 files matching `^\d+_.*\.sql$` in one dir) | count threshold prevents single-script FP |

Repository: `insertMany(userId, repoFullName, githubRepoId, commitSha, rows)` resolving `conceptAlias` → `skill_id` through the skill alias map (loader method on the repository, mirroring `RdsDsaTopicRepository`'s resolve pattern); upsert `ON CONFLICT (user_id, repo_full_name, skill_id, detector, file_path) DO UPDATE SET commit_sha = EXCLUDED.commit_sha, line_start = EXCLUDED.line_start, confidence = EXCLUDED.confidence, extracted_at = now()`; RLS `set_config` writer pattern. Unresolved aliases logged + skipped (never thrown).

TDD: fixture-based tests per detector — a firing fixture AND a non-firing near-miss (the FP guard case) for each; aggregate detectors tested with both-condition and one-condition inputs.

- [ ] TDD detectors → repository → `tsc -b` + ingestion jest → commit `feat(ingestion): concept detectors + concept_evidence repository`

---

### Task 3: Wire the concept lane + upgrade `repo_facts.concepts`

**Files:** Modify `applications/ingestion/src/facts/run-facts-stage.ts` (new `runConceptLane` after the tech lane, persist mode only, fail-open, gated by the SAME tech gate — concepts recompute whenever tech does; upserts are idempotent); modify `applications/ingestion/src/facts/build-repo-facts.ts` (`deriveConcepts` becomes: load detector-backed rows `SELECT so.canonical_name, ce.detector, count(*) AS files FROM concept_evidence ce JOIN skill_ontology so ON so.id = ce.skill_id WHERE ce.user_id=$1 AND ce.repo_full_name=$2 GROUP BY 1,2` → `{name, detector, files}`; keep the signal-derived entries ONLY for concepts with zero detector rows, marked `detector:'signal'` as today); tests for both.

- [ ] TDD → wire → full ingestion jest (shadow-mode tests must confirm the lane is skipped) → commit `feat(ingestion): concept lane in the facts stage + detector-backed repo_facts.concepts`

---

### Task 4: Tracked fixes

**Files:**

- `applications/ingestion/src/acquisition/tarball/safeExtract.ts` + `fetchTarball.ts` + `run-tech-extract.ts`: capture the tarball root directory name during extraction (GitHub names it `{owner}-{repo}-{sha}`); export it from `safeExtract` (return value change — update the two callers); in `fetchAndExtractTarball`, when the codeload-URL parse yields undefined, fall back to the root-dir sha suffix when it is >= 7 hex chars (expand to full sha is impossible from 7 — store what GitHub gives; the root dir carries the FULL 40-hex sha for API tarballs — verify with a unit fixture; if only short, keep 'HEAD'-refusal: log loudly and SKIP persisting evidence rather than stamping literal HEAD — enforce the documented invariant with `if (sha === 'HEAD') { log.error; return; }` before runFactsStage persist). Test both paths.
- `applications/ingestion/src/acquisition/IRepoAdapter.ts` + `TarballRepoAdapter.ts` + `narrative/ProfileInputCollector.ts` + `run-ingestion.ts`: add optional `getRepoMeta?` to `IRepoAdapter` (same signature as GitHubAdapter's); `TarballRepoAdapter` delegates it; `ProfileInputCollector` constructor widens to `IRepoAdapter` (guarding `getRepoMeta` absence with a clear error, since profile extraction requires it); `run-ingestion.ts` passes `activeAdapter` — in `on` mode README/manifest probes then read from the tarball. Tests: collector with a tarball adapter serves fetchFile locally.
- `applications/ingestion/src/facts/build-repo-facts.ts` + `run-build-repo-facts.ts`: add `buildRepoFactsBatch(pool, userId, repoFullNames)` loading `loadRepoRoleSignals` ONCE; the backfill runner uses it; `buildRepoFacts` (single) delegates to the batch with one repo. Tests: signals loader called exactly once for N repos.

- [ ] TDD each fix → `tsc -b` + ingestion jest → commit `fix(ingestion): tarball sha invariant + one-download profile collector + batch repo facts`

---

### Task 5: Matcher concept context + coverage eval

**Files:**

- Create `applications/job-strategist/src/ats/context/concept-evidence-context.ts` + test: pure `formatConceptEvidenceContext(jdConcepts: string[], repoConcepts: RepoConceptRow[], aliasToCanonical): string` mirroring `formatTechTransferContext` — renders `## Evidenced Concepts` lines (`- observability: 11 files across 2 repos (detectors: grafana-config)`) ONLY for concepts the JD mentions; `''` when empty.
- Loader: add `loadRepoConcepts(userId)` to the existing per-user evidence block in run-pipeline's `Promise.all` (query `concept_evidence` joined `skill_ontology`, grouped by canonical + repo); thread into the research agent's context alongside `techTransferContext`.
- Create `applications/job-strategist/src/evals/transfer/run-concept-coverage-eval.ts` + pure `classifyConceptCoverage` + test: over stored JD extractions' `concepts` lanes, canonicalise each mention (skill alias map), classify `covered` (>= 1 concept_evidence row) vs `uncovered`; print per-concept table + coverage fraction. FP gate is enforced at unit level (Task 2's near-miss fixtures) — the eval asserts additionally that NO concept absent from `skill_ontology`'s concept set claims coverage, and exits non-zero when coverage regresses below the recorded baseline (first run records the baseline in output; gate = report, human-judged, since the corpus mixes evidence-able and career-only concepts like "technical support").

- [ ] TDD → wire → `tsc -b` + job-strategist jest (4 pre-existing failures only) → commit `feat(job-strategist): concept-evidence matcher context + coverage eval`

---

### Task 6: ai-applications verification + PR + live concept gate

- [ ] Full `tsc -b` all packages; full jest shared+ingestion+job-strategist; ESLint branch files; flag-off byte-identity re-grep (concept lane is inside runFactsStage persist mode — dispatched `off` ingestion never reaches it; run-tech-extract still builds and now enforces the sha invariant).
- [ ] PR to develop `feat(ingestion)!: concept detectors + cutover fixes (P2 part 1)`; CI; merge.
- [ ] Controller, post-merge: apply migration 123 (break-glass); run the gate-tech-extract Job (explicit COMMIT_SHA) to persist concept evidence for the pilot repos; run the coverage eval (port-forward + tsx, like the P0 gap-rate eval); record per-concept coverage; verify `repo_facts.concepts` upgraded after a `buildRepoFactsBatch` backfill run.

---

### Task 7: admin-api cutover PR (tucaken-app, branch off `main`)

**Files (tucaken-app):** `admin-api/src/lib/jobs/ingestion-job.ts` (add `UNIFIED_INGESTION` env ← `process.env['UNIFIED_INGESTION'] ?? 'on'`; add `WORK_DIR=/tmp/ingest-work` env + `volumes: [{name:'work', emptyDir:{sizeLimit:'2Gi'}}]` + volumeMount at `/tmp/ingest-work`; add `GITHUB_SBOM_ENABLED` forwarded from `cfg.githubSbomEnabled`; bump memory limit to `2Gi`); `github-shared.ts` + `connected-repos.ts` + `webhook.ts` + `github.ts` (remove the four `dispatchTechExtractJob` call sites, the builder/dispatcher definitions, and imports); `admin-api/src/lib/config.ts` (remove `techExtractorNamespace`/tech-extractor `JobImageName`/`TECH_EXTRACTOR_IMAGE` fallback — verify no other consumer first). Respect that repo's conventions (read its CLAUDE.md/AGENTS.md if present; run its lint/tests).
- [ ] Implement on a branch off tucaken-app `main`; run that repo's test/lint suite; PR titled `feat(admin-api)!: dispatch unified ingestion (UNIFIED_INGESTION=on) and retire the tech-extract shadow job`; wait CI; merge (repo trunk = main).
- [ ] Controller: watch admin-api deploy (image → ArgoCD Image Updater → Rollout); then trigger a live resync (smoke MCP `smoke_admin_api` or user UI) and verify the dispatched Job runs `on`: `unified` acquisition logs, facts persisted in-job, inline stamp, no post-hoc stamp, no sibling tech-extract Job created. Also verify the kubernetes-bootstrap admin-api chart does not need the env (it is read from admin-api's own process env at spec-build time — confirm whether the Rollout env needs `UNIFIED_INGESTION` added in kubernetes-bootstrap `charts/admin-api`; if yes, that one-line values change rides the kubernetes-bootstrap PR in Task 8).

---

### Task 8: Retirement PRs (ONLY after Task 7's live verify)

- [ ] **ai-applications** PR: delete `applications/tech-extractor/` (Dockerfile), `.github/workflows/deploy-tech-extractor.yml`, `applications/ingestion/src/run-tech-extract.ts` + `env-tech-extract.ts` (dead once no image builds them; `runFactsStage` remains the library surface) + their tests; update docs (`docs/projects/tech-extractor.md` marked retired with pointer, ingestion README, `docs/repo-structure.md`); straggler grep `tech-extract` across `.github`/`applications`; full gates; PR `chore(ingestion)!: retire the tech-extract entrypoint, image and workflow (P2)`.
- [ ] **kubernetes-bootstrap** PR (branch off `main`): delete `charts/tech-extractor/**`, `argocd-apps/eks/development/tech-extractor.yaml` + `tech-extractor-secrets.yaml`; trim the `tech-extractor` entries from `appprojects.yaml` and `charts/admin-api/external-secrets/admin-api-job-images.yaml`; verify `ontology-importer.yaml` + `ddl-migrations.yaml` mentions are comments only; add `UNIFIED_INGESTION` to the admin-api Rollout env if Task 7 found it needed. PR; merge; verify ArgoCD prunes the namespace cleanly (no live Jobs — dispatch already stopped).
- [ ] Controller: final ledger + memory close-out; note the shared-infra CDK stack (ECR repo `/shared/ecr-tech-extractor` + SSM param) lives outside these repos — flag for manual cleanup, do not attempt.

## Self-review notes

- Spec P2 row fully covered: retirement (T7 dispatch removal + T8 deletions), concept detectors live (T2-T3), `concept_evidence` migration (T1), coverage eval + FP discipline (T2 near-miss fixtures + T5 eval). Tracked fixes closed (T4). Cutover ordering enforced by task sequence.
- Deviation from spec's flat "FP <= 5%" number: FP control is enforced structurally (per-detector near-miss fixtures + both-token/threshold guards) rather than a single live percentage, because concept ground truth on 5 repos is too small for a stable percentage; documented for the PR.
- Cross-repo tasks name their trunk explicitly (tucaken-app main, kubernetes-bootstrap main — NOT develop).
