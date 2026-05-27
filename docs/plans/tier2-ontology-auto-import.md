# Ontology Importer — Tier 2 (Authoritative Auto-Import)

**Date:** 2026-05-25
**Status:** Design draft, pending spec review
**Scope:** Phase 1 of the data-track work that backs the `technology_ontology` table created by the `034_technology_graph.sql` migration. Programmatically populates ~10–20k technology entries from authoritative registries, layered on top of the manually curated ~100–150 seed.

## Problem

The Layer 1 extraction pipeline (`@bedrock/tech-extractor`) resolves raw extraction tokens against `technology_ontology` via `OntologyResolver`. Anything unmatched lands in `technology_candidates` and as `technology_evidence` rows with `technology_id = NULL`.

With only the Tier 1 curated seed (~100–150 entries), most extractions miss:

- A typical Node repo has 50–200 dependencies. The curated seed covers 10–30 of them.
- A typical AWS-heavy repo references 5–20 services beyond the headline ones (`lambda`, `s3`, `rds`). Less common services (`appsync`, `eventbridge`, `step-functions`) silently land in candidates.
- Niche-but-real frameworks (`fastify`, `solid-js`, `pinia`, `qwik`) get no resolution.

The result: `technology_evidence` becomes dominated by NULL `technology_id` rows; downstream skill matching, JD-fit analysis, and resume bullet generation can't query reliably because most evidence isn't canonicalized.

Manual curation of every relevant package across npm (3M+), PyPI (500k+), Maven Central, crates.io, and three cloud provider catalogs is infeasible. But the canonical names already exist — in each registry. Tier 2 imports them programmatically.

## Thesis (Tier 2 success criterion)

> After a full Tier 2 import run completes, ≥80% of Layer 1 extraction tokens resolve to a canonical `technology_id` (vs. ~30-40% with Tier 1 alone), with category accuracy ≥85% on a 200-entry hand-validated sample.

Measured by:

- **Resolution rate** = `count(evidence WHERE technology_id IS NOT NULL) / count(evidence)` — computed per-ecosystem and overall.
- **Category accuracy** = manual spot-check against a fixed 200-entry sample drawn proportionally across sources.

Both metrics persist to `ontology_import_runs` for trend tracking.

## Architecture

### Placement — CronJob, not user-facing

A new `@bedrock/ontology-importer` service running as a Kubernetes **CronJob** (monthly cadence, manually triggerable). Single pod, runs to completion. Not on the user-facing ingestion path; no SLO concerns beyond completing within a few hours.

First run is a manual `Job` (bootstrap). Subsequent runs are `CronJob` on the 1st of each month at 02:00 UTC. Manual ad-hoc re-runs supported via `kubectl create job --from=cronjob/ontology-importer`.

### Categorization engine — four-layer cascade

Each imported entry passes through these layers in order. Stop at the first hit:

```
Layer 1: Hard pattern rules        (~30-40% hit rate)
   ↓ miss
Layer 2: Explicit name overrides   (~30-40% hit rate on remainder)
   ↓ miss
Layer 3: Source-native metadata    (PyPI classifiers, crates.io categories, etc.)
   ↓ miss
Layer 4: LLM batch classification  (catches the long tail)
   ↓ miss / decision: "maybe"
ontology_review_queue              (human review)
```

Layer 4 uses the Anthropic Message Batches API (Haiku 4.5, 50% batch discount). Runs once per import as an async follow-up job.

### Package layout

```
applications/ontology-importer/
  Dockerfile
  src/
    run-import.ts                         # CronJob/Job entrypoint
    run-llm-batch-followup.ts             # Triggered when Anthropic batch completes
    env.ts
    sources/
      Source.ts                           # interface every source implements
      AwsBotocoreSource.ts                # ~300 services from botocore
      GcpServiceUsageSource.ts            # ~500 services via Service Usage API
      AzureRestSpecsSource.ts             # ~600 services from azure-rest-api-specs
      NpmRegistrySource.ts                # top 5k by downloads
      PypiBigQuerySource.ts               # top 5k via BigQuery public dataset
      MavenCentralSource.ts               # top 2k via Maven Central Search API
      CratesIoSource.ts                   # top 2k via crates.io API
    categorization/
      Categorizer.ts                      # cascading classifier (orchestrates all 4 layers)
      patterns.json                       # Layer 1 pattern rules
      overrides.json                      # Layer 2 explicit canonical→category map
      sourceMetadataMappers.ts            # Layer 3 — per-source extractors
      LlmBatchClassifier.ts               # Layer 4 — Anthropic Batch API client
    aliases/
      AliasGenerator.ts                   # per-source alias derivation
      aliasFilters.ts                     # collision detection, exclusion rules
    importer/
      OntologyImporter.ts                 # idempotent upsert orchestrator
      ImportRunSummary.ts                 # diff calculation and reporting
      DeactivationDetector.ts             # tracks N-consecutive-miss policy

applications/shared/src/rds/              # reusable persistence (extends Layer 1)
  repositories/
    OntologyImportSourceRepository.ts
    OntologyImportRunRepository.ts
    OntologyReviewQueueRepository.ts
    OntologySkippedImportRepository.ts
```

