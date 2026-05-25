# Tier 2 Ontology Importer — Plan 3: LLM Batch Classifier + Entrypoints + Infra

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Also REQUIRED:** the `claude-api` skill for the Anthropic Batch API + prompt caching, and the `k8s-new-service` skill for the cluster CronJob/ArgoCD wiring.

**Goal:** Complete the `@bedrock/ontology-importer` service: the Layer-4 LLM batch classifier (Anthropic Message Batches, Haiku 4.5, with prompt caching), the review-queue/skipped repos + the ontology write repo that backs the Plan-1 importer port, the two entrypoints (`run-import.ts`, `run-llm-batch-followup.ts`), and the infra (Dockerfile with botocore, Helm CronJob, ArgoCD, CI, chart `migration-011`).

**Architecture:** `run-import.ts` iterates `ALL_SOURCES`, runs the Plan-1 `OntologyImporter` (DB-backed via the new `OntologyWriteRepository`), runs the per-source deactivation pass, then submits one Anthropic **Message Batch** of the `unresolved` entries and marks the run `partial`. `run-llm-batch-followup.ts` (polling CronJob) retrieves completed batches and routes results to ontology / skipped / review-queue, finalizing the run. Runs as a monthly CronJob.

**Tech Stack:** `@anthropic-ai/sdk` (Message Batches, Haiku 4.5, prompt caching), `pg`, `prom-client`, Docker (+ cloned `botocore`), Helm CronJob, ArgoCD, ESO.

**Depends on:** Plan 1 (importer engine, `OntologyWritePort`, tracking repos, migration 036) + Plan 2 (`ALL_SOURCES`).

**Spec:** `tier2-ontology-auto-import.md` §Layer 4, §Data flow, §Infra, §Observability.

---

## File Structure

- Create `applications/shared/src/rds/implementations/OntologyWriteRepository.ts` (+ test) — implements `OntologyWritePort`.
- Create `applications/shared/src/rds/implementations/OntologyReviewQueueRepository.ts` + `OntologySkippedImportRepository.ts` (+ tests).
- Create `applications/ontology-importer/src/categorization/LlmBatchClassifier.ts` (+ test).
- Create `applications/ontology-importer/src/env.ts`, `src/run-import.ts`, `src/run-llm-batch-followup.ts`.
- Create `applications/ontology-importer/src/metrics.ts`.
- Create `applications/ontology-importer/Dockerfile`, `.dockerignore`.
- Cluster (kubernetes-bootstrap): `charts/platform-rds/.../ddl-migrations.yaml` → `migration-011-ontology-import-tracking`; `charts/ontology-importer/` (CronJob + Job + SA + RBAC + ESO); `argocd-apps/eks/development/ontology-importer.yaml` + `-secrets.yaml`.
- cdk-monitoring: ECR repo `ontology-importer` + image SSM; ai-applications CI `deploy-ontology-importer.yml`.

---

## Task 1: OntologyWriteRepository (backs the importer port)

**Files:** `applications/shared/src/rds/implementations/OntologyWriteRepository.ts` (+ `.test.ts`); barrel exports.

Implements the Plan-1 `OntologyWritePort`: `findByCanonical`, `insertAutoImported`, `bumpPopularity`, `loadAliasMap`, `insertAliases`.

- [ ] **Step 1: Failing test** (fake-pool, capture SQL+params)

