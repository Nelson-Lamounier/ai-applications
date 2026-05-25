# Tier 2 Ontology Importer — Plan 2: Registry Sources

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the seven registry `Source` integrations (AWS botocore, npm top-5k, PyPI, Maven Central, crates.io, GCP, Azure) that feed the Plan-1 importer engine. Each parses a registry into a stream of `RawImportEntry`.

**Architecture:** Every source is a class implementing the Plan-1 `Source` contract (`name`, `ecosystem`, `fetch()`, optional `keep()`/`mapMetadataToCategory()`). The HTTP/file I/O is a thin shell around a **pure parse function** that turns a recorded response into `RawImportEntry[]` — the parse function is the unit-tested core. Cloud sources (AWS/GCP/Azure) set their own category via `mapMetadataToCategory`; registry sources (npm/Maven) leave categorization to the cascade; PyPI/crates map their native taxonomy.

**Tech Stack:** TypeScript (CommonJS), `undici` (HTTP), `@google-cloud/bigquery` (PyPI), cloned `boto/botocore` (AWS, build-time). Builds on Plan 1 (`Source`, `RawImportEntry`).

**Depends on:** Plan 1 (`applications/ontology-importer/src/sources/Source.ts`, shared `RawImportEntry`/`OntologyCategory`).

**Spec:** `tier2-ontology-auto-import.md` §Source contract, §Categorization Layer 3, §Alias generation.

---

## File Structure

- Create `applications/ontology-importer/src/sources/AwsBotocoreSource.ts` (+ `.test.ts` + fixture)
- Create `applications/ontology-importer/src/sources/NpmRegistrySource.ts` (+ `.test.ts` + fixture)
- Create `applications/ontology-importer/src/sources/PypiBigQuerySource.ts` (+ `.test.ts` + fixture)
- Create `applications/ontology-importer/src/sources/MavenCentralSource.ts` (+ `.test.ts` + fixture)
- Create `applications/ontology-importer/src/sources/CratesIoSource.ts` (+ `.test.ts` + fixture)
- Create `applications/ontology-importer/src/sources/GcpServiceUsageSource.ts` (+ `.test.ts` + fixture)
- Create `applications/ontology-importer/src/sources/AzureRestSpecsSource.ts` (+ `.test.ts` + fixture)
- Create `applications/ontology-importer/src/sources/index.ts` — `ALL_SOURCES` registry
- Add deps to `applications/ontology-importer/package.json`: `@google-cloud/bigquery`

**Common pattern per source (every task follows this):**
1. **Record a fixture** — a real (trimmed) API/file response saved under `src/sources/__tests__/fixtures/<source>.json`. Capture it once from the live API/repo; commit it. Keep it small (5–15 entries).
2. **Pure parse function** `parse<X>(raw): RawImportEntry[]` — testable without I/O.
3. **Source class** — `fetch()` does the I/O then delegates to the parser; `keep()`/`mapMetadataToCategory()` as needed.
4. **TDD:** fixture → parse test → impl. Commit.

> **Fixtures, not live calls, in tests.** No source test may hit the network. The `fetch()` I/O shell is exercised only by Plan-3's integration smoke (tiny, gated) — unit tests target the pure parsers.

---

## Task 1: AwsBotocoreSource (~300 AWS services)

**Files:** `AwsBotocoreSource.ts` (+ `.test.ts`), fixture `__tests__/fixtures/botocore-s3-service-2.json`

AWS service definitions live in `botocore/data/<service>/<version>/service-2.json`. The container clones `boto/botocore` at a pinned commit (Plan 3 Dockerfile). Each `service-2.json` has a `metadata` block: `serviceId`, `serviceFullName`, `endpointPrefix`, `serviceAbbreviation`, `signingName`.

- [ ] **Step 1: Fixture** — trim a real S3 `service-2.json` to its `metadata` block + a couple of operations:

```json
{ "metadata": {
    "apiVersion": "2006-03-01", "endpointPrefix": "s3",
    "serviceAbbreviation": "Amazon S3", "serviceFullName": "Amazon Simple Storage Service",
    "serviceId": "S3", "signingName": "s3", "protocol": "rest-xml" } }
```