### Tooling

- **`@anthropic-ai/sdk`** for the Message Batches API.
- **`@google-cloud/bigquery`** for the PyPI download stats query. Requires a GCP service account with BigQuery Data Viewer + Job User on a project (any project — BigQuery public datasets are free up to ~1TB/month query volume).
- **`@aws-sdk/client-pricing`** — actually not needed; AWS service catalog comes from `botocore` data files, not a runtime API.
- **`botocore` Python package OR cloned `boto/botocore` repo** — service definitions live at `botocore/data/{service}/{version}/service-2.json`. Easiest: clone the repo into the container image at build time, pin to a specific commit, parse the JSON files. No runtime AWS calls.
- **`gcloud` CLI** OR direct `https://serviceusage.googleapis.com/v1/services?parent=projects/-` calls — both work; CLI is simpler for initial implementation.
- **`axios`** or `undici` for npm registry, crates.io, Maven Central Search, and the Azure spec repo fetches.

### Source contract

Every source implements:

```typescript
interface Source {
  readonly name: string;                    // 'aws_botocore', 'npm_top_5k', etc.
  readonly ecosystem: string;               // 'aws', 'npm', 'pypi', etc.
  fetch(): AsyncIterable<RawImportEntry>;   // streaming — sources may be huge
}

interface RawImportEntry {
  source_identifier: string;                // npm package name, AWS service code, etc.
  proposed_canonical_name: string;          // pre-slugified
  proposed_display_name: string;
  description?: string;                     // for LLM context if needed
  keywords?: string[];                      // for alias generation
  popularity?: number;                      // source-relative score
  source_metadata: Record<string, unknown>; // raw data, persisted in import_sources.source_metadata
  repository_url?: string;                  // for downstream filtering
}
```

Sources are responsible for fetching, parsing, and yielding entries. They do **not** categorize, generate final aliases, or touch the database. The `OntologyImporter` orchestrates the rest.

## Data model — migration `035_ontology_import_tracking.sql`

Expand-only, idempotent, wrapped in `BEGIN/COMMIT`. Builds on the `034_technology_graph.sql` schema; does not modify the `technology_ontology` or `technology_aliases` tables.

