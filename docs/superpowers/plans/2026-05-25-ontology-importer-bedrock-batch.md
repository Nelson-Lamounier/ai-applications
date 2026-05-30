# Ontology Importer — Bedrock Batch Inference Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `@bedrock/ontology-importer` Layer-4 LLM backend (Anthropic Message Batches) with AWS Bedrock Batch Inference, authenticated via Pod Identity (no API key), with one pooled batch per run and the IAM/S3 infra to support it.

**Architecture:** A `BedrockBatchClassifier` writes one pooled input JSONL to S3 and calls `CreateModelInvocationJob`; `run-import` records the job on one `pooled_llm_batch` run row (status `partial`) plus a recordId→entry map in the run's `notes`; the `run-llm-batch-followup` CronJob polls `GetModelInvocationJob`, reads the S3 output, and routes results. cdk-monitoring provisions the S3 bucket, the Bedrock batch service role, and the importer Pod Identity; kubernetes-bootstrap drops the Anthropic secret and adds Bedrock env.

**Tech Stack:** TypeScript (CommonJS), `@aws-sdk/client-bedrock` (control plane: Create/Get/StopModelInvocationJob), `@aws-sdk/client-s3`, `pg`, jest (`@jest/globals`), AWS CDK (cdk-monitoring), Helm/ArgoCD (kubernetes-bootstrap).

**Spec:** `docs/superpowers/specs/2026-05-25-ontology-importer-bedrock-batch-design.md`.

**Conventions (verified):**
- ai-applications work is on branch `feat/ontology-importer-bedrock-batch` (off `develop`); PRs target `develop`.
- cdk-monitoring trunk is **`main`**; kubernetes-bootstrap trunk is **`main`** (branch off `origin/main`; kubernetes-bootstrap has unrelated WIP on another branch — use a worktree off `origin/main`).
- No `Co-Authored-By`/AI trailer. Conventional Commits. `/** @format */` headers, `.js` relative import extensions in the importer workspace.
- AWS SDK v3 versions in this repo: `@aws-sdk/client-s3` `^3.1001.0`; use `@aws-sdk/client-bedrock` `^3.1001.0` to match.
- Bedrock Haiku 4.5 model id: `anthropic.claude-haiku-4-5-20251001-v1:0` (eu cross-region profile `eu.anthropic.claude-haiku-4-5-20251001-v1:0` if batch requires/allows a profile — env-configurable).
- Bedrock `recordId` must match `^[a-zA-Z0-9]{1,64}$` → use `r`+zero-padded index, never the old colon-encoding.
- Tests must not hit AWS — SDK clients are mocked; pure functions carry the logic.

---

## File Structure

**ai-applications** (`feat/ontology-importer-bedrock-batch`):
- Modify `applications/ontology-importer/package.json` — deps swap.
- Create `applications/ontology-importer/src/categorization/BedrockBatchClassifier.ts` (+ `.test.ts`) — pure `buildJsonlRecords`/`parseModelOutput` + SDK shell.
- Delete `applications/ontology-importer/src/categorization/LlmBatchClassifier.ts` (+ `.test.ts`).
- Modify `applications/ontology-importer/src/env.ts` — drop Anthropic, add Bedrock/S3/min.
- Modify `applications/shared/src/rds/implementations/OntologyImportRunRepository.ts` (+ `.test.ts`) — `recordBatchRun` + `findPendingBatches` returns `recordMap`.
- Modify `applications/ontology-importer/src/run-import.ts` — pooled batch.
- Modify `applications/ontology-importer/src/run-llm-batch-followup.ts` — Bedrock retrieve/readResults + recordMap routing.
- Modify `applications/ontology-importer/src/__tests__/integration.test.ts` — Bedrock-shaped mock.

**cdk-monitoring** (`feat/ontology-importer-bedrock-batch` off `origin/main`):
- Modify `infra/lib/shared/vpc-stack.ts` — S3 batch bucket + SSM (or a focused stack if vpc-stack is too large; vpc-stack already owns ECR + SSM, so co-locate).
- Modify `infra/lib/stacks/kubernetes/eks-pod-identity-stack.ts` — `ontology-importer` purpose case + batch service role.
- Modify the relevant unit tests under `infra/tests/unit/`.

**kubernetes-bootstrap** (`feat/ontology-importer-bedrock-batch` off `origin/main`, via worktree):
- Delete `charts/ontology-importer/external-secrets/ontology-importer-secrets.yaml`.
- Delete `argocd-apps/eks/development/ontology-importer-secrets.yaml`.
- Modify `charts/ontology-importer/chart/values.yaml` + `templates/import-cronjob.yaml` + `templates/followup-cronjob.yaml` — drop secret envFrom, add Bedrock/S3 env.

---

## Task 1: Swap dependencies (ai-applications)

**Files:**
- Modify: `applications/ontology-importer/package.json`

- [ ] **Step 1: Edit dependencies** — remove `@anthropic-ai/sdk`, add the two AWS SDK clients:

```jsonc
  "dependencies": {
    "@aws-sdk/client-bedrock": "^3.1001.0",
    "@aws-sdk/client-s3": "^3.1001.0",
    "@bedrock/shared": "workspace:*",
    "@google-cloud/bigquery": "^7.9.0",
    "pg": "^8.20.0",
    "prom-client": "^15.1.3",
    "undici": "^7.24.4"
  },
```
(Keep `devDependencies` unchanged.)

- [ ] **Step 2: Install**

Run: `yarn install`
Expected: lockfile updates; resolves `@aws-sdk/client-bedrock` + `@aws-sdk/client-s3`, drops `@anthropic-ai/sdk`.

- [ ] **Step 3: Commit**

```bash
git add applications/ontology-importer/package.json yarn.lock
git commit -m "chore(ontology-importer): swap @anthropic-ai/sdk for aws bedrock+s3 clients"
```

---

## Task 2: BedrockBatchClassifier (pure functions + SDK shell)

**Files:**
- Create: `applications/ontology-importer/src/categorization/BedrockBatchClassifier.ts`
- Test: `applications/ontology-importer/src/categorization/BedrockBatchClassifier.test.ts`
- Delete: `applications/ontology-importer/src/categorization/LlmBatchClassifier.ts` + `.test.ts` (in Step 6)

- [ ] **Step 1: Write the failing test**