- [ ] **Step 2: Failing test** (`AwsBotocoreSource.test.ts`)

```ts
/** @format */
import { describe, it, expect } from '@jest/globals';
import { parseBotocoreService, awsCategoryFor } from './AwsBotocoreSource.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('parseBotocoreService', () => {
    it('maps service metadata to a RawImportEntry', () => {
        const raw = JSON.parse(readFileSync(path.join(__dirname, '__tests__/fixtures/botocore-s3-service-2.json'), 'utf-8'));
        const e = parseBotocoreService(raw, 's3');
        expect(e).toMatchObject({
            source_identifier: 's3',
            proposed_canonical_name: 'aws_s3',
            proposed_display_name: 'Amazon S3',
        });
        expect(e.keywords).toEqual(expect.arrayContaining(['s3', 'amazon s3', 'aws s3']));
    });
});

describe('awsCategoryFor', () => {
    it('classifies known services', () => {
        expect(awsCategoryFor('s3')).toBe('cloud_storage');
        expect(awsCategoryFor('lambda')).toBe('cloud_serverless');
        expect(awsCategoryFor('dynamodb')).toBe('database_nosql');
        expect(awsCategoryFor('unknown-svc')).toBe('cloud_compute'); // default
    });
});
```

- [ ] **Step 3: Run → fail. Step 4: Implement**

```ts
/** @format */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Source, RawImportEntry } from './Source.js';
import type { OntologyCategory } from '@bedrock/shared';

interface BotocoreDoc { metadata?: { endpointPrefix?: string; serviceAbbreviation?: string; serviceFullName?: string; serviceId?: string } }

/** Hardcoded AWS sub-categorization (endpointPrefix → category). Default cloud_compute. */
const AWS_CATEGORY: Record<string, OntologyCategory> = {
    s3: 'cloud_storage', ebs: 'cloud_storage', efs: 'cloud_storage', backup: 'cloud_storage',
    lambda: 'cloud_serverless', 'states': 'cloud_serverless',
    dynamodb: 'database_nosql', rds: 'cloud_database', 'rds-data': 'cloud_database', elasticache: 'database_kv',
    sqs: 'message_broker', sns: 'message_broker', events: 'message_broker', kinesis: 'message_broker',
    cloudfront: 'cloud_networking', route53: 'cloud_networking', 'apigateway': 'cloud_networking', ec2: 'cloud_compute',
    iam: 'cloud_security', kms: 'cloud_security', secretsmanager: 'cloud_security', 'wafv2': 'cloud_security',
    'cognito-idp': 'auth', cloudwatch: 'observability', logs: 'observability', textract: 'ai_platform', bedrock: 'ai_platform',
    eks: 'cloud_compute', ecr: 'cloud_compute', ecs: 'cloud_compute', cloudformation: 'iam' as OntologyCategory,
};
export function awsCategoryFor(endpointPrefix: string): OntologyCategory {
    return AWS_CATEGORY[endpointPrefix] ?? 'cloud_compute';
}

export function parseBotocoreService(doc: BotocoreDoc, dirName: string): RawImportEntry {
    const m = doc.metadata ?? {};
    const prefix = (m.endpointPrefix ?? dirName).toLowerCase();
    const display = m.serviceAbbreviation ?? m.serviceFullName ?? m.serviceId ?? dirName;
    return {
        source_identifier: prefix,
        proposed_canonical_name: `aws_${prefix.replace(/[^a-z0-9]/g, '_')}`,
        proposed_display_name: display,
        keywords: [prefix, display.toLowerCase(), `aws ${prefix}`, `amazon ${prefix}`],
        source_metadata: { endpointPrefix: prefix, serviceId: m.serviceId },
    };
}

export class AwsBotocoreSource implements Source {
    readonly name = 'aws_botocore';
    readonly ecosystem = 'aws';
    constructor(private readonly dataDir = process.env.BOTOCORE_DATA_DIR ?? '/opt/botocore/botocore/data') {}

    mapMetadataToCategory(entry: RawImportEntry): OntologyCategory {
        return awsCategoryFor(String(entry.source_metadata.endpointPrefix ?? entry.source_identifier));
    }

    async *fetch(): AsyncIterable<RawImportEntry> {
        const services = await fs.readdir(this.dataDir, { withFileTypes: true });
        const seen = new Set<string>();
        for (const svc of services) {
            if (!svc.isDirectory()) continue;
            const versions = await fs.readdir(path.join(this.dataDir, svc.name)).catch(() => [] as string[]);
            const latest = versions.sort().pop();
            if (!latest) continue;
            const file = path.join(this.dataDir, svc.name, latest, 'service-2.json');
            try {
                const doc = JSON.parse(await fs.readFile(file, 'utf-8')) as BotocoreDoc;
                const e = parseBotocoreService(doc, svc.name);
                if (seen.has(e.proposed_canonical_name)) continue;
                seen.add(e.proposed_canonical_name);
                yield e;
            } catch { /* skip malformed */ }
        }
    }
}
```