```sql
-- Tracks every source that has contributed to each ontology entry.
-- An entry can have multiple sources (e.g., aws_s3 from aws_botocore AND from npm @aws-sdk/client-s3).
ontology_import_sources
  technology_id        uuid not null references technology_ontology(id) on delete cascade
  source               text not null              -- 'aws_botocore' | 'npm_top_5k' | etc.
  source_identifier    text not null              -- 's3', 'react', '@aws-sdk/client-s3', etc.
  first_imported_at    timestamptz not null default now()
  last_seen_at         timestamptz not null default now()
  consecutive_misses   int not null default 0     -- for deactivation policy
  popularity_in_source int                        -- source-relative score (npm downloads, etc.)
  source_metadata      jsonb                      -- raw source data for debugging
  primary key (technology_id, source)

-- History of import runs (per source) for audit and trend tracking.
ontology_import_runs
  id                      uuid pk default gen_random_uuid()
  source                  text not null
  triggered_by            text not null              -- 'cronjob' | 'manual' | 'backfill'
  started_at              timestamptz not null
  completed_at            timestamptz
  status                  text not null              -- 'running' | 'success' | 'failed' | 'partial'
  entries_fetched         int default 0
  entries_inserted        int default 0
  entries_updated         int default 0
  entries_deactivated     int default 0
  alias_merges            int default 0
  unresolved_count        int default 0              -- went to LLM batch
  review_queue_added      int default 0              -- LLM 'maybe' or uncategorized
  llm_batch_id            text                       -- Anthropic Batch API ID
  llm_batch_status        text                       -- 'pending' | 'completed' | 'failed'
  llm_batch_completed_at  timestamptz
  category_accuracy_score real                       -- from optional spot-check eval
  error_summary           text
  notes                   jsonb

-- Audit log of items the LLM classified as not technology-worthy.
-- Kept so we can review/override later without re-running the batch.
ontology_skipped_imports
  id                uuid pk default gen_random_uuid()
  raw_name          text not null
  ecosystem         text not null
  source            text not null
  llm_decision      text not null                   -- 'no'
  llm_reasoning     text
  llm_run_id        text                            -- which import_run.id triggered this
  skipped_at        timestamptz not null default now()
  reviewed_at       timestamptz                     -- if a human overturned the decision
  override_action   text                            -- 'promoted' | 'confirmed_skip'
  unique (raw_name, ecosystem)

-- Review queue for "maybe" decisions and uncategorized items.
ontology_review_queue
  id                  uuid pk default gen_random_uuid()
  raw_name            text not null
  ecosystem           text not null
  source              text not null
  reason              text not null                 -- 'llm_maybe' | 'uncategorized' | 'merge_candidate' | 'category_low_confidence'
  suggested_category  text
  suggested_canonical uuid references technology_ontology(id)
  llm_reasoning       text
  source_metadata     jsonb
  created_at          timestamptz not null default now()
  resolved_at         timestamptz
  resolved_by         text                          -- audit
  resolution          text                          -- 'promoted' | 'skipped' | 'aliased' | 'merged'
  unique (raw_name, ecosystem)
```

**Indexes:**
- `ontology_import_sources (source, last_seen_at)` — for "what did source X see most recently"
- `ontology_import_sources (consecutive_misses) WHERE consecutive_misses > 0` — deactivation candidates
- `ontology_review_queue (resolved_at) WHERE resolved_at IS NULL` — open queue
- `ontology_import_runs (source, started_at DESC)` — latest run per source