```ts
/** @format */
import { describe, it, expect } from '@jest/globals';
import { buildJsonlRecords, parseModelOutput, MODEL_ID_DEFAULT } from './BedrockBatchClassifier.js';
import type { RawImportEntry } from '@bedrock/shared';

const E = (o: Partial<RawImportEntry>): RawImportEntry =>
    ({ source_identifier: '', proposed_canonical_name: '', proposed_display_name: '', source_metadata: {}, ...o });

describe('buildJsonlRecords', () => {
    it('pools entries into alphanumeric recordIds with a Bedrock Messages modelInput', () => {
        const { records, recordMap } = buildJsonlRecords([
            { entry: E({ source_identifier: 'fastify', description: 'web framework' }), ecosystem: 'npm' },
            { entry: E({ source_identifier: 'org.springframework:spring-core' }), ecosystem: 'maven' },
        ]);
        expect(records).toHaveLength(2);
        // recordId is purely alphanumeric (Bedrock constraint ^[a-zA-Z0-9]{1,64}$)
        for (const r of records) expect(r.recordId).toMatch(/^[a-zA-Z0-9]{1,64}$/);
        const mi = records[0].modelInput as Record<string, unknown>;
        expect(mi.anthropic_version).toBe('bedrock-2023-05-31');
        expect(mi.max_tokens).toBe(256);
        expect((mi.tools as Array<{ name: string }>)[0].name).toBe('classify_package');
        expect(mi.tool_choice).toEqual({ type: 'tool', name: 'classify_package' });
        // no prompt caching in batch
        expect(JSON.stringify(mi)).not.toContain('cache_control');
        // recordMap resolves the second record back to its maven identifier
        const r1 = records[1].recordId;
        expect(recordMap[r1]).toEqual({ ecosystem: 'maven', identifier: 'org.springframework:spring-core' });
    });
});

describe('parseModelOutput', () => {
    it('extracts the classify_package tool_use from modelOutput', () => {
        const out = parseModelOutput({
            recordId: 'r0000001',
            modelOutput: { content: [{ type: 'tool_use', name: 'classify_package', input: { decision: 'yes', category: 'framework_web', reasoning: 'web fw' } }] },
        });
        expect(out).toEqual({ recordId: 'r0000001', decision: 'yes', category: 'framework_web', reasoning: 'web fw' });
    });
    it('defaults to maybe/null when no tool_use', () => {
        const out = parseModelOutput({ recordId: 'r0000002', modelOutput: { content: [{ type: 'text' }] } });
        expect(out).toMatchObject({ recordId: 'r0000002', decision: 'maybe', category: null });
    });
    it('defaults to maybe/null when modelOutput missing (errored record)', () => {
        expect(parseModelOutput({ recordId: 'r3' }).decision).toBe('maybe');
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `yarn workspace @bedrock/ontology-importer jest src/categorization/BedrockBatchClassifier.test.ts`
Expected: FAIL — `Cannot find module './BedrockBatchClassifier.js'`.

- [ ] **Step 3: Write the implementation**

```ts
/** @format */
import { BedrockClient, CreateModelInvocationJobCommand, GetModelInvocationJobCommand, StopModelInvocationJobCommand } from '@aws-sdk/client-bedrock';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { RawImportEntry, OntologyCategory, CategorizationResult } from '@bedrock/shared';
import { ONTOLOGY_CATEGORIES } from '@bedrock/shared';

export const MODEL_ID_DEFAULT = 'anthropic.claude-haiku-4-5-20251001-v1:0';

/** A Bedrock batch input record. modelInput is the Anthropic Messages body. */
export interface BatchRecord {
    recordId: string;
    modelInput: Record<string, unknown>;
}
export interface PooledItem {
    entry: RawImportEntry;
    ecosystem: string;
}
export type RecordMap = Record<string, { ecosystem: string; identifier: string }>;

const SYSTEM = [
    {
        type: 'text',
        text:
            'You categorize software packages for a developer-resume system. ' +
            'Decide if a package is technology-worthy (yes/no/maybe) and pick exactly one category.',
    },
];

const TOOL = {
    name: 'classify_package',
    description: 'Record the classification decision for a package.',
    input_schema: {
        type: 'object',
        properties: {
            decision: { type: 'string', enum: ['yes', 'no', 'maybe'] },
            category: { type: ['string', 'null'], enum: [...ONTOLOGY_CATEGORIES, null] },
            reasoning: { type: 'string', maxLength: 200 },
        },
        required: ['decision', 'category', 'reasoning'],
        additionalProperties: false,
    },
};

function recordIdFor(index: number): string {
    return `r${String(index).padStart(7, '0')}`;
}

/** Pure: pool entries across sources into Bedrock batch records + a recordId→entry map. */
export function buildJsonlRecords(items: PooledItem[]): { records: BatchRecord[]; recordMap: RecordMap } {
    const records: BatchRecord[] = [];
    const recordMap: RecordMap = {};
    items.forEach(({ entry, ecosystem }, i) => {
        const recordId = recordIdFor(i + 1);
        recordMap[recordId] = { ecosystem, identifier: entry.source_identifier };
        records.push({
            recordId,
            modelInput: {
                anthropic_version: 'bedrock-2023-05-31',
                max_tokens: 256,
                system: SYSTEM,
                tools: [TOOL],
                tool_choice: { type: 'tool', name: 'classify_package' },
                messages: [
                    {
                        role: 'user',
                        content:
                            `Package: ${entry.source_identifier}\n` +
                            `Ecosystem: ${ecosystem}\n` +
                            `Description: ${entry.description ?? '(none)'}\n` +
                            `Keywords: ${(entry.keywords ?? []).join(', ') || '(none)'}`,
                    },
                ],
            },
        });
    });
    return { records, recordMap };
}

/** Pure: extract the classify_package tool_use from a Bedrock output record. */
export function parseModelOutput(record: {
    recordId: string;
    modelOutput?: { content?: Array<{ type: string; name?: string; input?: unknown }> };
}): { recordId: string } & Pick<CategorizationResult, 'decision' | 'category' | 'reasoning'> {
    const tu = (record.modelOutput?.content ?? []).find((b) => b.type === 'tool_use' && b.name === 'classify_package');
    if (!tu?.input) return { recordId: record.recordId, decision: 'maybe', category: null, reasoning: 'no tool_use' };
    const i = tu.input as { decision?: string; category?: string | null; reasoning?: string };
    return {
        recordId: record.recordId,
        decision: (i.decision as 'yes' | 'no' | 'maybe') ?? 'maybe',
        category: (i.category as OntologyCategory | null) ?? null,
        reasoning: i.reasoning,
    };
}

export interface BedrockBatchConfig {
    region: string;
    bucket: string;
    prefix: string;     // e.g. 'batch'
    roleArn: string;    // Bedrock batch service role
    modelId: string;
}

/** Thin AWS shell (mocked in tests; pure functions above carry the logic). */
export class BedrockBatchClassifier {
    private readonly bedrock: BedrockClient;
    private readonly s3: S3Client;
    constructor(private readonly cfg: BedrockBatchConfig) {
        this.bedrock = new BedrockClient({ region: cfg.region });
        this.s3 = new S3Client({ region: cfg.region });
    }