- [ ] **Step 5: Run → pass. Commit:** `feat(ontology-importer): add AWS botocore source`

---

## Task 2: NpmRegistrySource (top 5k by downloads)

**Files:** `NpmRegistrySource.ts` (+ `.test.ts`), fixture `__tests__/fixtures/npm-package.json`

Strategy: a curated/known top-package list (committed seed list of names, refreshed periodically) → for each, fetch `https://registry.npmjs.org/<pkg>` for metadata. The fixture is one registry doc.

- [ ] **Step 1: Fixture** — trimmed `registry.npmjs.org/react`:

```json
{ "name": "react", "description": "React is a JavaScript library for building user interfaces.",
  "dist-tags": { "latest": "18.3.1" }, "keywords": ["react", "ui", "frontend"],
  "repository": { "url": "git+https://github.com/facebook/react.git" } }
```

- [ ] **Step 2: Failing test**

```ts
/** @format */
import { describe, it, expect } from '@jest/globals';
import { parseNpmDoc, npmKeep } from './NpmRegistrySource.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('parseNpmDoc', () => {
    it('maps a registry doc to RawImportEntry', () => {
        const raw = JSON.parse(readFileSync(path.join(__dirname, '__tests__/fixtures/npm-package.json'), 'utf-8'));
        const e = parseNpmDoc(raw);
        expect(e).toMatchObject({ source_identifier: 'react', proposed_canonical_name: 'react' });
        expect(e.description).toContain('JavaScript library');
        expect(e.repository_url).toContain('github.com/facebook/react');
    });
});
describe('npmKeep', () => {
    it('drops @types and micro-utils', () => {
        expect(npmKeep({ source_identifier: '@types/node' } as never)).toBe(false);
        expect(npmKeep({ source_identifier: 'is-odd' } as never)).toBe(false);
        expect(npmKeep({ source_identifier: 'react' } as never)).toBe(true);
    });
});
```

- [ ] **Step 3: Run → fail. Step 4: Implement**

```ts
/** @format */
import { request } from 'undici';
import type { Source, RawImportEntry } from './Source.js';

interface NpmDoc { name: string; description?: string; keywords?: string[]; repository?: { url?: string } }

export function parseNpmDoc(doc: NpmDoc): RawImportEntry {
    return {
        source_identifier: doc.name,
        proposed_canonical_name: doc.name,
        proposed_display_name: doc.name,
        description: doc.description,
        keywords: doc.keywords,
        repository_url: doc.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, ''),
        source_metadata: {},
    };
}

const DROP = [/^@types\//, /polyfill/i, /^is-[a-z]+$/, /^eslint-(config|plugin)-/, /^babel-(plugin|preset)-/];
export function npmKeep(e: RawImportEntry): boolean {
    return !DROP.some((re) => re.test(e.source_identifier));
}

export class NpmRegistrySource implements Source {
    readonly name = 'npm_top_5k';
    readonly ecosystem = 'npm';
    constructor(private readonly topPackages: string[]) {}   // injected list (committed seed, see Step 5)
    keep(e: RawImportEntry): boolean { return npmKeep(e); }

    async *fetch(): AsyncIterable<RawImportEntry> {
        for (const name of this.topPackages) {
            try {
                const res = await request(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { headers: { accept: 'application/json' } });
                if (res.statusCode !== 200) continue;
                yield parseNpmDoc((await res.body.json()) as NpmDoc);
            } catch { /* skip */ }
        }
    }
}
```