```ts
/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { OntologyWriteRepository } from './OntologyWriteRepository.js';

function fakePool(rows: unknown[] = []) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  return { calls, query: jest.fn(async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return { rows, rowCount: rows.length }; }) };
}

describe('OntologyWriteRepository', () => {
  it('findByCanonical returns id+curationLevel or null', async () => {
    const hit = new OntologyWriteRepository(fakePool([{ id: 'x', curation_level: 'curated' }]) as never);
    expect(await hit.findByCanonical('react')).toEqual({ id: 'x', curationLevel: 'curated' });
    const miss = new OntologyWriteRepository(fakePool([]) as never);
    expect(await miss.findByCanonical('nope')).toBeNull();
  });
  it('insertAutoImported inserts curation_level auto_imported and returns id', async () => {
    const pool = fakePool([{ id: 'new-1' }]);
    const repo = new OntologyWriteRepository(pool as never);
    const id = await repo.insertAutoImported('fastify', 'Fastify', 'framework_web', 'npm_top_5k');
    expect(id).toBe('new-1');
    expect(pool.calls[0].sql).toContain("'auto_imported'");
    expect(pool.calls[0].params).toEqual(expect.arrayContaining(['fastify', 'Fastify', 'framework_web']));
  });
  it('bumpPopularity is additive and only raises', async () => {
    const pool = fakePool();
    await new OntologyWriteRepository(pool as never).bumpPopularity('x', 100);
    expect(pool.calls[0].sql).toContain('popularity_score = GREATEST(popularity_score');
  });
  it('insertAliases inserts each with ON CONFLICT DO NOTHING, returns count', async () => {
    const pool = fakePool([{}, {}]);
    const n = await new OntologyWriteRepository(pool as never).insertAliases('x', ['a', 'b'], 'npm_top_5k');
    expect(pool.calls[0].sql).toContain('INSERT INTO technology_aliases');
    expect(pool.calls[0].sql).toContain('ON CONFLICT (alias) DO NOTHING');
    expect(n).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run → fail. Step 3: Implement**

```ts
/** @format */
import type { Pool } from 'pg';

export class OntologyWriteRepository {
  constructor(private readonly pool: Pool) {}

  async findByCanonical(canonical: string): Promise<{ id: string; curationLevel: string } | null> {
    const { rows } = await this.pool.query<{ id: string; curation_level: string }>(
      `SELECT id, curation_level FROM technology_ontology WHERE canonical_name = $1`, [canonical]);
    return rows[0] ? { id: rows[0].id, curationLevel: rows[0].curation_level } : null;
  }

