# Tech Extractor — Layer 1 (Deterministic Technology Extraction)

**Date:** 2026-05-25
**Status:** Design approved, pending spec review
**Scope:** Phase 1 engineering spine + minimal ontology seed. Shadow-mode alongside the existing `BedrockChunkEnricher`; nothing is replaced.

## Problem

`BedrockChunkEnricher` conflates two extraction tasks and runs both at the wrong granularity (per-chunk):

- **Technology extraction** — naming tools/frameworks/services. This is closed-vocabulary NER over a known universe (~thousands of technologies). An LLM is overpowered for it.
- **Skill extraction** — inferring domain capabilities. Genuinely needs semantic understanding (out of scope for Phase 1).

Concrete failures of the current per-chunk LLM approach for *technologies*:

- **Redundant cost** — the same technology re-extracted across N chunks; no dedup.
- **Free-form strings** — `"K8s"`, `"kubernetes"`, `"Kubernetes orchestration"` become three un-joinable values. Downstream filtering/ranking breaks.
- **No provenance/confidence** — a resume claim can't be traced to file/commit/line. This breaks the product's honesty positioning.
- **Chunk granularity is wrong** — chunks are a unit of *retrieval*, not a unit of skill.

## Thesis (Phase 1 success criterion)

> Deterministic extraction (Syft + Tree-sitter + IaC parsers) reaches **parity with the LLM on the technology category**, with full provenance, at near-zero marginal cost.

Measured by a **parity reporter** that compares Layer-1 technologies against the LLM enricher's `document_embeddings.technologies` for the same repo. Target metric: `recall = |L1 ∩ LLM| / |LLM|`, reported per repo, plus LLM-only (misses) and L1-only (extra) sets.

## Architecture

### Content acquisition — GitHub tarball, not per-file API, not clone

The ingestion pod fetches files one-by-one through the GitHub REST API (`GitHubAdapter`). That is unworkable for Layer 1: Syft needs files on disk, and per-file fetching burns the 5,000 req/hr rate limit (a 500-file repo = 10% of quota). A full `git clone` pulls `.git` (5–10× working-tree size) and needs a new auth path.

**Decision:** `GET /repos/{owner}/{repo}/tarball/{ref}` — one API call per repo, CDN-backed (302 → codeload), same auth as existing GitHub API, no `.git` overhead.

Flow: resolve ref → stream tarball to an `emptyDir` work volume → extract with safety filters → run extractors against the directory → persist → discard the directory.

**Safe extraction** (untrusted input): `tar` with `{ strict: true, strip: 1, filter: safetyFilter }` —
- reject `../` path escapes (zip-slip)
- reject symlinks pointing outside the extraction root
- cap file count (~50k entries) and total uncompressed size (Content-Length × sane compression multiplier) to defend against zip bombs
- `--no-same-owner`, `--no-same-permissions` semantics; read-only operations only, never execute extracted content

**Tarball quirk:** the root dir inside is `{owner}-{repo}-{shortsha}/`; strip-components 1 (or track the actual root).

**Caching:** commit-SHA short-circuit — if `technology_evidence` already has rows for `(user_id, repo_full_name, commit_sha)`, skip download + extraction. (Cross-pod tarball caching in S3 is a later optimization, out of scope.)

### Placement — dedicated K8s Job

A new short-lived **K8s Job per repo** (`@bedrock/tech-extractor`), separate from the ingestion pod. Keeps the Syft binary (~50MB), wasm grammars, and tarball/disk concerns out of the ingestion image; independent resource limits and rollback. The existing chunker is untouched (Phase 2+ may consolidate both onto the same materialized tree).

Pod: `emptyDir` work volume with explicit `sizeLimit: 2Gi` (disk-backed default), mem limit ~1.5–2 GiB, CPU 500m request / 1500m limit, `Job` not `Deployment`. Failure lifecycle is already handled generically by `platform-job-watcher` via the `import-id` label.

### Package layout

```
applications/tech-extractor/            # @bedrock/tech-extractor — thin Job
  Dockerfile                            # multi-stage; COPY --from=anchore/syft + .wasm grammars
  src/
    run-tech-extract.ts                 # K8s Job entrypoint (mirrors run-ingestion.ts)
    env.ts
    tarball/
      fetchTarball.ts                   # tarball URL resolution + stream
      safeExtract.ts                    # guarded extraction
    extractors/
      SyftExtractor.ts                  # child_process: syft scan dir -o syft-json
      TreeSitterExtractor.ts            # web-tree-sitter imports + SDK-call patterns
      iac/
        DockerfileParser.ts
        K8sManifestParser.ts
        TerraformParser.ts
        GithubActionsParser.ts
        ReadmeParser.ts
    orchestrator/
      TechExtractOrchestrator.ts        # run extractors -> resolve -> persist
    parity/
      ParityReporter.ts                 # compare vs document_embeddings.technologies

applications/shared/src/rds/            # reusable persistence + resolution
  repositories/ (or implementations/)
    TechnologyOntologyRepository.ts
    TechnologyEvidenceRepository.ts
    TechnologyCandidateRepository.ts
  ontology/
    OntologyResolver.ts                 # normalize -> alias lookup -> technology_id | null
```