    /** Write records as one JSONL to S3 and create the batch job. Returns the job ARN. */
    async submit(records: BatchRecord[], runKey: string): Promise<string> {
        const inputKey = `${this.cfg.prefix}/input/${runKey}.jsonl`;
        const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
        await this.s3.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: inputKey, Body: body, ContentType: 'application/jsonl' }));
        const res = await this.bedrock.send(new CreateModelInvocationJobCommand({
            jobName: `ontology-importer-${runKey}`.slice(0, 63),
            roleArn: this.cfg.roleArn,
            modelId: this.cfg.modelId,
            inputDataConfig: { s3InputDataConfig: { s3Uri: `s3://${this.cfg.bucket}/${inputKey}`, s3InputFormat: 'JSONL' } },
            outputDataConfig: { s3OutputDataConfig: { s3Uri: `s3://${this.cfg.bucket}/${this.cfg.prefix}/output/${runKey}/` } },
        }));
        if (!res.jobArn) throw new Error('CreateModelInvocationJob returned no jobArn');
        return res.jobArn;
    }

    async retrieve(jobArn: string): Promise<{ status: string }> {
        const res = await this.bedrock.send(new GetModelInvocationJobCommand({ jobIdentifier: jobArn }));
        return { status: res.status ?? 'Unknown' };
    }

    async stop(jobArn: string): Promise<void> {
        await this.bedrock.send(new StopModelInvocationJobCommand({ jobIdentifier: jobArn }));
    }

    /** Read + parse the output JSONL(s) for a completed job under prefix/output/<runKey>/. */
    async *readResults(runKey: string): AsyncIterable<{ recordId: string; modelOutput?: { content?: Array<{ type: string; name?: string; input?: unknown }> } }> {
        const outPrefix = `${this.cfg.prefix}/output/${runKey}/`;
        const listed = await this.s3.send(new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: outPrefix }));
        for (const obj of listed.Contents ?? []) {
            if (!obj.Key || !obj.Key.endsWith('.jsonl.out')) continue;
            const got = await this.s3.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: obj.Key }));
            const text = await got.Body!.transformToString();
            for (const line of text.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try { yield JSON.parse(trimmed); } catch { /* skip malformed line */ }
            }
        }
    }
}
```
> Note: `readResults` takes `runKey` (not the jobArn) because the output S3 prefix is keyed by our `runKey`. The follow-up passes the same `runKey` it stored. If you prefer keying by jobId, derive it from the jobArn (`jobArn.split('/').pop()`), but `runKey` is simpler and under our control.

- [ ] **Step 4: Run to verify it passes**

Run: `yarn workspace @bedrock/ontology-importer jest src/categorization/BedrockBatchClassifier.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Build**

Run: `yarn workspace @bedrock/ontology-importer build`
Expected: clean (it will still fail to compile run-import/run-llm-batch-followup which import the old classifier — that's fixed in Tasks 5/6; if `tsc` errors only in those two files, that's expected at this point. To keep the build green per-task, do Step 6 + Tasks 5/6 before relying on a clean workspace build.)

- [ ] **Step 6: Delete the old classifier** (its imports are replaced in Tasks 5/6)

```bash
git rm applications/ontology-importer/src/categorization/LlmBatchClassifier.ts applications/ontology-importer/src/categorization/LlmBatchClassifier.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add applications/ontology-importer/src/categorization/BedrockBatchClassifier.ts applications/ontology-importer/src/categorization/BedrockBatchClassifier.test.ts
git commit -m "feat(ontology-importer): add BedrockBatchClassifier (replaces Anthropic batches)"
```

---

## Task 3: env.ts — drop Anthropic, add Bedrock/S3 config

**Files:**
- Modify: `applications/ontology-importer/src/env.ts`

- [ ] **Step 1: Replace the env module** with:

```ts
/** @format */

export type TriggeredBy = 'cronjob' | 'manual' | 'backfill';

export interface OntologyImportEnv {
    readonly pg: {
        readonly host: string; readonly port: number; readonly database: string;
        readonly user: string; readonly password: string;
    };
    readonly bedrock: {
        readonly region:    string;
        readonly modelId:   string;
        readonly bucket:    string;
        readonly prefix:    string;
        readonly roleArn:   string;
        readonly minRecords: number;
    };
    readonly triggeredBy:          TriggeredBy;
    readonly deactivationThreshold: number;
    readonly sources?:             string[];
}

function required(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

function parseTriggeredBy(raw: string): TriggeredBy {
    if (raw === 'cronjob' || raw === 'manual' || raw === 'backfill') return raw;
    throw new Error(`Invalid TRIGGERED_BY: ${raw} (expected cronjob|manual|backfill)`);
}

export function parseEnv(): OntologyImportEnv {
    const sourcesRaw = process.env['SOURCES'];
    const sources = sourcesRaw ? sourcesRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

    return {
        pg: {
            host:     required('PG_HOST'),
            port:     Number.parseInt(process.env['PG_PORT'] ?? '5432', 10),
            database: required('PG_DATABASE'),
            user:     required('PG_USER'),
            password: required('PG_PASSWORD'),
        },
        bedrock: {
            region:     process.env['AWS_REGION'] ?? 'eu-west-1',
            modelId:    process.env['BEDROCK_MODEL_ID'] ?? 'anthropic.claude-haiku-4-5-20251001-v1:0',
            bucket:     required('BATCH_S3_BUCKET'),
            prefix:     process.env['BATCH_S3_PREFIX'] ?? 'batch',
            roleArn:    required('BEDROCK_BATCH_ROLE_ARN'),
            minRecords: Number.parseInt(process.env['MIN_BATCH_RECORDS'] ?? '100', 10),
        },
        triggeredBy:           parseTriggeredBy(process.env['TRIGGERED_BY'] ?? 'cronjob'),
        deactivationThreshold: Number.parseInt(process.env['DEACTIVATION_THRESHOLD'] ?? '3', 10),
        sources,
    };
}
```

- [ ] **Step 2: Build the workspace shared lib is unaffected; defer importer build to Tasks 5/6.** Commit:

```bash
git add applications/ontology-importer/src/env.ts
git commit -m "feat(ontology-importer): replace ANTHROPIC_API_KEY env with Bedrock/S3 config"
```

---

## Task 4: OntologyImportRunRepository — pooled batch row + recordMap (shared)

**Files:**
- Modify: `applications/shared/src/rds/implementations/OntologyImportRunRepository.ts`
- Test: `applications/shared/src/rds/implementations/OntologyImportRunRepository.test.ts`

- [ ] **Step 1: Write failing tests** (append to the existing describe block)