  async insertAutoImported(canonical: string, display: string, category: string, source: string): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO technology_ontology (canonical_name, display_name, category, curation_level, source)
       VALUES ($1, $2, $3, 'auto_imported', $4)
       ON CONFLICT (canonical_name) DO UPDATE SET canonical_name = EXCLUDED.canonical_name
       RETURNING id`,
      [canonical, display, category, source]);
    return rows[0].id;
  }

  async bumpPopularity(id: string, popularity: number | null): Promise<void> {
    if (popularity == null) return;
    await this.pool.query(
      `UPDATE technology_ontology SET popularity_score = GREATEST(popularity_score, $2) WHERE id = $1`,
      [id, popularity]);
  }

  async loadAliasMap(): Promise<Map<string, string>> {
    const { rows } = await this.pool.query<{ alias: string; technology_id: string }>(`SELECT alias, technology_id FROM technology_aliases`);
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.alias, r.technology_id);
    return m;
  }

  async insertAliases(technologyId: string, aliases: string[], source: string): Promise<number> {
    let inserted = 0;
    for (const a of aliases) {
      const { rowCount } = await this.pool.query(
        `INSERT INTO technology_aliases (alias, technology_id, source) VALUES ($1, $2::uuid, $3)
         ON CONFLICT (alias) DO NOTHING`, [a, technologyId, source]);
      inserted += rowCount ?? 0;
    }
    return inserted;
  }
}
```

> Note: `insertAutoImported`'s `ON CONFLICT … DO UPDATE SET canonical_name = EXCLUDED.canonical_name … RETURNING id` is the idempotent "insert-or-get-id" idiom (a plain `DO NOTHING` returns no row on conflict). Curated rows are never reached here — the importer only calls this for `findByCanonical === null`.

- [ ] **Step 4: Run → pass. Step 5: barrel exports + build shared. Commit:** `feat(rds): add OntologyWriteRepository`

---

## Task 2: Review-queue + skipped-imports repositories

**Files:** `OntologyReviewQueueRepository.ts`, `OntologySkippedImportRepository.ts` (+ tests); barrel exports.

- [ ] **Step 1: Failing tests** — `OntologyReviewQueueRepository.add({ rawName, ecosystem, source, reason, suggestedCategory? , llmReasoning? })` → `INSERT INTO ontology_review_queue … ON CONFLICT (raw_name, ecosystem) DO NOTHING`; `OntologySkippedImportRepository.add({ rawName, ecosystem, source, llmReasoning, llmRunId })` → `INSERT INTO ontology_skipped_imports … ON CONFLICT (raw_name, ecosystem) DO NOTHING`. Fake-pool, assert SQL + params.
- [ ] **Step 2: Implement** both as thin constructor-`Pool` repos with a single `add(...)` method (parameterised INSERT … ON CONFLICT DO NOTHING). Mirror `TechnologyCandidateRepository` style.
- [ ] **Step 3: Run → pass. Barrel exports + build. Commit:** `feat(rds): add ontology review-queue + skipped-import repositories`

---

## Task 3: LlmBatchClassifier (Layer 4 — Anthropic Message Batches)

**Files:** `applications/ontology-importer/src/categorization/LlmBatchClassifier.ts` (+ `.test.ts`)

Pure, testable seams: `buildBatchRequests(entries)` → Anthropic batch request array (system prompt + `classify_package` tool, **prompt caching** on the shared system+tool blocks, Haiku 4.5), and `parseBatchResult(customId, message)` → `{ decision, category, reasoning }`. The SDK submit/retrieve calls are thin and mocked in tests.

- [ ] **Step 1: Failing test**

```ts
/** @format */
import { describe, it, expect } from '@jest/globals';
import { buildBatchRequests, parseBatchResult, MODEL } from './LlmBatchClassifier.js';
import type { RawImportEntry } from '@bedrock/shared';

const E = (o: Partial<RawImportEntry>): RawImportEntry =>
  ({ source_identifier: '', proposed_canonical_name: '', proposed_display_name: '', source_metadata: {}, ...o });

describe('buildBatchRequests', () => {
  it('one request per entry, Haiku, cached system + classify_package tool', () => {
    const reqs = buildBatchRequests([E({ source_identifier: 'fastify', proposed_canonical_name: 'fastify', description: 'web framework' })], 'npm');
    expect(reqs).toHaveLength(1);
    const p = reqs[0].params;
    expect(p.model).toBe(MODEL);
    expect(p.tools?.[0]?.name).toBe('classify_package');
    // prompt caching marker on the system block
    expect(JSON.stringify(p.system)).toContain('cache_control');
    expect(reqs[0].custom_id).toContain('fastify');
  });
});

describe('parseBatchResult', () => {
  it('extracts the classify_package tool_use input', () => {
    const msg = { content: [{ type: 'tool_use', name: 'classify_package', input: { decision: 'yes', category: 'framework_web', reasoning: 'web fw' } }] };
    expect(parseBatchResult('npm:fastify', msg as never)).toEqual({ decision: 'yes', category: 'framework_web', reasoning: 'web fw' });
  });
  it('defaults to maybe/null when no tool_use', () => {
    expect(parseBatchResult('x', { content: [{ type: 'text', text: 'hi' }] } as never)).toMatchObject({ decision: 'maybe', category: null });
  });
});
```

- [ ] **Step 2: Run → fail. Step 3: Implement** (per the `claude-api` skill: Haiku 4.5, tool-use structured output, `cache_control` on the system + tool blocks so the ~shared prefix is cached across the batch)

```ts
/** @format */
import Anthropic from '@anthropic-ai/sdk';
import type { RawImportEntry, OntologyCategory, CategorizationResult } from '@bedrock/shared';
import { ONTOLOGY_CATEGORIES } from '@bedrock/shared';

export const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM = [
  { type: 'text' as const,
    text: 'You categorize software packages for a developer-resume system. Decide if a package is technology-worthy (yes/no/maybe) and pick exactly one category.',
    cache_control: { type: 'ephemeral' as const } },
];

const TOOL = {
  name: 'classify_package',
  description: 'Record the classification decision for a package.',
  input_schema: {
    type: 'object' as const,
    properties: {
      decision: { type: 'string', enum: ['yes', 'no', 'maybe'] },
      category: { type: ['string', 'null'], enum: [...ONTOLOGY_CATEGORIES, null] },
      reasoning: { type: 'string', maxLength: 200 },
    },
    required: ['decision', 'category', 'reasoning'],
    additionalProperties: false,
  },
  cache_control: { type: 'ephemeral' as const },
};

export interface BatchRequest { custom_id: string; params: Anthropic.Messages.MessageCreateParamsNonStreaming }

export function buildBatchRequests(entries: RawImportEntry[], ecosystem: string): BatchRequest[] {
  return entries.map((e) => ({
    custom_id: `${ecosystem}:${e.source_identifier}`.slice(0, 64),
    params: {
      model: MODEL, max_tokens: 256, system: SYSTEM, tools: [TOOL],
      tool_choice: { type: 'tool', name: 'classify_package' },
      messages: [{ role: 'user', content:
        `Package: ${e.source_identifier}\nEcosystem: ${ecosystem}\nDescription: ${e.description ?? '(none)'}\n` +
        `Keywords: ${(e.keywords ?? []).join(', ') || '(none)'}` }],
    },
  }));
}

export function parseBatchResult(customId: string, message: { content?: Array<{ type: string; name?: string; input?: unknown }> }): Pick<CategorizationResult, 'decision' | 'category' | 'reasoning'> {
  const tu = (message.content ?? []).find((b) => b.type === 'tool_use' && b.name === 'classify_package');
  if (!tu?.input) return { decision: 'maybe', category: null, reasoning: 'no tool_use' };
  const i = tu.input as { decision?: string; category?: string | null; reasoning?: string };
  return {
    decision: (i.decision as 'yes' | 'no' | 'maybe') ?? 'maybe',
    category: (i.category as OntologyCategory | null) ?? null,
    reasoning: i.reasoning,
  };
}

/** Thin SDK shell (mocked in tests). */
export class LlmBatchClassifier {
  private readonly client: Anthropic;
  constructor(apiKey = process.env.ANTHROPIC_API_KEY) { this.client = new Anthropic({ apiKey }); }
  async submit(requests: BatchRequest[]): Promise<string> {
    const batch = await this.client.messages.batches.create({ requests: requests as never });
    return batch.id;
  }
  async retrieve(batchId: string): Promise<{ status: string }> { return this.client.messages.batches.retrieve(batchId); }
  results(batchId: string): ReturnType<Anthropic['messages']['batches']['results']> { return this.client.messages.batches.results(batchId); }
}
```

- [ ] **Step 4: Run → pass. Commit:** `feat(ontology-importer): add LLM batch classifier (Haiku 4.5 + prompt caching)`

---

## Task 4: env + metrics + `run-import.ts` entrypoint

**Files:** `src/env.ts`, `src/metrics.ts`, `src/run-import.ts`

- [ ] **Step 1: env.ts** — required `PG_*`, `ANTHROPIC_API_KEY`; optional `TRIGGERED_BY` (default `cronjob`), `DEACTIVATION_THRESHOLD` (default 3), `SOURCES` (CSV filter, default all). Mirror `applications/tech-extractor/src/env.ts`.
- [ ] **Step 2: metrics.ts** — `prom-client` registry + the spec's metrics: `ontology_import_duration_seconds{source}` histogram, `ontology_import_entries_total{source,outcome}` counter, `ontology_import_review_queue_depth` gauge, `ontology_import_resolution_rate{ecosystem}` gauge. Mirror `applications/tech-extractor` observability bootstrap (`bootstrapK8sObservability` from `@bedrock/shared`).
- [ ] **Step 3: run-import.ts** (no unit test — wiring; covered by Task 8 smoke). Orchestration, mirroring `run-tech-extract.ts` structure (observability bootstrap, try/finally, time-boxed teardown):

```ts
/** @format */
import { Pool } from 'pg';
import { OntologyImportRunRepository, OntologyImportSourceRepository, OntologyWriteRepository, bootstrapK8sObservability, pushFinalMetrics } from '@bedrock/shared';
import { parseEnv } from './env.js';
import { ALL_SOURCES } from './sources/index.js';
import { Categorizer } from './categorization/Categorizer.js';
import { OntologyImporter } from './importer/OntologyImporter.js';
import { shouldDeactivate } from './importer/DeactivationDetector.js';
import { LlmBatchClassifier, buildBatchRequests } from './categorization/LlmBatchClassifier.js';

const obs = bootstrapK8sObservability({ serviceName: 'ontology-importer' });
const log = obs.logger;

async function main(): Promise<void> {
  const env = parseEnv();
  const pool = new Pool({ ...env.pg, max: 3 });
  const runs = new OntologyImportRunRepository(pool);
  const ontology = new OntologyWriteRepository(pool);
  const importSources = new OntologyImportSourceRepository(pool);
  const importer = new OntologyImporter(new Categorizer(), ontology, importSources);
  const llm = new LlmBatchClassifier(env.anthropicApiKey);

  try {
    for (const source of ALL_SOURCES()) {
      if (env.sources && !env.sources.includes(source.name)) continue;
      const runStart = new Date();
      const runId = await runs.begin(source.name, env.triggeredBy);
      try {
        const { counts, unresolved } = await importer.run(source, runStart);
        // Deactivation pass: bump misses, then deactivate per policy.
        await importSources.incrementMissesOlderThan(source.name, runStart);
        // (deactivation of is_active handled by a SQL UPDATE keyed on shouldDeactivate threshold — see env.deactivationThreshold)
        // LLM batch for the unresolved tail.
        let llmBatchId: string | undefined;
        if (unresolved.length > 0) {
          llmBatchId = await llm.submit(buildBatchRequests(unresolved, source.ecosystem));
        }
        await runs.finish(runId, unresolved.length > 0 ? 'partial' : 'success', counts, { llmBatchId });
        log.info({ source: source.name, ...counts, llmBatchId }, 'import.source.complete');
      } catch (err) {
        await runs.finish(runId, 'failed', { entriesFetched: 0, entriesInserted: 0, entriesUpdated: 0, entriesDeactivated: 0, aliasMerges: 0, unresolvedCount: 0, reviewQueueAdded: 0 }, { errorSummary: String(err) }).catch(() => {});
        log.error({ source: source.name, err: String(err) }, 'import.source.failed');
      }
    }
  } finally {
    await pool.end().catch(() => {});
    await pushFinalMetrics(obs.registry, 'ontology-importer', `import_${Date.now()}`).catch(() => {});
    await obs.shutdown().catch(() => {});
  }
}
main().then(() => process.exit(0)).catch((e) => { log.error({ err: String(e) }, 'failed'); process.exit(1); });
```

> Verify `shouldDeactivate`/`DEACTIVATION_THRESHOLD` wiring: implement the deactivation as a SQL `UPDATE technology_ontology SET is_active=false WHERE id IN (SELECT technology_id FROM ontology_import_sources WHERE source=$1 AND consecutive_misses >= $2)` in `OntologyImportSourceRepository.deactivateStale(source, threshold)`; call it after `incrementMissesOlderThan` and add its count to `counts.entriesDeactivated`. (Add that repo method + a fake-pool test in this task.)

- [ ] **Step 4: Build** (`yarn workspace @bedrock/ontology-importer build`). **Commit:** `feat(ontology-importer): add run-import entrypoint + metrics`

---

## Task 5: `run-llm-batch-followup.ts` (polling)

**Files:** `src/run-llm-batch-followup.ts`

Polling job: find `ontology_import_runs` with `status='partial'` + `llm_batch_id` set; for each, retrieve the batch; if completed, stream results and route each via `parseBatchResult`:
- `yes` + category → `ontology.insertAutoImported` + aliases + `importSources.upsertSeen`.
- `no` → `OntologySkippedImportRepository.add`.
- `maybe`/null → `OntologyReviewQueueRepository.add`.
Then `runs.finish(runId, 'success', …)` with final counts.

- [ ] **Step 1:** Add `OntologyImportRunRepository.findPendingBatches()` → rows with `status='partial' AND llm_batch_id IS NOT NULL` (+ fake-pool test).
- [ ] **Step 2:** Write `run-llm-batch-followup.ts` (wiring; no unit test — Task 8 smoke covers the routing via a mocked classifier). Mirror `run-import.ts` bootstrap/teardown. Map the custom_id (`<ecosystem>:<identifier>`) back to the entry for insertion.
- [ ] **Step 3: Build. Commit:** `feat(ontology-importer): add LLM batch follow-up job`

---

## Task 6: Dockerfile (+ botocore)

**Files:** `applications/ontology-importer/Dockerfile`, `.dockerignore`

- [ ] **Step 1:** Multi-stage, mirroring `applications/tech-extractor/Dockerfile` (syntax `docker/dockerfile:1`; builder builds `@bedrock/shared` + `@bedrock/ontology-importer`; **all workspace manifests COPY'd** incl. `applications/ontology-importer` AND `applications/synthetic-monitor` — the lesson from the tech-extractor build). Runtime `node:22-alpine`, non-root, read-only copied artifacts (`--chmod=0555`/`0444` as in tech-extractor). Add a **botocore** stage: `FROM alpine/git AS botocore` → `git clone --depth 1 --branch <pinned-tag> https://github.com/boto/botocore /botocore`; runtime `COPY --from=botocore /botocore/botocore/data /opt/botocore/botocore/data` and `ENV BOTOCORE_DATA_DIR=/opt/botocore/botocore/data`. CMD `node dist/run-import.js`.
- [ ] **Step 2:** `.dockerignore` mirrors tech-extractor's. (Local docker build optional — CI is the gate.)
- [ ] **Step 3: Commit:** `feat(ontology-importer): add Dockerfile with botocore data`

---

## Task 7: CI + ECR + chart + ArgoCD + chart migration-011

**Files:** ai-applications `.github/workflows/deploy-ontology-importer.yml`; cdk-monitoring shared-vpc ECR; kubernetes-bootstrap `charts/ontology-importer/` + `argocd-apps/eks/development/ontology-importer{,-secrets}.yaml` + `ddl-migrations.yaml` migration-011.

- [ ] **Step 1: chart migration-011** — append `migration-011-ontology-import-tracking` to `kubernetes-bootstrap/charts/platform-rds/chart/templates/ddl-migrations.yaml`, porting the **036** SQL (Plan-1 Task 1) into a PostSync hook (mirror migration-009/010 exactly). `helm lint`.
- [ ] **Step 2: ECR** (cdk-monitoring shared-vpc) — add `ontology-importer` ECR repo + SSM, mirroring the `tech-extractor` block. Test + PR to **main**.
- [ ] **Step 3: CI** — `deploy-ontology-importer.yml` mirroring `deploy-tech-extractor.yml` (ecr-ssm `/shared/ecr-ontology-importer/...`, image-ssm `/k8s/development/job-images/ontology-importer`). Add `ontology-importer` to the `admin-api-job-images` keys is NOT needed (importer is a CronJob, not admin-api-dispatched) — instead the CronJob references the image via its own ESO/SSM (see chart).
- [ ] **Step 4: chart `charts/ontology-importer/`** (via `k8s-new-service`): namespace + SA (Pod Identity only if BigQuery via workload identity; otherwise GCP_SA_JSON via ESO) + **CronJob** (`schedule: "0 2 1 * *"`, `concurrencyPolicy: Forbid`, `restartPolicy: Never`, resources 500m/1Gi req, 2000m/4Gi lim) running `node dist/run-import.js`, plus a **Job** template for the follow-up (`run-llm-batch-followup.js`) on a 30-min CronJob, plus ESO `ExternalSecret`s: `ANTHROPIC_API_KEY` (SM), `GCP_SA_JSON` (SM, for BigQuery), `platform-rds-credentials`. Image from the importer ECR via SSM.
- [ ] **Step 5: ArgoCD apps** — `argocd-apps/eks/development/ontology-importer.yaml` (chart) + `ontology-importer-secrets.yaml`, mirroring the tech-extractor EKS apps (wave 8 / wave 2).
- [ ] **Step 6:** `helm lint`; commit each repo's change on its own branch/PR (ai-applications→develop, cdk-monitoring→main, kubernetes-bootstrap→main), `git-commit` skill each.

---

## Task 8: Integration smoke

**Files:** `applications/ontology-importer/src/__tests__/integration.test.ts`

- [ ] **Step 1:** In-process: `FakeSource` (Plan 1) → `OntologyImporter` with in-memory ports → assert inserts/updates/unresolved; then feed the `unresolved` through a **mocked** `LlmBatchClassifier` (stub `parseBatchResult` outcomes: one `yes`, one `no`, one `maybe`) and assert routing to ontology-insert / skipped / review-queue stubs. No network, no real Anthropic/pg.
- [ ] **Step 2:** Full suite + build. **Commit:** `test(ontology-importer): add end-to-end import + batch-routing smoke`

---

## Self-Review

**Spec coverage (Plan 3):**
- Layer 4 LLM batch (Haiku 4.5, tool-use, prompt caching) → Task 3 ✓
- Review-queue + skipped-imports persistence → Task 2 ✓; ontology write path → Task 1 ✓
- `run-import.ts` data flow (run tracking, deactivation pass, batch submit, `partial` status) → Task 4 ✓
- `run-llm-batch-followup.ts` (polling, result routing) → Task 5 ✓
- Dockerfile + botocore → Task 6; CronJob/Job + ArgoCD + ECR + CI + chart migration-011 → Task 7 ✓
- Prometheus metrics → Task 4 (metrics.ts) ✓
- Idempotency: insert-or-get-id, `ON CONFLICT DO NOTHING` aliases, additive popularity, batch keyed by run → Tasks 1,3,4 ✓
- *Open-question defaults honored:* polling follow-up (not webhook); curated popularity updated (GREATEST, never lowered); deactivation N=3; keywords always in prompt (README excerpt deferred); manual category spot-check (no LLM-judge).

**Placeholder scan:** Tasks 4/5/7 mark the entrypoints + infra as wiring (no unit test) with the orchestration shown concretely and the I/O seams (repos, classifier) fully unit-tested in Tasks 1–3; infra mirrors the Tier-1 tech-extractor patterns with explicit deltas. No vague code placeholders.

**Type consistency:** `OntologyWriteRepository` implements the Plan-1 `OntologyWritePort` exactly (`findByCanonical/insertAutoImported/bumpPopularity/loadAliasMap/insertAliases`); `buildBatchRequests`/`parseBatchResult`/`MODEL`, the run-repo methods (`begin/finish/findPendingBatches`), and `OntologyImportSourceRepository.{upsertSeen,incrementMissesOlderThan,deactivateStale}` are defined once and reused across entrypoints.
```