### Tooling

- **Syft** (Anchore, Apache-2.0): static binary copied from `anchore/syft` image stage; runs on alpine/musl. Invoked `syft scan dir:<path> -o syft-json`; output parsed for `(name, version, type→ecosystem, locations)`. Covers dependency-level tech across npm/PyPI/Go/Maven/crates/etc. with manifest provenance.
- **Tree-sitter** via **`web-tree-sitter` (wasm)** — avoids native compilation on alpine. Phase-1 grammars: TypeScript/JavaScript, Python, Go, Java, Rust. Extracts imports + known SDK-call patterns (e.g. `boto3.client('s3')` → AWS S3 even absent from `requirements.txt`) with file + line range.
- **IaC parsers** (in-TS): Dockerfile (base images, exposed ports, runtime tooling), k8s/Helm (workload kinds, ingress, images), Terraform/CDK/Pulumi (provider/resource → cloud service), GitHub Actions (test/deploy tooling), README (headings, badges).
- **`tar`** (npm) for guarded extraction.

## Data model — migration `034_technology_graph.sql`

Expand-only, idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), wrapped in `BEGIN/COMMIT`, per ROLLBACK.md Expand/Contract. Next free migration number is 034.

```sql
-- Enums
curation_level   : 'curated' | 'auto_imported' | 'candidate'
source_layer     : 'syft' | 'treesitter' | 'iac' | 'dockerfile' | 'readme'
relationship_kind: 'runs_on' | 'implements' | 'part_of' | 'succeeds' | 'related_to'
candidate_resolution: 'promoted' | 'aliased' | 'ignored' | 'duplicate'

technology_ontology
  id                uuid pk default gen_random_uuid()
  canonical_name    text not null unique     -- slug form: "kubernetes", "aws_lambda"
  display_name      text not null            -- "Kubernetes", "AWS Lambda"
  category          text not null            -- from the fixed taxonomy (below)
  curation_level    curation_level not null
  source            text                     -- provenance of the row
  popularity_score  int  default 0
  is_active         bool not null default true
  notes             text
  created_at        timestamptz not null default now()
  updated_at        timestamptz not null default now()

technology_aliases
  alias             text primary key         -- lowercased; one alias -> one technology
  technology_id     uuid not null references technology_ontology(id) on delete cascade
  source            text                     -- 'manual' | 'registry' | 'extraction'

technology_relationships
  from_id  uuid not null references technology_ontology(id) on delete cascade
  to_id    uuid not null references technology_ontology(id) on delete cascade
  kind     relationship_kind not null
  primary key (from_id, to_id, kind)

technology_candidates
  id                  uuid pk default gen_random_uuid()
  raw_name            text not null
  normalized_name     text not null           -- lowercased, dehyphenated for matching
  ecosystem           text                    -- npm | pypi | iac | dockerfile | ...
  first_seen_at       timestamptz not null default now()
  occurrence_count    int not null default 0
  user_count          int not null default 0
  example_repos       jsonb not null default '[]'  -- [{user_id, repo, file_path}]
  suggested_canonical uuid references technology_ontology(id)
  suggested_category  text
  resolved_at         timestamptz
  resolution          candidate_resolution
  unique (normalized_name, ecosystem)

technology_evidence
  id                          uuid pk default gen_random_uuid()
  user_id                     uuid not null
  repo_full_name              text not null
  commit_sha                  text not null
  technology_id               uuid references technology_ontology(id)  -- NULL when unmatched
  raw_name                    text not null
  ecosystem                   text
  source_layer                source_layer not null
  file_path                   text not null
  line_start                  int
  line_end                    int
  confidence                  real                                     -- deterministic => high/implicit
  extracted_at_ontology_version int not null
  created_at                  timestamptz not null default now()
  unique (user_id, repo_full_name, technology_id, file_path, line_start)

ontology_version            -- single-row counter feeding extracted_at_ontology_version
  version int not null
```

Indexes: `technology_evidence (user_id, repo_full_name, commit_sha)` (short-circuit + parity lookups); `technology_aliases (technology_id)`; `technology_candidates (resolution) WHERE resolved_at IS NULL` (review queue).

**Fixed category taxonomy (locked at seed time, ~25):** `language, framework_web, framework_mobile, framework_ml, runtime, database_relational, database_nosql, database_vector, database_search, database_kv, message_broker, observability, cloud_compute, cloud_storage, cloud_database, cloud_serverless, cloud_networking, cloud_security, iac, ci_cd, container_runtime, orchestration, api_protocol, testing, build_tool, package_manager, auth, payment, ai_platform`.