**Schema additions to existing `technology_ontology` (via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`):**

- No new columns. The `source` and `popularity_score` fields already exist from migration 034 and remain valid (now interpreted as "primary source" and "aggregate popularity"). Per-source detail lives in `ontology_import_sources`.

## Data flow

### Per import run (one source at a time)

1. **Begin run:** insert `ontology_import_runs` row with `status='running'`, `triggered_by`.
2. **Fetch:** invoke `source.fetch()` — yields `RawImportEntry` records (streamed; sources can be large).
3. **Pre-filter** (source-specific exclusions defined in each source class):
   - npm: skip `@types/*`, `*polyfill*`, `is-*`, micro-utilities matching exclusion patterns
   - PyPI: skip `setuptools`, `wheel`, stdlib backports, packaging meta
   - Maven: skip artifacts without a `repository.url`
   - All sources: skip entries with no description AND no repository URL (unverifiable)
4. **For each entry that passes pre-filter:**
   - Normalize → `canonical_name` (lowercased, slugified, source-specific transformation)
   - Check `technology_ontology` for existing row by `canonical_name`:
     - **Exists, `curation_level='curated'`:** update only `popularity_score` (additive) and upsert `ontology_import_sources`. Do not touch category, display_name, or curated aliases.
     - **Exists, `curation_level='auto_imported'`:** update `popularity_score`, `last_seen_at` in import_sources, merge any new aliases that don't collide. Reset `consecutive_misses` to 0.
     - **Does not exist:** continue to categorization.
5. **Categorize new entries via cascading layers:**
   - Layer 1 (patterns) → if match, assign category.
   - Layer 2 (overrides) → if match, assign category.
   - Layer 3 (source metadata, e.g., PyPI classifiers, crates.io categories) → if match, assign category.
   - Layer 4 deferred: entries falling through layers 1–3 are buffered for a single LLM batch call after the source completes.
6. **Insert categorized entries** with `curation_level='auto_imported'`, `source=<source name>`, `is_active=true`. Create `ontology_aliases` rows. Create `ontology_import_sources` row.
7. **Deactivation pass:** for `ontology_import_sources` rows matching this source where `last_seen_at` is older than the current run's start, increment `consecutive_misses`. When `consecutive_misses >= 3` (configurable), mark the parent `technology_ontology.is_active = false`. Never delete — preserve historical evidence resolution.
8. **LLM batch submission:** collect all entries that fell through layers 1–3. Submit one Anthropic Message Batch (Haiku 4.5). Persist `llm_batch_id` to the run row. Mark run as `status='partial'` and end the synchronous portion.
9. **Async follow-up** (`run-llm-batch-followup.ts`, triggered by the batch completion webhook OR a polling CronJob):
   - Retrieve batch results from Anthropic API.
   - For each result:
     - `decision='yes'` + category → insert as auto_imported.
     - `decision='no'` → insert `ontology_skipped_imports` row.
     - `decision='maybe'` OR no category returned → insert `ontology_review_queue` row.
   - Update import_runs row: `status='success'`, fill in final counts.

### Per import_run output

A structured summary written to logs and emitted as Prometheus metrics:

```
Run a4f7-... source=npm_top_5k
  entries_fetched:        4,847
  pre_filtered:             912
  layer_1_classified:     1,520
  layer_2_classified:     1,103
  layer_3_classified:       289
  sent_to_llm:            1,023
  entries_inserted:       2,912
  entries_updated:        1,800
  entries_deactivated:       12
  alias_merges:              47
  review_queue_added:       142
  duration:              1h 23m
```

### Idempotency guarantees

- **Re-running the same source** never creates duplicates: canonical_name is unique on `technology_ontology`, and `(technology_id, source)` is the primary key of `ontology_import_sources`.
- **Curated entries are never overwritten** for category, display_name, or curated aliases — only `popularity_score` may be updated additively.
- **Alias merges** respect the global uniqueness of `technology_aliases.alias`. Collisions are logged to `import_runs.notes` for review, never silently overwritten.
- **The LLM batch** is keyed by `import_run.id`; if the batch fails mid-processing, re-running picks up where it left off because already-processed entries have `ontology_skipped_imports` or `ontology_review_queue` rows that act as a lookaside.

## Categorization rules — concrete starting set

### Layer 1: pattern rules (`patterns.json`)

A list of `{ pattern, ecosystem, category, action }` rules evaluated in order. First match wins. Examples:

```json
[
  { "pattern": "^@types/", "ecosystem": "npm", "action": "skip" },
  { "pattern": "^@aws-sdk/", "ecosystem": "npm", "category": "cloud_compute" },
  { "pattern": "^@google-cloud/", "ecosystem": "npm", "category": "cloud_compute" },
  { "pattern": "^@azure/", "ecosystem": "npm", "category": "cloud_compute" },
  { "pattern": "^@nestjs/", "ecosystem": "npm", "category": "framework_web" },
  { "pattern": "^@apollo/", "ecosystem": "npm", "category": "api_protocol" },
  { "pattern": "^@tensorflow/", "ecosystem": "npm", "category": "framework_ml" },
  { "pattern": "^@stripe/", "ecosystem": "npm", "category": "payment" },
  { "pattern": "^@anthropic-ai/", "ecosystem": "npm", "category": "ai_platform" },
  { "pattern": "(-cli|^cli-)", "ecosystem": "npm", "category": "developer_tool" },
  { "pattern": "^eslint-(config|plugin)-", "ecosystem": "npm", "action": "skip" },
  { "pattern": "^babel-(plugin|preset)-", "ecosystem": "npm", "action": "skip" },
  { "pattern": "^is-(string|number|odd|...etc)$", "ecosystem": "npm", "action": "skip" },

  { "pattern": "^boto", "ecosystem": "pypi", "category": "cloud_compute" },
  { "pattern": "^google-cloud-", "ecosystem": "pypi", "category": "cloud_compute" },
  { "pattern": "^azure-", "ecosystem": "pypi", "category": "cloud_compute" },
  { "pattern": "^django(-|$)", "ecosystem": "pypi", "category": "framework_web" },
  { "pattern": "^opentelemetry-", "ecosystem": "pypi", "category": "observability" },

  { "pattern": "^org\\.springframework\\.", "ecosystem": "maven", "category": "framework_web" },
  { "pattern": "^io\\.netty\\.", "ecosystem": "maven", "category": "framework_web" },
  { "pattern": "^org\\.apache\\.kafka", "ecosystem": "maven", "category": "message_broker" }
]
```

This file lives in version control. Modifying it triggers an ontology version bump in the next import run (mechanism inherited from migration 034's `ontology_version` table).

### Layer 2: explicit overrides (`overrides.json`)

A flat map of canonical_name → category, used when patterns don't match but a hardcoded mapping is appropriate:

```json
{
  "next": "framework_web",
  "nuxt": "framework_web",
  "remix": "framework_web",
  "astro": "framework_web",
  "qwik": "framework_web",
  "solid-js": "framework_web",
  "svelte": "framework_web",
  "sveltekit": "framework_web",
  "fastapi": "framework_web",
  "django": "framework_web",
  "flask": "framework_web",
  "expressjs": "framework_web",
  "fastify": "framework_web",
  "prisma": "database_relational",
  "drizzle-orm": "database_relational",
  "kysely": "database_relational",
  "mongoose": "database_nosql",
  "pinecone-client": "database_vector",
  "redis": "database_kv",
  "memcached": "database_kv",
  "kafka-node": "message_broker",
  "bullmq": "message_broker",
  "celery": "message_broker",
  "jest": "testing",
  "vitest": "testing",
  "playwright": "testing",
  "winston": "observability",
  "pino": "observability"
}
```

Target size: ~500-1000 entries across all ecosystems. Grows as the team adds entries when patterns prove insufficient.

### Layer 3: source-native metadata mappers

Each source can provide a `mapMetadataToCategory(rawEntry) → category | null` function:

- **PyPI:** map `classifiers` entries like `"Framework :: Django"` → `framework_web`, `"Topic :: Database"` → `database_relational`, `"Topic :: Scientific/Engineering :: Artificial Intelligence"` → `ai_platform`. PyPI classifiers cover ~60% of packages.
- **crates.io:** map their categories (`web-programming::http-server` → `framework_web`, `database` → `database_relational`, etc.).
- **Maven:** map by groupId prefix (`org.springframework.*` → `framework_web`).
- **npm:** no useful native taxonomy; this layer always returns null for npm.
- **AWS/GCP/Azure:** category is determined by the source class itself (it's just AWS/GCP/Azure services and the sub-categorization mapping is hardcoded per cloud).

### Layer 4: LLM batch classification

One Anthropic Message Batch per import run, submitted after layers 1–3 complete. Uses Haiku 4.5 with tool-use for structured output. Per-item prompt template:

```
You are categorizing software packages for a developer-resume system.

Package: {raw_name}
Ecosystem: {ecosystem}
Description: {description or "(none provided)"}
{Popularity context if available}
{Keywords if available}
{README excerpt — first 300 chars — if available}

Decide:
1. Is this technology-worthy for a resume?
   - "yes": a recognizable framework, database, tool, platform, or service
     that an engineer would list as a skill
   - "no": utility library, polyfill, type definition, internal tooling
   - "maybe": genuinely unclear

2. If yes, choose ONE category from this list:
   [language, framework_web, framework_mobile, framework_ml, runtime,
    database_relational, database_nosql, database_vector, database_search,
    database_kv, message_broker, observability, cloud_compute, cloud_storage,
    cloud_database, cloud_serverless, cloud_networking, cloud_security, iac,
    ci_cd, container_runtime, orchestration, api_protocol, testing,
    build_tool, package_manager, auth, payment, ai_platform]

Use the `classify_package` tool to respond.
```

Tool schema (`classify_package`, `additionalProperties: false`):

```json
{
  "decision": { "type": "string", "enum": ["yes", "no", "maybe"] },
  "category": { "type": ["string", "null"], "enum": [<the 28 categories>, null] },
  "reasoning": { "type": "string", "maxLength": 200 }
}
```

Expected cost: ~$0.50–$1.50 per import run (5,000 prompts × Haiku batch pricing). Runs every import; not amortized across runs because each run sees a different set of unresolved entries.

## Alias generation rules

`AliasGenerator.generate(entry, source) → string[]` produces candidate aliases. Then `aliasFilters` strips collisions before insert.

### Generic rules (all sources)

```
canonical_name as-is                          → "react"
display_name.toLowerCase()                    → "react"
display_name.toLowerCase().replace(/ /g, '')  → "amazons3"
display_name.toLowerCase().replace(/ /g, '-') → "amazon-s3"
```

### npm-specific

```
package name without scope                    → "core" for "@nestjs/core" (only if descriptive)
name + ".js" / name + "js"                    → "react.js", "reactjs"
keywords filtered for tech-name shape         → drops "frontend", "ui"; keeps "k8s", "graphql"
```

### AWS-specific

```
endpointPrefix (lowercase)                    → "s3"
serviceAbbreviation.toLowerCase()             → "amazon s3"
"aws " + serviceId.toLowerCase()              → "aws s3"
common short forms hardcoded per service      → "lambda" for "aws_lambda"
SDK package names (npm + pypi)                → "@aws-sdk/client-lambda", "boto3"
```

### GCP-specific

```
service_prefix (e.g., "compute", "storage")   → "compute"
"gcp " + service_prefix                       → "gcp compute"
"google " + display name minus "API"          → "google compute engine"
SDK package names                             → "@google-cloud/compute"
```

### Azure-specific

Similar pattern to GCP, with `"azure "` prefix variants.

### Maven-specific

```
artifactId                                    → "spring-core"
artifactId without dashes                     → "springcore"
groupId:artifactId fully-qualified            → "org.springframework:spring-core"
```

### Collision handling

For each generated alias, check `technology_aliases` for existing rows:
- **No collision:** insert.
- **Collision with same technology_id:** no-op (already aliased).
- **Collision with different technology_id:** skip insertion, log to `import_runs.notes` for review.

The skipped collision count flowing into review is a signal for ontology cleanup (the two entries may need to be merged or genuinely ambiguous and require ecosystem-scoped aliases — a Phase 2+ schema change).

## Infra (governed by the `k8s-new-service` skill at plan time)

- Multi-stage Dockerfile: builder stage (yarn workspace build of `@bedrock/shared` + `@bedrock/ontology-importer`), runtime stage `node:22-alpine` + `COPY --from=...` of cloned `botocore` repo at a pinned commit.
- Helm chart: a `CronJob` resource + a separate `Job` template for ad-hoc runs.
- Secrets required (via External Secrets Operator):
  - `ANTHROPIC_API_KEY` for the Message Batches API.
  - `GCP_SA_JSON` for BigQuery access (PyPI download stats).
  - `GITHUB_TOKEN` for the Azure REST API specs repo (optional but avoids rate limits).
- ArgoCD Application + CI image build, following the existing service patterns.
- Resource requests: 500m CPU / 1Gi memory request; 2000m / 4Gi limits. Import runs are CPU-bursty (parsing) and memory-stable (streaming).
- Single-pod concurrency (`concurrencyPolicy: Forbid` on the CronJob). No two runs of the same source in parallel.

## Testing (TDD, jest, per-repo convention)

- **Unit per source:** recorded fixture (real API response JSON) → assert correct `RawImportEntry` stream output. One fixture per source minimum.
- **Categorizer:**
  - Layer 1: pattern rules against ~50 known inputs (covers each category at least once).
  - Layer 2: overrides lookups against ~30 inputs.
  - Layer 3: per-source metadata mappers (PyPI classifiers, crates.io categories) against fixtures.
  - Layer 4: LLM batch is mocked (don't make real Anthropic calls in unit tests) — verify batch request shape and result-processing logic.
- **AliasGenerator:** parametrized tests covering scoped npm packages, AWS service variants, Maven artifacts, common short-form expansions.
- **Importer idempotency:** seed pg with 100 ontology rows, run importer against a fixture twice, assert second run produces zero inserts/updates beyond `last_seen_at` touches.
- **Deactivation policy:** simulate N runs missing an entry, assert `is_active` flips after the configured threshold.
- **Run summary:** assert metric values match the actual upsert counts (numerical correctness).

Integration smoke test: in CI, run the importer against a tiny fixture (10 entries per source) end-to-end against a test pg, assert all expected tables get populated and no orphan rows exist.

## Observability

Prometheus metrics emitted per run:

- `ontology_import_duration_seconds{source}` histogram
- `ontology_import_entries_total{source,outcome="inserted|updated|skipped|deactivated"}` counter
- `ontology_import_llm_batch_duration_seconds{source}` histogram
- `ontology_import_llm_cost_usd{source}` gauge (computed from token usage)
- `ontology_import_review_queue_depth` gauge (sampled, not per-run)
- `ontology_import_resolution_rate{ecosystem}` gauge (computed post-import via SQL query)

Alerts:
- `ontology_import_duration_seconds > 4h` (warn) — source API or batch is slow
- `ontology_import_entries_total{outcome="inserted"} == 0 AND source=*` for a run (warn) — possible source API change
- `ontology_import_review_queue_depth > 500` (warn) — review backlog growing

Wire into the same Alertmanager → self-healing MCP agent path used by other services.

## Explicitly out of scope (deferred)

- **Embedding-based ontology search (pgvector on `technology_ontology`).** Would enable fuzzy resolution at extraction time. Worth doing in a later phase but adds embedding cost and inference latency to the hot path.
- **Cross-ecosystem entity unification beyond simple alias matching.** Recognizing that `@aws-sdk/client-s3` and `aws_s3` are conceptually the same canonical (not just aliased) requires graph-level merging logic that's a separate spec.
- **User-facing ontology admin UI.** Review queue processing is via SQL + a CLI tool initially.
- **Full deletion of ontology entries.** Only deactivation (`is_active = false`). Cleanup of permanently-dead entries is a separate maintenance task that needs careful evidence-table handling.
- **Real-time package monitoring** (catching newly published popular packages as they trend). Monthly cadence is sufficient for Tucaken's needs.
- **Backfilling existing `technology_evidence` rows with newly-resolvable canonicals** when the ontology expands. This is the responsibility of the separate "ontology backfill worker" called out in the Layer 1 spec's open question #4.
- **License compliance auditing of imported entries** (e.g., flagging GPL-only packages if Tucaken cares). Out of scope; revisit if it becomes a product concern.

## Open questions for spec review

1. **LLM batch follow-up trigger.** Two options:
   - **Polling CronJob** that runs every 30min and checks for `import_runs` with `llm_batch_status='pending'` and a batch_id, then polls the Anthropic API for completion.
   - **Webhook-based** completion using Anthropic's batch webhook (if available — needs verification).

   Default: **polling**. Simpler, no inbound webhook surface, no Anthropic webhook coupling. Tradeoff is up to 30min latency between batch completion and result processing — acceptable for a monthly process.

2. **Curated entries — should auto-import update their popularity_score?**
   - Yes: popularity is just a metric, useful for downstream ranking, and the auto-import sees authoritative download stats.
   - No: curated entries are sacrosanct; nothing about an import run should touch them.

   Default: **yes, update popularity_score**. Category, display_name, and curated aliases remain protected.

3. **Deactivation threshold.** When does `consecutive_misses` trigger `is_active = false`?
   - Quarterly imports × N=3 misses = ~9 months of absence.
   - Monthly imports × N=3 misses = ~3 months.

   Default: **N=3 with monthly cadence (3-month absence triggers deactivation)**. Adjustable per source — AWS services rarely disappear, npm packages routinely get deprecated.

4. **Should the LLM batch include source context beyond name + description?**
   - Pro: README excerpts and keywords improve classification accuracy.
   - Con: Each prompt grows from ~150 tokens to ~500 tokens, tripling batch cost ($1.50 → $4.50 per run).

   Default: **include keywords always, README excerpt only for items where description is empty or generic ("A library for X")**. Heuristic enrichment that balances cost and accuracy.

5. **Category accuracy spot-check — automated or manual?**
   - Manual: 200 entries reviewed by a human after each big run. ~30min per quarterly review.
   - LLM-as-judge: a second LLM pass evaluating Layer 4 decisions against a reference set of known-correct categorizations.

   Default: **manual quarterly review** of a 200-row sample. The LLM-as-judge route adds complexity and circular-dependency concerns (the same model evaluating its own categorizations); manual review provides ground truth.

## Reference

This spec implements Tier 2 of the three-tier ontology model described in the ontology-seeding strategy (curated + auto-imported + extraction-discovered candidates). Tier 1 (curated 100–150) is handled by the seed migration accompanying `034_technology_graph.sql`. Tier 3 (candidate review loop) is implemented in `@bedrock/tech-extractor` (writes to `technology_candidates`) with the review-loop tooling tracked separately.

The shared concern across all tiers — and the reason Tier 2 matters most — is the Layer 1 extraction's reliance on `OntologyResolver`. Without Tier 2's breadth, the resolver returns NULL too often, evidence rows accumulate with unmatched `raw_name` values, and downstream skill matching can't filter or rank reliably. Tier 2 is what makes the deterministic-extraction architecture actually usable at scale.