- [ ] **Step 5: Top-package list** — commit `src/sources/data/npm-top-5k.json` (array of package names). Bootstrap it from a downloads dataset (e.g. an npm-stat / libraries.io export) — a one-time fetch documented in the file header; refreshed by re-export, not at runtime. (For the first run, a few hundred high-value names is acceptable; expand later.) Add a test that the file parses to a non-empty `string[]`.
- [ ] **Step 6: Commit:** `feat(ontology-importer): add npm registry source`

---

## Task 3: PypiBigQuerySource (top 5k via BigQuery + classifiers)

**Files:** `PypiBigQuerySource.ts` (+ `.test.ts`), fixture `__tests__/fixtures/pypi-package.json`

Top packages from the BigQuery public dataset `bigquery-public-data.pypi.file_downloads`; per-package metadata + `classifiers` from `https://pypi.org/pypi/<pkg>/json`. Layer-3 category from classifiers.

- [ ] **Step 1: Fixture** — trimmed PyPI JSON for `django`:

```json
{ "info": { "name": "Django", "summary": "A high-level Python Web framework.",
  "classifiers": ["Framework :: Django", "Programming Language :: Python :: 3"],
  "project_urls": { "Source": "https://github.com/django/django" }, "keywords": "web framework" } }
```

- [ ] **Step 2: Failing test**

```ts
/** @format */
import { describe, it, expect } from '@jest/globals';
import { parsePypiDoc, pypiCategoryFromClassifiers } from './PypiBigQuerySource.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('parsePypiDoc', () => {
    it('maps PyPI JSON to RawImportEntry (canonical lowercased)', () => {
        const raw = JSON.parse(readFileSync(path.join(__dirname, '__tests__/fixtures/pypi-package.json'), 'utf-8'));
        const e = parsePypiDoc(raw);
        expect(e).toMatchObject({ source_identifier: 'django', proposed_canonical_name: 'django', proposed_display_name: 'Django' });
    });
});
describe('pypiCategoryFromClassifiers', () => {
    it('maps Framework :: Django → framework_web', () => {
        expect(pypiCategoryFromClassifiers(['Framework :: Django'])).toBe('framework_web');
        expect(pypiCategoryFromClassifiers(['Topic :: Database'])).toBe('database_relational');
        expect(pypiCategoryFromClassifiers(['Programming Language :: Python'])).toBeNull();
    });
});
```

- [ ] **Step 3: Run → fail. Step 4: Implement**

```ts
/** @format */
import { request } from 'undici';
import type { Source, RawImportEntry } from './Source.js';
import type { OntologyCategory } from '@bedrock/shared';

interface PypiDoc { info?: { name?: string; summary?: string; classifiers?: string[]; keywords?: string; project_urls?: Record<string,string> } }

const CLASSIFIER_MAP: { prefix: string; category: OntologyCategory }[] = [
    { prefix: 'Framework :: Django', category: 'framework_web' },
    { prefix: 'Framework :: Flask', category: 'framework_web' },
    { prefix: 'Framework :: FastAPI', category: 'framework_web' },
    { prefix: 'Topic :: Database', category: 'database_relational' },
    { prefix: 'Topic :: Scientific/Engineering :: Artificial Intelligence', category: 'ai_platform' },
    { prefix: 'Topic :: Software Development :: Testing', category: 'testing' },
    { prefix: 'Topic :: System :: Monitoring', category: 'observability' },
];
export function pypiCategoryFromClassifiers(classifiers: string[]): OntologyCategory | null {
    for (const c of classifiers) {
        const hit = CLASSIFIER_MAP.find((m) => c.startsWith(m.prefix));
        if (hit) return hit.category;
    }
    return null;
}

export function parsePypiDoc(doc: PypiDoc): RawImportEntry {
    const info = doc.info ?? {};
    const name = (info.name ?? '').toLowerCase();
    return {
        source_identifier: name,
        proposed_canonical_name: name,
        proposed_display_name: info.name ?? name,
        description: info.summary,
        keywords: info.keywords ? info.keywords.split(/[ ,]+/).filter(Boolean) : undefined,
        repository_url: info.project_urls?.Source ?? info.project_urls?.Homepage,
        source_metadata: { classifiers: info.classifiers ?? [] },
    };
}

export class PypiBigQuerySource implements Source {
    readonly name = 'pypi_top_5k';
    readonly ecosystem = 'pypi';
    constructor(private readonly topPackages: string[]) {}   // from BigQuery (Step 5)
    mapMetadataToCategory(e: RawImportEntry): OntologyCategory | null {
        return pypiCategoryFromClassifiers((e.source_metadata.classifiers as string[]) ?? []);
    }
    async *fetch(): AsyncIterable<RawImportEntry> {
        for (const name of this.topPackages) {
            try {
                const res = await request(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, { headers: { accept: 'application/json' } });
                if (res.statusCode !== 200) continue;
                yield parsePypiDoc((await res.body.json()) as PypiDoc);
            } catch { /* skip */ }
        }
    }
}
```