**Minimal curated seed (Phase 1):** ~100–150 `curation_level='curated'` rows + aliases, scoped to cover the test repos, sourced from GitHub Linguist (languages) + AWS service catalog + the obvious framework/DB/tooling set. The full curated 500–700, the 10–20k auto-import, and the weekly candidate-review loop are **separate data-track specs**, not this one.

## Data flow (the Job)

1. Parse env: `USER_ID`, `REPO_FULL_NAME`, `COMMIT_SHA?`, `GITHUB_TOKEN`, `PG_*`.
2. Resolve ref (default branch HEAD or `COMMIT_SHA`) → tarball stream → `safeExtract` to `emptyDir`.
3. Commit-SHA short-circuit: evidence rows exist for `(user, repo, sha)` → skip and exit 0.
4. Read the current `ontology_version`.
5. Run extractors over the extracted tree, each emitting `{ raw_name, ecosystem, source_layer, file_path, line_start, line_end }`:
   - `SyftExtractor` (SBOM JSON)
   - `TreeSitterExtractor` (imports + SDK calls)
   - IaC parsers
6. For each raw token: `OntologyResolver.resolve(raw, ecosystem)` → `technology_id | null`.
   - Matched → `technology_evidence` row (with `technology_id`, `extracted_at_ontology_version`).
   - Unmatched → `technology_evidence` row (`technology_id = NULL`, `raw_name` retained) **and** upsert `technology_candidates` (++occurrence_count, +distinct user, append example repo). **Nothing is dropped.**
7. `ParityReporter`: read distinct `document_embeddings.technologies` for `(user, repo)`; resolve **both** L1 canonicals and the LLM strings through the *same* `OntologyResolver`; compare on `technology_id`. Emit Prometheus metrics (`tech_extractor_layer1_recall`, counts for caught/missed/extra) + structured log. LLM strings that don't resolve are counted separately so the metric isn't polluted by the LLM's own free-form noise.
8. Observability + teardown: reuse `bootstrapK8sObservability`, push metrics to Pushgateway, time-boxed teardown (mirror `run-ingestion.ts` `withTimeout`).

## Infra (governed by the `k8s-new-service` skill at plan time)

- Multi-stage Dockerfile: builder stage (yarn workspace build of `@bedrock/shared` + `@bedrock/tech-extractor`, mirroring the ingestion Dockerfile), runtime stage `node:22-alpine` + `COPY --from=anchore/syft /syft /usr/local/bin/syft` + bundled `.wasm` grammars.
- Helm chart for the Job, ArgoCD Application, CI image build.
- **Trigger wiring is the one cross-repo dependency** — the dispatcher that creates ingestion Jobs also creates a `tech-extract` Job carrying an `import-id` label. Called out as an explicit plan step, not assumed. For Phase 1 the Job can also be triggered manually for parity runs.

## Testing (TDD, jest, per-repo convention)

- **Unit:** `safeExtract` guards (zip-slip, external symlink, file-count cap, uncompressed-size cap); `OntologyResolver` (lowercase/dehyphenate normalization, alias→canonical, ambiguous-alias rejection, unmatched→null); each IaC parser against fixtures; `TreeSitterExtractor` import/SDK-call extraction against fixtures; `SyftExtractor` SBOM-JSON parsing against a recorded fixture.
- **Integration:** small fixture tarball → run orchestrator against a test pg → assert `technology_evidence` rows (with provenance), `technology_candidates` upserts, and `ParityReporter` numbers.
- Fixture style mirrors the `resume-import-processor` `parsers/__tests__/fixtures/` approach already in the tree.

## Explicitly out of scope (deferred)

- Layer 2 (embedding-based skill classification) and Layer 3 (selective LLM narrative enrichment).
- Full curated ontology (500–700), the 10–20k authoritative auto-import, and the weekly candidate-review loop incl. LLM pre-suggestion — **separate data-track specs**.
- Replacing or removing `BedrockChunkEnricher` — Phase 1 runs *alongside* it.
- Consolidating the existing chunker onto the materialized tarball tree (Phase 2+).
- S3 cross-pod tarball caching.
- Per-user cost ceiling and signal-depth filtering (current enricher concerns, tracked separately).

## Open questions for spec review

1. Should `OntologyResolver` perform fuzzy matching (e.g. Levenshtein) for near-miss aliases in Phase 1, or strict normalized-exact only (fuzzy → candidates table for review)? Default: **strict only**; fuzzy is a candidate-loop concern.
2. Confidence on deterministic evidence — store a constant high value, or per-source-layer (Syft manifest > tree-sitter import > README badge)? Default: **per-source-layer constants**.
3. Parity reporter output — Prometheus + logs only, or also a `technology_parity_runs` table for historical tracking? Default: **metrics + logs**; add table if we want trend lines.