```ts
    it('recordBatchRun inserts a partial pooled run with jobArn + recordMap notes', async () => {
        const pool = fakePool([{ id: 'batch-run-1' }]);
        const repo = new OntologyImportRunRepository(pool as never);
        const map = { r0000001: { ecosystem: 'npm', identifier: 'fastify' } };
        const id = await repo.recordBatchRun('pooled_llm_batch', 'cronjob', 'arn:job:1', map);
        expect(id).toBe('batch-run-1');
        const sql = pool.calls[0].sql;
        expect(sql).toContain('INSERT INTO ontology_import_runs');
        expect(sql).toContain("'partial'");
        const params = pool.calls[0].params!;
        expect(params).toEqual(expect.arrayContaining(['pooled_llm_batch', 'cronjob', 'arn:job:1']));
        // recordMap persisted as JSON in notes
        expect(params.some((p) => typeof p === 'string' && p.includes('fastify'))).toBe(true);
    });

    it('findPendingBatches returns recordMap parsed from notes', async () => {
        const pool = fakePool([{ id: 'b1', source: 'pooled_llm_batch', llm_batch_id: 'arn:job:1', notes: { recordMap: { r0000001: { ecosystem: 'npm', identifier: 'fastify' } } } }]);
        const repo = new OntologyImportRunRepository(pool as never);
        const pending = await repo.findPendingBatches();
        expect(pending[0]).toMatchObject({ id: 'b1', source: 'pooled_llm_batch', llmBatchId: 'arn:job:1' });
        expect(pending[0].recordMap).toEqual({ r0000001: { ecosystem: 'npm', identifier: 'fastify' } });
    });
```
(The existing `fakePool` helper at the top of this test file captures `{sql, params}` and returns `{rows}`. If it doesn't already return `rows` for SELECTs, it does — reuse it as-is.)

- [ ] **Step 2: Run to verify it fails**

Run: `yarn workspace @bedrock/shared jest src/rds/implementations/OntologyImportRunRepository.test.ts`
Expected: FAIL — `recordBatchRun` is not a function / `recordMap` undefined.

- [ ] **Step 3: Implement** — add `recordBatchRun` and extend `findPendingBatches`. Add this method and replace `findPendingBatches`:

```ts
    /** Insert a pooled LLM-batch run row (status=partial) carrying the job ARN + recordId→entry map. */
    async recordBatchRun(
        source: string,
        triggeredBy: 'cronjob' | 'manual' | 'backfill',
        jobArn: string,
        recordMap: Record<string, { ecosystem: string; identifier: string }>,
    ): Promise<string> {
        const { rows } = await this.pool.query<{ id: string }>(
            `INSERT INTO ontology_import_runs (source, triggered_by, status, started_at, llm_batch_id, notes)
             VALUES ($1, $2, 'partial', now(), $3, $4::jsonb) RETURNING id`,
            [source, triggeredBy, jobArn, JSON.stringify({ recordMap })],
        );
        return rows[0].id;
    }

    /** Runs awaiting LLM batch completion, with their persisted recordId→entry map. */
    async findPendingBatches(): Promise<Array<{ id: string; source: string; llmBatchId: string; recordMap: Record<string, { ecosystem: string; identifier: string }> }>> {
        const { rows } = await this.pool.query<{ id: string; source: string; llm_batch_id: string; notes: { recordMap?: Record<string, { ecosystem: string; identifier: string }> } | null }>(
            `SELECT id, source, llm_batch_id, notes FROM ontology_import_runs WHERE status = 'partial' AND llm_batch_id IS NOT NULL`,
        );
        return rows.map((r) => ({ id: r.id, source: r.source, llmBatchId: r.llm_batch_id, recordMap: r.notes?.recordMap ?? {} }));
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `yarn workspace @bedrock/shared jest src/rds/implementations/OntologyImportRunRepository.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Build shared**

Run: `yarn workspace @bedrock/shared build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add applications/shared/src/rds/implementations/OntologyImportRunRepository.ts applications/shared/src/rds/implementations/OntologyImportRunRepository.test.ts
git commit -m "feat(rds): add pooled batch run row + recordMap to import-run repo"
```

---

## Task 5: run-import.ts — pooled Bedrock batch

**Files:**
- Modify: `applications/ontology-importer/src/run-import.ts`

- [ ] **Step 1: Replace the file** (wiring; covered by Task 7 smoke). Key changes: per-source runs finish `success`/`failed` (no `llmBatchId`); pool `unresolved` across sources; one pooled batch row via `recordBatchRun`; sub-minimum → review queue.

```ts
/** @format */
import { Pool } from 'pg';
import {
    OntologyImportRunRepository, OntologyImportSourceRepository, OntologyWriteRepository,
    OntologyReviewQueueRepository,
    bootstrapK8sObservability, pushFinalMetrics,
} from '@bedrock/shared';
import type { ImportRunCounts, RawImportEntry } from '@bedrock/shared';

import { parseEnv } from './env.js';
import { ALL_SOURCES } from './sources/index.js';
import { Categorizer } from './categorization/Categorizer.js';
import { OntologyImporter } from './importer/OntologyImporter.js';
import { BedrockBatchClassifier, buildJsonlRecords } from './categorization/BedrockBatchClassifier.js';
import type { PooledItem } from './categorization/BedrockBatchClassifier.js';
import { buildMetrics } from './metrics.js';

const obs = bootstrapK8sObservability({ serviceName: 'ontology-importer' });
const log = obs.logger;
const metrics = buildMetrics(obs.registry);

async function withTimeout(p: Promise<unknown>, ms: number, label: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(() => { log.warn({ label }, 'teardown timed out'); resolve(); }, ms); });
    try { await Promise.race([p.then(() => undefined).catch(() => undefined), timeout]); }
    finally { if (timer) clearTimeout(timer); }
}

const emptyCounts = (): ImportRunCounts => ({
    entriesFetched: 0, entriesInserted: 0, entriesUpdated: 0, entriesDeactivated: 0,
    aliasMerges: 0, unresolvedCount: 0, reviewQueueAdded: 0,
});

async function main(): Promise<void> {
    const env = parseEnv();
    const pool = new Pool({ ...env.pg, max: 3 });
    const runs = new OntologyImportRunRepository(pool);
    const ontology = new OntologyWriteRepository(pool);
    const importSources = new OntologyImportSourceRepository(pool);
    const reviewQueue = new OntologyReviewQueueRepository(pool);
    const importer = new OntologyImporter(new Categorizer(), ontology, importSources);
    const llm = new BedrockBatchClassifier({
        region: env.bedrock.region, bucket: env.bedrock.bucket, prefix: env.bedrock.prefix,
        roleArn: env.bedrock.roleArn, modelId: env.bedrock.modelId,
    });

    const pooled: PooledItem[] = [];

    try {
        for (const source of ALL_SOURCES()) {
            if (env.sources && !env.sources.includes(source.name)) continue;

            const runStart = new Date();
            const stopTimer = metrics.importDuration.startTimer({ source: source.name });
            const runId = await runs.begin(source.name, env.triggeredBy);
            try {
                const { counts, unresolved } = await importer.run(source, runStart);
                await importSources.incrementMissesOlderThan(source.name, runStart);
                counts.entriesDeactivated += await importSources.deactivateStale(source.name, env.deactivationThreshold);

                for (const entry of unresolved) pooled.push({ entry, ecosystem: source.ecosystem });

                await runs.finish(runId, 'success', counts, {});

                metrics.importEntries.inc({ source: source.name, outcome: 'inserted' }, counts.entriesInserted);
                metrics.importEntries.inc({ source: source.name, outcome: 'updated' }, counts.entriesUpdated);
                metrics.importEntries.inc({ source: source.name, outcome: 'deactivated' }, counts.entriesDeactivated);
                metrics.importEntries.inc({ source: source.name, outcome: 'unresolved' }, counts.unresolvedCount);
                if (counts.entriesFetched > 0) {
                    const resolved = counts.entriesInserted + counts.entriesUpdated;
                    metrics.resolutionRate.set({ ecosystem: source.ecosystem }, resolved / counts.entriesFetched);
                }
                log.info({ source: source.name, ...counts }, 'import.source.complete');
            } catch (err) {
                await runs.finish(runId, 'failed', emptyCounts(), { errorSummary: String(err) }).catch(() => {});
                log.error({ source: source.name, err: String(err) }, 'import.source.failed');
            } finally {
                stopTimer();
            }
        }

        // Pooled Layer-4 batch across all sources.
        if (pooled.length >= env.bedrock.minRecords) {
            const runKey = `import_${Date.now()}`;
            const { records, recordMap } = buildJsonlRecords(pooled);
            const jobArn = await llm.submit(records, runKey);
            await runs.recordBatchRun('pooled_llm_batch', env.triggeredBy, jobArn, recordMap);
            log.info({ pooled: pooled.length, jobArn }, 'import.batch.submitted');
        } else if (pooled.length > 0) {
            for (const { entry, ecosystem } of pooled) {
                await reviewQueue.add({ rawName: entry.source_identifier, ecosystem, source: 'pooled_llm_batch', reason: 'llm_maybe', suggestedCategory: null, llmReasoning: 'below MIN_BATCH_RECORDS' }).catch(() => {});
            }
            log.info({ pooled: pooled.length, min: env.bedrock.minRecords }, 'import.batch.below_min.queued_for_review');
        }
    } finally {
        await withTimeout(pool.end(), 10_000, 'pg-pool');
        await withTimeout(pushFinalMetrics(obs.registry, 'ontology-importer', `import_${Date.now()}`), 8_000, 'pushgateway');
        await withTimeout(obs.shutdown(), 10_000, 'otel-shutdown');
    }
}

main().then(() => process.exit(0)).catch((err) => { log.error({ err: String(err) }, 'failed'); process.exit(1); });
```
> `RawImportEntry` is imported as a type for clarity even though `PooledItem` carries it; keep it if `tsc` flags the unused import otherwise remove it. `OntologyImporter.run` already returns `unresolved: RawImportEntry[]`.

- [ ] **Step 2: Commit** (build verified after Task 6 when the follow-up also compiles)

```bash
git add applications/ontology-importer/src/run-import.ts
git commit -m "feat(ontology-importer): pool unresolved into one Bedrock batch per run"
```

---

## Task 6: run-llm-batch-followup.ts — Bedrock poll + recordMap routing

**Files:**
- Modify: `applications/ontology-importer/src/run-llm-batch-followup.ts`

- [ ] **Step 1: Replace the file** with the Bedrock version. Status check uses `Completed` (Bedrock) not `processing_status==='ended'`; results come from S3 via `readResults(runKey)`; the runKey is recovered from the input S3 path is not stored — instead store it. **Adjustment:** store `runKey` alongside in notes. Update Task 4's `recordBatchRun` call already passes only recordMap; we also need the runKey. Simplest: derive `runKey` from the jobArn is not possible, so include `runKey` in notes too.

First, extend the notes payload to carry `runKey`. Update `run-import.ts` Task 5 `recordBatchRun` to pass it, and `recordBatchRun`/`findPendingBatches` to round-trip it. Concretely:

- In Task 4 `recordBatchRun`, change the notes JSON to `JSON.stringify({ recordMap, runKey })` and add a `runKey: string` parameter (5th arg). In `findPendingBatches`, return `runKey: r.notes?.runKey ?? ''` too. (Apply this now; re-run the Task 4 tests — update the `recordBatchRun` test to pass a `runKey` and assert it lands in notes, and the `findPendingBatches` row to include `runKey`.)
- In Task 5 `run-import.ts`, call `await runs.recordBatchRun('pooled_llm_batch', env.triggeredBy, jobArn, recordMap, runKey);`.

Then the follow-up:

```ts
/** @format */
import { Pool } from 'pg';
import {
    OntologyImportRunRepository, OntologyImportSourceRepository, OntologyWriteRepository,
    OntologyReviewQueueRepository, OntologySkippedImportRepository,
    bootstrapK8sObservability, pushFinalMetrics,
} from '@bedrock/shared';
import type { ImportRunCounts } from '@bedrock/shared';

import { parseEnv } from './env.js';
import { BedrockBatchClassifier, parseModelOutput } from './categorization/BedrockBatchClassifier.js';

const obs = bootstrapK8sObservability({ serviceName: 'ontology-importer-followup' });
const log = obs.logger;

async function withTimeout(p: Promise<unknown>, ms: number, label: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(() => { log.warn({ label }, 'teardown timed out'); resolve(); }, ms); });
    try { await Promise.race([p.then(() => undefined).catch(() => undefined), timeout]); }
    finally { if (timer) clearTimeout(timer); }
}

const emptyCounts = (): ImportRunCounts => ({
    entriesFetched: 0, entriesInserted: 0, entriesUpdated: 0, entriesDeactivated: 0,
    aliasMerges: 0, unresolvedCount: 0, reviewQueueAdded: 0,
});

async function main(): Promise<void> {
    const env = parseEnv();
    const pool = new Pool({ ...env.pg, max: 3 });
    const runs = new OntologyImportRunRepository(pool);
    const ontology = new OntologyWriteRepository(pool);
    const importSources = new OntologyImportSourceRepository(pool);
    const reviewQueue = new OntologyReviewQueueRepository(pool);
    const skipped = new OntologySkippedImportRepository(pool);
    const llm = new BedrockBatchClassifier({
        region: env.bedrock.region, bucket: env.bedrock.bucket, prefix: env.bedrock.prefix,
        roleArn: env.bedrock.roleArn, modelId: env.bedrock.modelId,
    });

    try {
        const pending = await runs.findPendingBatches();
        log.info({ pending: pending.length }, 'followup.start');

        for (const run of pending) {
            const { status } = await llm.retrieve(run.llmBatchId);
            if (status !== 'Completed' && status !== 'PartiallyCompleted') {
                if (status === 'Failed' || status === 'Stopped' || status === 'Expired') {
                    await runs.finish(run.id, 'failed', emptyCounts(), { errorSummary: `batch ${status}` }).catch(() => {});
                    log.warn({ batch: run.llmBatchId, status }, 'followup.batch.failed');
                } else {
                    log.info({ batch: run.llmBatchId, status }, 'followup.batch.pending');
                }
                continue;
            }

            const counts = emptyCounts();
            for await (const record of llm.readResults(run.runKey)) {
                const { decision, category, reasoning } = parseModelOutput(record);
                const mapped = run.recordMap[record.recordId];
                if (!mapped) { log.warn({ recordId: record.recordId }, 'followup.unmapped_record'); continue; }
                const { ecosystem, identifier } = mapped;

                if (decision === 'yes' && category) {
                    const id = await ontology.insertAutoImported(identifier.toLowerCase(), identifier, category, 'pooled_llm_batch');
                    await importSources.upsertSeen(id, 'pooled_llm_batch', identifier, null, {});
                    counts.entriesInserted++;
                } else if (decision === 'no') {
                    await skipped.add({ rawName: identifier, ecosystem, source: 'pooled_llm_batch', llmDecision: 'no', llmReasoning: reasoning ?? null, llmRunId: run.llmBatchId });
                } else {
                    await reviewQueue.add({ rawName: identifier, ecosystem, source: 'pooled_llm_batch', reason: 'llm_maybe', suggestedCategory: category ?? null, llmReasoning: reasoning ?? null });
                    counts.reviewQueueAdded++;
                }
            }

            await runs.finish(run.id, 'success', counts, {});
            log.info({ batch: run.llmBatchId, ...counts }, 'followup.batch.complete');
        }
    } finally {
        await withTimeout(pool.end(), 10_000, 'pg-pool');
        await withTimeout(pushFinalMetrics(obs.registry, 'ontology-importer-followup', `followup_${Date.now()}`), 8_000, 'pushgateway');
        await withTimeout(obs.shutdown(), 10_000, 'otel-shutdown');
    }
}

main().then(() => process.exit(0)).catch((err) => { log.error({ err: String(err) }, 'failed'); process.exit(1); });
```
> `findPendingBatches` must now also return `runKey` (added in this task's Task-4 amendment). The `splitCustomId` helper is gone — mapping is via `run.recordMap`.

- [ ] **Step 2: Build the whole workspace**

Run: `yarn workspace @bedrock/shared build && yarn workspace @bedrock/ontology-importer build`
Expected: both clean (no remaining references to the old classifier/env fields).

- [ ] **Step 3: Commit**

```bash
git add applications/ontology-importer/src/run-llm-batch-followup.ts applications/shared/src/rds/implementations/OntologyImportRunRepository.ts applications/shared/src/rds/implementations/OntologyImportRunRepository.test.ts applications/ontology-importer/src/run-import.ts
git commit -m "feat(ontology-importer): route Bedrock batch results via recordMap in follow-up"
```

---

## Task 7: Integration smoke — Bedrock-shaped mock

**Files:**
- Modify: `applications/ontology-importer/src/__tests__/integration.test.ts`

- [ ] **Step 1: Update the existing LLM-routing smoke** to use `parseModelOutput` (Bedrock output shape) instead of `parseBatchResult`. Replace the routing-smoke describe block's message construction with Bedrock `modelOutput` records and route via `parseModelOutput`:

```ts
import { buildJsonlRecords, parseModelOutput } from '../categorization/BedrockBatchClassifier.js';

// ... inside the routing smoke test ...
const items = unresolved.map((entry) => ({ entry, ecosystem: 'npm' }));
const { records, recordMap } = buildJsonlRecords(items);
expect(records).toHaveLength(items.length);

// Simulate Bedrock output: one yes, one no, one maybe (no tool_use).
const outputs = [
    { recordId: records[0].recordId, modelOutput: { content: [{ type: 'tool_use', name: 'classify_package', input: { decision: 'yes', category: 'framework_web', reasoning: 'fw' } }] } },
    { recordId: records[1]?.recordId ?? 'rX', modelOutput: { content: [{ type: 'tool_use', name: 'classify_package', input: { decision: 'no', category: null, reasoning: 'types' } }] } },
    { recordId: records[2]?.recordId ?? 'rY', modelOutput: { content: [{ type: 'text' }] } },
];
const inserted: string[] = []; const skipped: string[] = []; const review: string[] = [];
for (const rec of outputs) {
    const { decision, category } = parseModelOutput(rec);
    const id = recordMap[rec.recordId]?.identifier ?? rec.recordId;
    if (decision === 'yes' && category) inserted.push(id);
    else if (decision === 'no') skipped.push(id);
    else review.push(id);
}
expect(inserted).toHaveLength(1);
expect(skipped).toHaveLength(1);
expect(review).toHaveLength(1);
```
(Keep the deterministic FakeSource → OntologyImporter portion of the test as-is. Adapt indices to however many unresolved the FakeSource yields; the three outputs above assume ≥1 unresolved and exercise all three routes.)

- [ ] **Step 2: Run the full importer suite**

Run: `yarn workspace @bedrock/ontology-importer test`
Expected: all green (no references to the deleted classifier remain).

- [ ] **Step 3: Build both workspaces**

Run: `yarn workspace @bedrock/shared build && yarn workspace @bedrock/ontology-importer build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add applications/ontology-importer/src/__tests__/integration.test.ts
git commit -m "test(ontology-importer): Bedrock-shaped batch routing smoke"
```

---

## Task 8: cdk-monitoring — S3 bucket + Bedrock batch role + Pod Identity

**Repo/branch:** `cdk-monitoring`, branch `feat/ontology-importer-bedrock-batch` off `origin/main`. Trunk is `main`.

**Files:**
- Modify: `infra/lib/shared/vpc-stack.ts` (S3 bucket + SSM, co-located with the existing ECR/SSM blocks)
- Modify: `infra/lib/stacks/kubernetes/eks-pod-identity-stack.ts` (batch service role + `ontology-importer` purpose case)
- Modify: the matching unit tests under `infra/tests/unit/`

- [ ] **Step 1: Branch**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring
git fetch origin main
git checkout -b feat/ontology-importer-bedrock-batch origin/main
```

- [ ] **Step 2: S3 batch bucket + SSM in `vpc-stack.ts`** — add (mirroring the existing ECR block's prop/field/SSM style; read the file first). Add a prop `createOntologyImporterBatchBucket?: boolean` (default true), a public field `ontologyImporterBatchBucket?: s3.Bucket`, and the block:

```ts
if (props.createOntologyImporterBatchBucket !== false) {
    const isProduction = props.targetEnvironment === Environment.PRODUCTION;
    this.ontologyImporterBatchBucket = new s3.Bucket(this, 'OntologyImporterBatchBucket', {
        bucketName: `ontology-importer-batch-${props.targetEnvironment}`,
        encryption: s3.BucketEncryption.S3_MANAGED,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: !isProduction,
        lifecycleRules: [{ id: 'expire-batch-io', expiration: cdk.Duration.days(14) }],
    });
    new ssm.StringParameter(this, 'SsmOntologyImporterBatchBucket', {
        parameterName: `/shared/ontology-importer/${props.targetEnvironment}/batch-bucket`,
        stringValue: this.ontologyImporterBatchBucket.bucketName,
        description: `ontology-importer Bedrock batch bucket for ${props.targetEnvironment}`,
        tier: ssm.ParameterTier.STANDARD,
    });
}
```
(Ensure `import * as s3 from 'aws-cdk-lib/aws-s3'` exists; it likely does — confirm.)

- [ ] **Step 3: Bedrock batch service role + Pod Identity case in `eks-pod-identity-stack.ts`** — read the file's `switch (b.purpose)` structure and the bucket-name convention. Add an `ontology-importer` purpose case. The pod role + a Bedrock batch **service role** (assumed by `bedrock.amazonaws.com`). Concretely (adapt identifiers to the file's existing style):

```ts
case 'ontology-importer': {
    const batchBucketArn = `arn:aws:s3:::ontology-importer-batch-${env}`;
    // Service role Bedrock assumes to read input / write output in the batch bucket.
    const batchServiceRole = new iam.Role(this, 'OntologyImporterBedrockBatchRole', {
        assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
        description: 'Role assumed by Bedrock batch inference for ontology-importer S3 I/O',
    });
    batchServiceRole.addToPolicy(new iam.PolicyStatement({
        sid: 'BatchS3IO',
        actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
        resources: [batchBucketArn, `${batchBucketArn}/*`],
    }));
    new ssm.StringParameter(this, 'SsmOntologyImporterBatchRoleArn', {
        parameterName: `/shared/ontology-importer/${env}/batch-role-arn`,
        stringValue: batchServiceRole.roleArn,
    });
    // Pod role: create/get/stop batch jobs, invoke model, S3 I/O, passRole the service role.
    role.addToPolicy(new iam.PolicyStatement({
        sid: 'OntologyImporterBedrockBatch',
        actions: ['bedrock:CreateModelInvocationJob', 'bedrock:GetModelInvocationJob', 'bedrock:StopModelInvocationJob', 'bedrock:InvokeModel'],
        resources: ['arn:aws:bedrock:*::foundation-model/*', `arn:aws:bedrock:*:${cdk.Stack.of(this).account}:inference-profile/*`, `arn:aws:bedrock:*:${cdk.Stack.of(this).account}:model-invocation-job/*`],
    }));
    role.addToPolicy(new iam.PolicyStatement({ sid: 'OntologyImporterBatchS3', actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'], resources: [batchBucketArn, `${batchBucketArn}/*`] }));
    role.addToPolicy(new iam.PolicyStatement({ sid: 'OntologyImporterPassBatchRole', actions: ['iam:PassRole'], resources: [batchServiceRole.roleArn] }));
    break;
}
```
And register the purpose in the stack's list of pod-identity bindings (the `b` iteration source — read the file to find where purposes/namespaces/SAs are declared) with: purpose `ontology-importer`, namespace `ontology-importer`, serviceAccount `ontology-importer-sa`. The `CfnPodIdentityAssociation` is created by the existing generic loop (confirm — the ingestion case relies on it).

> If the stack builds the role + association generically from a config array (each `{ purpose, namespace, serviceAccount }`) and only the policy differs per `purpose`, just (a) add the array entry and (b) add the `case`. Follow whatever the file actually does — do not introduce a second association mechanism.

- [ ] **Step 4: Unit tests** — add assertions mirroring the existing ECR/role tests: the batch bucket exists with `BucketName: ontology-importer-batch-development` + the 14-day lifecycle rule; the SSM params `/shared/ontology-importer/development/batch-bucket` and `/.../batch-role-arn` exist; an IAM role trusts `bedrock.amazonaws.com`; the ontology-importer pod role has a statement with `bedrock:CreateModelInvocationJob`. Run the affected unit test files.

Run: `yarn typecheck && yarn lint && npx jest tests/unit/shared/vpc-stack.test.ts tests/unit/stacks/kubernetes` (adjust paths to the real test files)
Expected: pass.

- [ ] **Step 5: Commit + PR to main**

```bash
git add infra/lib/shared/vpc-stack.ts infra/lib/stacks/kubernetes/eks-pod-identity-stack.ts infra/tests/unit
git commit -m "feat(ontology-importer): add Bedrock batch S3 bucket + role + pod identity"
git push -u origin feat/ontology-importer-bedrock-batch
gh pr create --base main --title "feat(ontology-importer): Bedrock batch S3 bucket + IAM" --body "..."
```

---

## Task 9: kubernetes-bootstrap — drop Anthropic secret, add Bedrock env

**Repo/branch:** `kubernetes-bootstrap`, branch `feat/ontology-importer-bedrock-batch` off `origin/main`, via a **git worktree** (the main checkout has unrelated WIP):

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/kubernetes-bootstrap
git fetch origin main
git worktree add -b feat/ontology-importer-bedrock-batch /tmp/kb-bedrock-batch origin/main
cd /tmp/kb-bedrock-batch
```

**Files:**
- Delete: `charts/ontology-importer/external-secrets/ontology-importer-secrets.yaml`
- Delete: `argocd-apps/eks/development/ontology-importer-secrets.yaml`
- Modify: `charts/ontology-importer/chart/values.yaml`
- Modify: `charts/ontology-importer/chart/templates/import-cronjob.yaml`
- Modify: `charts/ontology-importer/chart/templates/followup-cronjob.yaml`

- [ ] **Step 1: Delete the Anthropic secret ESO + its ArgoCD app**

```bash
git rm charts/ontology-importer/external-secrets/ontology-importer-secrets.yaml argocd-apps/eks/development/ontology-importer-secrets.yaml
```
> Note: `charts/ontology-importer/external-secrets/` still contains `platform-rds-credentials.yaml`, so the `ontology-importer-secrets-eks-development` ArgoCD app pointed at the whole `external-secrets/` dir — wait: it pointed at the dir, which still has platform-rds. Re-check: the **chart** ArgoCD app (`ontology-importer.yaml`) syncs `charts/ontology-importer/chart`; the **secrets** app (`ontology-importer-secrets.yaml`) syncs `charts/ontology-importer/external-secrets`. Since `external-secrets/` still has `platform-rds-credentials.yaml`, DO NOT delete the secrets ArgoCD app — only delete the `ontology-importer-secrets.yaml` ESO manifest. Keep `argocd-apps/eks/development/ontology-importer-secrets.yaml` (it still syncs platform-rds-credentials). **Correction:** `git rm` only `charts/ontology-importer/external-secrets/ontology-importer-secrets.yaml`.

```bash
git rm charts/ontology-importer/external-secrets/ontology-importer-secrets.yaml
```

- [ ] **Step 2: values.yaml** — add a `bedrock` block and keep namespace/image/schedules:

```yaml
bedrock:
  region: "eu-west-1"
  modelId: "anthropic.claude-haiku-4-5-20251001-v1:0"
  batchBucket: "ontology-importer-batch-development"
  batchPrefix: "batch"
  batchRoleArn: "arn:aws:iam::771826808455:role/<OntologyImporterBedrockBatchRole-from-cdk>"
  minRecords: "100"
```
> The `batchRoleArn` value comes from the CDK output / SSM `/shared/ontology-importer/development/batch-role-arn` after Task 8 deploys. Fill the real ARN before merge (or template it from an env-substituted value if the chart supports it). The bucket name is deterministic.

- [ ] **Step 3: Both CronJob templates** — in `import-cronjob.yaml` and `followup-cronjob.yaml`: REMOVE the `- secretRef: { name: ontology-importer-secrets }` entry from `envFrom` (keep `platform-rds-credentials`). ADD these `env` entries to the container:

```yaml
            - name: AWS_REGION
              value: {{ .Values.bedrock.region | quote }}
            - name: BEDROCK_MODEL_ID
              value: {{ .Values.bedrock.modelId | quote }}
            - name: BATCH_S3_BUCKET
              value: {{ .Values.bedrock.batchBucket | quote }}
            - name: BATCH_S3_PREFIX
              value: {{ .Values.bedrock.batchPrefix | quote }}
            - name: BEDROCK_BATCH_ROLE_ARN
              value: {{ .Values.bedrock.batchRoleArn | quote }}
            - name: MIN_BATCH_RECORDS
              value: {{ .Values.bedrock.minRecords | quote }}
```
(Keep the existing `TRIGGERED_BY`/`DEACTIVATION_THRESHOLD`/`LOG_LEVEL` env.)

- [ ] **Step 4: Lint**

Run: `helm lint charts/ontology-importer/chart && helm template charts/ontology-importer/chart`
Expected: pass; both CronJobs render with the Bedrock env and no `ontology-importer-secrets` envFrom.

- [ ] **Step 5: Commit + PR to main**

```bash
git add -A
git commit -m "feat(ontology-importer): drop Anthropic secret, add Bedrock batch env"
git push -u origin feat/ontology-importer-bedrock-batch
gh pr create --base main --title "feat(ontology-importer): Bedrock batch env, drop Anthropic secret" --body "..."
```

- [ ] **Step 6: Clean up worktree** (after PR opened)

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/kubernetes-bootstrap
git worktree remove /tmp/kb-bedrock-batch && git worktree prune
```

---

## Task 10: ai-applications PR

- [ ] **Step 1:** Push `feat/ontology-importer-bedrock-batch` and open a PR to `develop` summarizing the Bedrock Batch refactor; link the cdk-monitoring + kubernetes-bootstrap PRs and note merge order (cdk → ai-applications image → kubernetes-bootstrap chart). Include the rollout/validation steps from the spec.

---

## Rollout & Validation (post-merge, operational — not code)

1. Deploy cdk-monitoring (bucket + batch role + Pod Identity + SSM); fill the chart `batchRoleArn` from SSM `/shared/ontology-importer/development/batch-role-arn`; merge kubernetes-bootstrap.
2. CI builds the new image (no Anthropic secret). ArgoCD syncs; the `ontology-importer-secrets` ESO/SecretSyncedError disappears.
3. Trigger: `kubectl create job -n ontology-importer --from=cronjob/ontology-importer-import manual-run-1`.
4. Verify `technology_ontology` `auto_imported` count grows from 0; a `pooled_llm_batch` run row has `status=partial` + a job ARN; the input JSONL appears under `s3://ontology-importer-batch-development/batch/input/`.
5. When the Bedrock job completes, the follow-up routes results (auto_imported/skipped/review_queue populated; run `success`).
6. Re-run tech-extract on `Nelson-Lamounier/kubernetes-bootstrap` (infra) + a `tucaken-app` repo → new `technology_parity_runs`.
7. Compare `recall` to the **0.128** baseline. **Decommission gate (judgment):** target recall ≥ 0.85 on both repos; review `llm_only_examples`/`l1_only_examples`; decommission `BedrockChunkEnricher` only if the residual gap is noise or un-extractable deployed-infra tech — else grow ontology/detectors and re-measure.

---

## Self-Review

**Spec coverage:**
- BedrockBatchClassifier (buildJsonlRecords/parseModelOutput/submit/retrieve/readResults) → Task 2 ✓
- env swap (drop ANTHROPIC_API_KEY, add Bedrock/S3/MIN_BATCH_RECORDS) → Task 3 ✓
- pooled-per-run batch + `pooled_llm_batch` run row + recordMap in notes → Tasks 4,5 ✓
- sub-minimum → review_queue → Task 5 ✓
- follow-up Bedrock poll (`Completed`) + recordMap routing → Task 6 ✓
- deps swap → Task 1 ✓; integration smoke → Task 7 ✓
- cdk: S3 bucket + batch service role + Pod Identity case + SSM + tests → Task 8 ✓
- k8s: drop Anthropic ESO + add Bedrock env (keep platform-rds + its ArgoCD app) → Task 9 ✓
- rollout & decommission gate → Rollout section ✓

**Placeholder scan:** the chart `batchRoleArn` value is a real post-deploy value (sourced from CDK SSM) — flagged explicitly, not a code placeholder. cdk Task references "adapt to the file's existing purpose-array/switch structure" because the exact construct names must match the real file — the policy statements + association requirements are given concretely.

**Type consistency:** `BatchRecord`, `PooledItem`, `RecordMap`, `buildJsonlRecords(items)→{records,recordMap}`, `parseModelOutput(record)→{recordId,decision,category,reasoning}`, `BedrockBatchClassifier.{submit(records,runKey),retrieve(jobArn),readResults(runKey),stop}`, `recordBatchRun(source,triggeredBy,jobArn,recordMap,runKey)`, `findPendingBatches()→{id,source,llmBatchId,recordMap,runKey}` are defined once (Tasks 2/4) and used consistently (Tasks 5/6/7). `MODEL_ID_DEFAULT` (classifier) vs env `BEDROCK_MODEL_ID` default string match.