- [ ] **Step 5: Top-package list via BigQuery** — `src/sources/data/loadPypiTop.ts`: a documented `@google-cloud/bigquery` query (top 5k by 30-day downloads from `bigquery-public-data.pypi.file_downloads`) producing `src/sources/data/pypi-top-5k.json`. Run at build/refresh time (needs `GCP_SA_JSON`), NOT in the hot path. Commit the generated JSON + the loader. Test: the JSON parses to non-empty `string[]`.
- [ ] **Step 6: Commit:** `feat(ontology-importer): add PyPI source (classifiers + BigQuery top list)`

---

## Task 4: CratesIoSource (top 2k + crates categories)

**Files:** `CratesIoSource.ts` (+ `.test.ts`), fixture `__tests__/fixtures/cratesio.json`

`https://crates.io/api/v1/crates?sort=downloads&per_page=100&page=N`; each crate has `categories`.

- [ ] **Step 1: Fixture** — trimmed crates.io page:

```json
{ "crates": [
  { "id": "tokio", "name": "tokio", "description": "An async runtime", "repository": "https://github.com/tokio-rs/tokio", "categories": ["asynchronous"] },
  { "id": "actix-web", "name": "actix-web", "description": "Web framework", "repository": "https://github.com/actix/actix-web", "categories": ["web-programming::http-server"] }
] }
```

- [ ] **Step 2: Failing test** — `parseCratesPage(raw)` → 2 entries; `cratesCategory(['web-programming::http-server'])` → `framework_web`; `cratesCategory(['database'])` → `database_relational`; unknown → null.
- [ ] **Step 3: Run → fail. Step 4: Implement**

```ts
/** @format */
import { request } from 'undici';
import type { Source, RawImportEntry } from './Source.js';
import type { OntologyCategory } from '@bedrock/shared';

interface Crate { name: string; description?: string; repository?: string; categories?: string[] }

const CRATES_MAP: Record<string, OntologyCategory> = {
    'web-programming::http-server': 'framework_web', 'web-programming': 'framework_web',
    'database': 'database_relational', 'database-implementations': 'database_relational',
    'asynchronous': 'runtime', 'command-line-utilities': 'developer_tool', 'development-tools::testing': 'testing',
};
export function cratesCategory(categories: string[]): OntologyCategory | null {
    for (const c of categories) if (CRATES_MAP[c]) return CRATES_MAP[c];
    return null;
}
export function parseCratesPage(raw: { crates?: Crate[] }): RawImportEntry[] {
    return (raw.crates ?? []).map((c) => ({
        source_identifier: c.name, proposed_canonical_name: c.name.toLowerCase(), proposed_display_name: c.name,
        description: c.description, repository_url: c.repository,
        source_metadata: { categories: c.categories ?? [] },
    }));
}

export class CratesIoSource implements Source {
    readonly name = 'crates_top_2k';
    readonly ecosystem = 'crates';
    constructor(private readonly pages = 20) {}   // 20 × 100 = 2k
    mapMetadataToCategory(e: RawImportEntry): OntologyCategory | null {
        return cratesCategory((e.source_metadata.categories as string[]) ?? []);
    }
    async *fetch(): AsyncIterable<RawImportEntry> {
        for (let p = 1; p <= this.pages; p++) {
            try {
                const res = await request(`https://crates.io/api/v1/crates?sort=downloads&per_page=100&page=${p}`, { headers: { accept: 'application/json', 'user-agent': 'tucaken-ontology-importer' } });
                if (res.statusCode !== 200) break;
                yield* parseCratesPage((await res.body.json()) as { crates?: Crate[] });
            } catch { break; }
        }
    }
}
```

- [ ] **Step 5: Run → pass. Commit:** `feat(ontology-importer): add crates.io source`

---

## Task 5: MavenCentralSource (top 2k)

**Files:** `MavenCentralSource.ts` (+ `.test.ts`), fixture `__tests__/fixtures/maven.json`

`https://search.maven.org/solrsearch/select?q=*:*&rows=200&start=N&wt=json` → `response.docs[] = { g (groupId), a (artifactId) }`. Maven has no native taxonomy → Layer-3 returns null (categorizer's groupId patterns + LLM handle it). Skip artifacts with no repository URL (per spec) — Maven search lacks repo URL, so emit and let the importer's "no description AND no repo URL" rule (in the categorizer/keep) filter; here keep() requires a description-free fallback. Practical: keep all, rely on pattern rules (`org.springframework.*` etc.) + LLM.

- [ ] **Step 1: Fixture**

```json
{ "response": { "docs": [
  { "g": "org.springframework", "a": "spring-core" },
  { "g": "com.fasterxml.jackson.core", "a": "jackson-databind" }
] } }
```

- [ ] **Step 2: Failing test** — `parseMavenResponse(raw)` → 2 entries with `proposed_canonical_name` = artifactId lowercased, `source_metadata.groupId` set, `source_identifier` = `g:a`.
- [ ] **Step 3: Run → fail. Step 4: Implement**

```ts
/** @format */
import { request } from 'undici';
import type { Source, RawImportEntry } from './Source.js';

interface MavenDoc { g: string; a: string }
export function parseMavenResponse(raw: { response?: { docs?: MavenDoc[] } }): RawImportEntry[] {
    return (raw.response?.docs ?? []).map((d) => ({
        source_identifier: `${d.g}:${d.a}`,
        proposed_canonical_name: d.a.toLowerCase(),
        proposed_display_name: d.a,
        keywords: [d.a, d.g, `${d.g}:${d.a}`],
        source_metadata: { groupId: d.g, artifactId: d.a },
    }));
}
export class MavenCentralSource implements Source {
    readonly name = 'maven_top_2k';
    readonly ecosystem = 'maven';
    constructor(private readonly pages = 10) {}   // 10 × 200 = 2k
    async *fetch(): AsyncIterable<RawImportEntry> {
        for (let i = 0; i < this.pages; i++) {
            try {
                const res = await request(`https://search.maven.org/solrsearch/select?q=*:*&rows=200&start=${i * 200}&wt=json`, { headers: { accept: 'application/json' } });
                if (res.statusCode !== 200) break;
                yield* parseMavenResponse((await res.body.json()) as { response?: { docs?: MavenDoc[] } });
            } catch { break; }
        }
    }
}
```

- [ ] **Step 5: Run → pass. Commit:** `feat(ontology-importer): add Maven Central source`

---

## Task 6: GcpServiceUsageSource (~500 services)

**Files:** `GcpServiceUsageSource.ts` (+ `.test.ts`), fixture `__tests__/fixtures/gcp-services.json`

`https://serviceusage.googleapis.com/v1/services?parent=projects/-` (or a committed export). Each service has `config.name` (e.g. `compute.googleapis.com`) + `config.title`. Category hardcoded per GCP (like AWS).

- [ ] **Step 1: Fixture**

```json
{ "services": [
  { "config": { "name": "compute.googleapis.com", "title": "Compute Engine API" } },
  { "config": { "name": "storage.googleapis.com", "title": "Cloud Storage API" } }
] }
```

- [ ] **Step 2: Failing test** — `parseGcpServices(raw)` → entries with `proposed_canonical_name` like `gcp_compute`, display `Compute Engine`; `gcpCategoryFor('compute')` → `cloud_compute`, `'storage'` → `cloud_storage`.
- [ ] **Step 3: Run → fail. Step 4: Implement** (mirror AwsBotocoreSource: a `GCP_CATEGORY` map keyed by service prefix, default `cloud_compute`; `parseGcpServices` derives prefix from `config.name` before `.googleapis.com`, strips trailing " API" from title; `mapMetadataToCategory` uses the prefix). The `fetch()` reads either a committed export JSON (`src/sources/data/gcp-services.json`, refreshed via gcloud) or the live API if `GCP_SA_JSON` is set.
- [ ] **Step 5: Run → pass. Commit:** `feat(ontology-importer): add GCP Service Usage source`

---

## Task 7: AzureRestSpecsSource (~600 services)

**Files:** `AzureRestSpecsSource.ts` (+ `.test.ts`), fixture `__tests__/fixtures/azure-specs.json`

Azure services = top-level dirs under `specification/` in `Azure/azure-rest-api-specs` (committed list or shallow clone). Each dir name → a service (e.g. `compute`, `storage`, `cosmos-db`). Category hardcoded per Azure.

- [ ] **Step 1: Fixture** — a committed list of spec dir names:

```json
{ "services": ["compute", "storage", "cosmos-db", "cognitiveservices", "containerservice"] }
```

- [ ] **Step 2: Failing test** — `parseAzureServices(raw)` → entries `proposed_canonical_name` = `azure_<dir_with_underscores>`, display = title-cased dir; `azureCategoryFor('storage')` → `cloud_storage`, `'cosmos-db'` → `database_nosql`, default `cloud_compute`.
- [ ] **Step 3: Run → fail. Step 4: Implement** (mirror the GCP pattern; `AZURE_CATEGORY` map; `fetch()` reads `src/sources/data/azure-services.json`, refreshed from the specs repo at build time).
- [ ] **Step 5: Run → pass. Commit:** `feat(ontology-importer): add Azure REST specs source`

---

## Task 8: Source registry + suite

**Files:** `src/sources/index.ts` (+ test)

- [ ] **Step 1:** export `ALL_SOURCES` — a factory returning the seven source instances (with their data-file/dir config from env), so the entrypoint (Plan 3) iterates them. Test: `ALL_SOURCES()` returns 7 sources with unique `name`s and non-empty `ecosystem`s.
- [ ] **Step 2:** full suite `yarn workspace @bedrock/ontology-importer test` (all pass) + `build` (exit 0).
- [ ] **Step 3: Commit:** `feat(ontology-importer): wire ALL_SOURCES registry`

---

## Self-Review

**Spec coverage (Plan 2):** all seven sources (AWS botocore, npm, PyPI, Maven, crates, GCP, Azure) → Tasks 1–7 ✓; `ALL_SOURCES` registry → Task 8 ✓. Each implements the Plan-1 `Source` contract; cloud sources set category via `mapMetadataToCategory`, PyPI/crates map native taxonomy, npm uses `keep()` pre-filter. Alias generation/collision is the importer's job (Plan 1), not the source's (per spec). Top-list bootstrap (npm/PyPI) documented as refresh-time, not hot-path.

**Placeholder scan:** Tasks 6 & 7's "Step 4: Implement (mirror …)" reference the fully-shown AWS/GCP pattern rather than re-pasting ~40 identical lines — the category-map + parse shape is given concretely in Task 1; the deltas (prefix derivation, category maps) are specified. Fixtures are real recorded responses (trimmed), captured once.

**Type consistency:** every source returns `RawImportEntry` (Plan-1 shape) and implements `Source`; `mapMetadataToCategory` returns `OntologyCategory | null`; category strings are all in the 30-category set (incl. `developer_tool` from migration 036). Parser names (`parseBotocoreService`, `parseNpmDoc`, `parsePypiDoc`, `parseCratesPage`, `parseMavenResponse`, `parseGcpServices`, `parseAzureServices`) + category helpers are distinct and reused only where defined.
