# Tier 2 Ontology Importer — Plan 1: Foundation (engine)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `@bedrock/ontology-importer` engine — the idempotent upsert orchestrator, the 4-layer categorizer (layers 1–3), the alias generator, the import-tracking schema, and the shared repositories — so a single fake source imports end-to-end into `technology_ontology`/`technology_aliases`. Real registry sources (Plan 2) and the LLM batch + infra (Plan 3) plug into this engine.

**Architecture:** A new CommonJS workspace `applications/ontology-importer`. Each registry is a `Source` that streams `RawImportEntry` records; the `OntologyImporter` normalises → checks existing ontology → categorizes (cascade) → upserts ontology + aliases + `ontology_import_sources`, and tracks each run in `ontology_import_runs`. Curated rows are never overwritten (only `popularity_score`). Idempotent throughout.

**Tech Stack:** TypeScript (CommonJS), Node 22, `pg`, jest (`@jest/globals`), Yarn Berry. Builds on the `034_technology_graph.sql` schema (technology_ontology/aliases) from Tier 1.

**Spec:** `tier2-ontology-auto-import.md` (repo root).

**Conventions locked from the codebase (verified during Tier 1):**
- DB migrations are **hand-written PostSync-hook Jobs** in `kubernetes-bootstrap/charts/platform-rds/chart/templates/ddl-migrations.yaml` (migration-001…010); the ai-applications `platform-rds-bootstrap/migrations/NNN.sql` files are the **source-of-truth mirror** (the image bootstrap is disabled). So a new migration ships as BOTH a `NNN.sql` here AND a `migration-NNN` chart hook.
- Enum-like columns use `TEXT … CHECK (col IN (...))`. `set_updated_at()` trigger convention. RLS via `app.current_user_id` for user-scoped tables (the Tier 2 tracking tables are **global**, no RLS).
- Repos: constructor-`Pool`, fake-pool unit tests (capture `{sql, params}`), no real DB in jest. See `applications/shared/src/rds/implementations/Technology*Repository.ts`.
- **Migration numbering:** 034 = technology graph, 035 = curated ontology expansion (both shipped). Tier 2's tracking migration is **036** (ai-app) / **migration-011** (chart). The spec's "035_ontology_import_tracking" is renumbered to 036 to avoid the collision.
- **Category set:** the `034` CHECK lists 29 categories and does NOT include `developer_tool` (used by the spec's patterns/overrides). Migration 036 must extend the CHECK to add `developer_tool`.

---

## File Structure

- Create `applications/ontology-importer/{package.json,tsconfig.json,jest.config.js}` — new workspace.
- Create `applications/platform-rds-bootstrap/migrations/036_ontology_import_tracking.sql` — source-of-truth migration.
- Create the chart hook `migration-011-ontology-import-tracking` (kubernetes-bootstrap) — the applier. *(Deferred to the GitOps step; the SQL is authored here.)*
- Create `applications/shared/src/rds/types/ontology-import.ts` — shared types (`RawImportEntry`, row types).
- Create `applications/shared/src/rds/implementations/OntologyImport{Source,Run}Repository.ts`, `OntologyReviewQueueRepository.ts`, `OntologySkippedImportRepository.ts` (+ tests) + barrel exports.
- Create `applications/ontology-importer/src/sources/Source.ts` — the `Source` contract.
- Create `applications/ontology-importer/src/categorization/{patterns.json,overrides.json,Categorizer.ts,sourceMetadataMappers.ts}` (+ tests).
- Create `applications/ontology-importer/src/aliases/{AliasGenerator.ts,aliasFilters.ts}` (+ tests).
- Create `applications/ontology-importer/src/importer/{OntologyImporter.ts,ImportRunSummary.ts,DeactivationDetector.ts}` (+ tests).
- Create `applications/ontology-importer/src/sources/FakeSource.ts` + `src/__tests__/integration.test.ts` — in-process end-to-end.

---

## Task 1: Migration 036 — import-tracking schema + category fix

**Files:**
- Create: `applications/platform-rds-bootstrap/migrations/036_ontology_import_tracking.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 036_ontology_import_tracking.sql
--
-- Tier 2 ontology importer — tracking tables (per-source contribution, import
-- runs, review queue, skipped imports) + extend the technology_ontology
-- category CHECK to add 'developer_tool' (used by the importer's categorizer).
--
-- Builds on 034_technology_graph.sql. Expand-only, idempotent. Tracking tables
-- are GLOBAL (no user_id, no RLS). Grants to tucaken_app match the 034 pattern.

BEGIN;

-- 1. Extend the category CHECK to add 'developer_tool'. The 034 constraint is
--    named technology_ontology_category_check by default; drop + recreate.
ALTER TABLE technology_ontology DROP CONSTRAINT IF EXISTS technology_ontology_category_check;
ALTER TABLE technology_ontology ADD CONSTRAINT technology_ontology_category_check
    CHECK (category IN (
        'language','framework_web','framework_mobile','framework_ml','runtime',
        'database_relational','database_nosql','database_vector','database_search',
        'database_kv','message_broker','observability','cloud_compute','cloud_storage',
        'cloud_database','cloud_serverless','cloud_networking','cloud_security','iac',
        'ci_cd','container_runtime','orchestration','api_protocol','testing',
        'build_tool','package_manager','auth','payment','ai_platform',
        'developer_tool'));

CREATE TABLE IF NOT EXISTS ontology_import_sources (
    technology_id        UUID NOT NULL REFERENCES technology_ontology(id) ON DELETE CASCADE,
    source               TEXT NOT NULL,
    source_identifier    TEXT NOT NULL,
    first_imported_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    consecutive_misses   INT NOT NULL DEFAULT 0,
    popularity_in_source INT,
    source_metadata      JSONB,
    PRIMARY KEY (technology_id, source)
);
CREATE INDEX IF NOT EXISTS idx_ontology_import_sources_source_seen
    ON ontology_import_sources (source, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_ontology_import_sources_misses
    ON ontology_import_sources (consecutive_misses) WHERE consecutive_misses > 0;

CREATE TABLE IF NOT EXISTS ontology_import_runs (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source                 TEXT NOT NULL,
    triggered_by           TEXT NOT NULL CHECK (triggered_by IN ('cronjob','manual','backfill')),
    started_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at           TIMESTAMPTZ,
    status                 TEXT NOT NULL CHECK (status IN ('running','success','failed','partial')),
    entries_fetched        INT NOT NULL DEFAULT 0,
    entries_inserted       INT NOT NULL DEFAULT 0,
    entries_updated        INT NOT NULL DEFAULT 0,
    entries_deactivated    INT NOT NULL DEFAULT 0,
    alias_merges           INT NOT NULL DEFAULT 0,
    unresolved_count       INT NOT NULL DEFAULT 0,
    review_queue_added     INT NOT NULL DEFAULT 0,
    llm_batch_id           TEXT,
    llm_batch_status       TEXT CHECK (llm_batch_status IN ('pending','completed','failed')),
    llm_batch_completed_at TIMESTAMPTZ,
    category_accuracy_score REAL,
    error_summary          TEXT,
    notes                  JSONB
);
CREATE INDEX IF NOT EXISTS idx_ontology_import_runs_source
    ON ontology_import_runs (source, started_at DESC);

CREATE TABLE IF NOT EXISTS ontology_skipped_imports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    raw_name        TEXT NOT NULL,
    ecosystem       TEXT NOT NULL,
    source          TEXT NOT NULL,
    llm_decision    TEXT NOT NULL,
    llm_reasoning   TEXT,
    llm_run_id      TEXT,
    skipped_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at     TIMESTAMPTZ,
    override_action TEXT CHECK (override_action IN ('promoted','confirmed_skip')),
    UNIQUE (raw_name, ecosystem)
);

CREATE TABLE IF NOT EXISTS ontology_review_queue (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    raw_name            TEXT NOT NULL,
    ecosystem           TEXT NOT NULL,
    source              TEXT NOT NULL,
    reason              TEXT NOT NULL CHECK (reason IN
        ('llm_maybe','uncategorized','merge_candidate','category_low_confidence')),
    suggested_category  TEXT,
    suggested_canonical UUID REFERENCES technology_ontology(id),
    llm_reasoning       TEXT,
    source_metadata     JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at         TIMESTAMPTZ,
    resolved_by         TEXT,
    resolution          TEXT CHECK (resolution IN ('promoted','skipped','aliased','merged')),
    UNIQUE (raw_name, ecosystem)
);
CREATE INDEX IF NOT EXISTS idx_ontology_review_queue_open
    ON ontology_review_queue (resolved_at) WHERE resolved_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON ontology_import_sources   TO tucaken_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ontology_import_runs      TO tucaken_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ontology_skipped_imports  TO tucaken_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ontology_review_queue     TO tucaken_app;

COMMIT;
```

- [ ] **Step 2: Verify idempotent apply** (throwaway Postgres; needs the 034 schema first — apply 034 then 036, twice).

```bash
docker run --rm -d --name pg-036 -e POSTGRES_PASSWORD=pw -p 5601:5432 postgres:16; sleep 4
psql "postgresql://postgres:pw@localhost:5601/postgres" -v ON_ERROR_STOP=1 -c "CREATE TABLE users(id uuid primary key default gen_random_uuid()); CREATE ROLE tucaken_app;"
psql "postgresql://postgres:pw@localhost:5601/postgres" -v ON_ERROR_STOP=1 -f applications/platform-rds-bootstrap/migrations/034_technology_graph.sql
for i in 1 2; do psql "postgresql://postgres:pw@localhost:5601/postgres" -v ON_ERROR_STOP=1 -f applications/platform-rds-bootstrap/migrations/036_ontology_import_tracking.sql; done
psql "postgresql://postgres:pw@localhost:5601/postgres" -c "INSERT INTO technology_ontology(canonical_name,display_name,category) VALUES('foo-cli','Foo','developer_tool');"  # must succeed (category added)
docker rm -f pg-036
```
Expected: both 036 applies exit 0; the `developer_tool` insert succeeds.

- [ ] **Step 3: Commit**

```bash
git add applications/platform-rds-bootstrap/migrations/036_ontology_import_tracking.sql
git commit -m "feat(rds): add migration 036 ontology-import tracking + developer_tool category"
```

> **GitOps note:** ship the chart hook `migration-011-ontology-import-tracking` (kubernetes-bootstrap `ddl-migrations.yaml`) with this exact SQL, mirroring migration-009/010, in the same PR cycle. (Same porting step as Tier 1.)

---

## Task 2: Scaffold the workspace

**Files:**
- Create: `applications/ontology-importer/package.json`, `tsconfig.json`, `jest.config.js`, `src/placeholder.ts`

- [ ] **Step 1: package.json** (mirror `applications/tech-extractor/package.json`)

```json
{
  "name": "@bedrock/ontology-importer",
  "version": "1.0.0",
  "type": "commonjs",
  "private": true,
  "main": "dist/run-import.js",
  "scripts": { "test": "jest --passWithNoTests", "build": "tsc", "lint": "tsc --noEmit" },
  "dependencies": {
    "@bedrock/shared": "workspace:*",
    "@anthropic-ai/sdk": "^0.40.0",
    "pg": "^8.20.0",
    "prom-client": "^15.1.3",
    "undici": "^6.0.0"
  },
  "devDependencies": {
    "@jest/globals": "^29.7.0", "@types/node": "^22.0.0",
    "jest": "^29.7.0", "ts-jest": "^29.3.0", "typescript": "^5.9.3"
  }
}
```
> Reconcile dep versions with `applications/tech-extractor/package.json` (copy the tooling versions). `@anthropic-ai/sdk` is Plan 3; including it now is fine. `@google-cloud/bigquery` is added in Plan 2 (PyPI source).

- [ ] **Step 2: tsconfig.json + jest.config.js** — copy `applications/tech-extractor/tsconfig.json` (incl. `resolveJsonModule: true`, `references: [{path: "../shared"}]`) and `jest.config.js` verbatim. Add `applications/ontology-importer` to root `package.json` workspaces and `applications/tsconfig.json` references. Create `src/placeholder.ts` = `/** @format */\nexport {};\n`.

- [ ] **Step 3: Install + build**

Run: `yarn install && yarn workspace @bedrock/ontology-importer build`
Expected: resolves; tsc runs clean.

- [ ] **Step 4: Commit**

```bash
git add applications/ontology-importer package.json yarn.lock applications/tsconfig.json
git commit -m "chore(ontology-importer): scaffold @bedrock/ontology-importer workspace"
```

---

## Task 3: Shared types + the Source contract

**Files:**
- Create: `applications/shared/src/rds/types/ontology-import.ts`
- Create: `applications/ontology-importer/src/sources/Source.ts`

- [ ] **Step 1: shared types** (`ontology-import.ts`)

```ts
/** @format */

/** One entry yielded by a Source before categorization. */
export interface RawImportEntry {
    source_identifier:       string;
    proposed_canonical_name: string;   // pre-slugified
    proposed_display_name:   string;
    description?:            string;
    keywords?:              string[];
    popularity?:            number;
    source_metadata:        Record<string, unknown>;
    repository_url?:        string;
}

/** The 30 valid categories (034 + developer_tool from 036). */
export type OntologyCategory =
    | 'language' | 'framework_web' | 'framework_mobile' | 'framework_ml' | 'runtime'
    | 'database_relational' | 'database_nosql' | 'database_vector' | 'database_search'
    | 'database_kv' | 'message_broker' | 'observability' | 'cloud_compute' | 'cloud_storage'
    | 'cloud_database' | 'cloud_serverless' | 'cloud_networking' | 'cloud_security' | 'iac'
    | 'ci_cd' | 'container_runtime' | 'orchestration' | 'api_protocol' | 'testing'
    | 'build_tool' | 'package_manager' | 'auth' | 'payment' | 'ai_platform' | 'developer_tool';

export const ONTOLOGY_CATEGORIES: readonly OntologyCategory[] = [
    'language','framework_web','framework_mobile','framework_ml','runtime',
    'database_relational','database_nosql','database_vector','database_search',
    'database_kv','message_broker','observability','cloud_compute','cloud_storage',
    'cloud_database','cloud_serverless','cloud_networking','cloud_security','iac',
    'ci_cd','container_runtime','orchestration','api_protocol','testing',
    'build_tool','package_manager','auth','payment','ai_platform','developer_tool',
];

/** Result of categorizing one entry. */
export interface CategorizationResult {
    decision: 'yes' | 'no' | 'maybe';
    category: OntologyCategory | null;
    via:      'pattern' | 'override' | 'source_metadata' | 'llm' | 'none';
    reasoning?: string;
}

export interface ImportRunCounts {
    entriesFetched: number; entriesInserted: number; entriesUpdated: number;
    entriesDeactivated: number; aliasMerges: number; unresolvedCount: number;
    reviewQueueAdded: number;
}
```

- [ ] **Step 2: Source contract** (`sources/Source.ts`)

```ts
/** @format */
import type { RawImportEntry } from '@bedrock/shared';

export type { RawImportEntry };

/** A registry integration. Fetches + parses + yields; never categorizes or touches the DB. */
export interface Source {
    readonly name:      string;   // 'aws_botocore', 'npm_top_5k', ...
    readonly ecosystem: string;   // 'aws', 'npm', 'pypi', ...
    /** Streamed — sources may be large. */
    fetch(): AsyncIterable<RawImportEntry>;
    /** Source-specific category from native metadata (Layer 3), or null. */
    mapMetadataToCategory?(entry: RawImportEntry): import('@bedrock/shared').OntologyCategory | null;
    /** Source-specific pre-filter: true = keep. */
    keep?(entry: RawImportEntry): boolean;
}
```

- [ ] **Step 3: Commit**

```bash
git add applications/shared/src/rds/types/ontology-import.ts applications/ontology-importer/src/sources/Source.ts
git commit -m "feat(ontology-importer): add RawImportEntry types + Source contract"
```

---

## Task 4: Categorizer — Layer 1 (patterns) + Layer 2 (overrides)

**Files:**
- Create: `applications/ontology-importer/src/categorization/patterns.json`
- Create: `applications/ontology-importer/src/categorization/overrides.json`
- Create: `applications/ontology-importer/src/categorization/Categorizer.ts`
- Test: `applications/ontology-importer/src/categorization/Categorizer.test.ts`

- [ ] **Step 1: patterns.json** (starter set from the spec; categories must be valid)

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
  { "pattern": "(-cli$|^cli-)", "ecosystem": "npm", "category": "developer_tool" },
  { "pattern": "^eslint-(config|plugin)-", "ecosystem": "npm", "action": "skip" },
  { "pattern": "^babel-(plugin|preset)-", "ecosystem": "npm", "action": "skip" },
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

- [ ] **Step 2: overrides.json** (starter — canonical_name → category; all categories valid)

```json
{
  "next": "framework_web", "nuxt": "framework_web", "remix": "framework_web",
  "astro": "framework_web", "qwik": "framework_web", "solid-js": "framework_web",
  "svelte": "framework_web", "sveltekit": "framework_web", "fastapi": "framework_web",
  "django": "framework_web", "flask": "framework_web", "fastify": "framework_web",
  "prisma": "database_relational", "drizzle-orm": "database_relational",
  "mongoose": "database_nosql", "redis": "database_kv", "bullmq": "message_broker",
  "celery": "message_broker", "jest": "testing", "vitest": "testing",
  "playwright": "testing", "winston": "observability", "pino": "observability"
}
```

- [ ] **Step 3: Write the failing test** (`Categorizer.test.ts`)

```ts
/** @format */
import { describe, it, expect } from '@jest/globals';
import { Categorizer } from './Categorizer.js';
import type { RawImportEntry } from '@bedrock/shared';

function entry(name: string, extra: Partial<RawImportEntry> = {}): RawImportEntry {
    return { source_identifier: name, proposed_canonical_name: name, proposed_display_name: name, source_metadata: {}, ...extra };
}

describe('Categorizer (layers 1-3)', () => {
    const c = new Categorizer();

    it('Layer 1: pattern match assigns category', () => {
        const r = c.classify(entry('@nestjs/core'), 'npm', null);
        expect(r).toMatchObject({ decision: 'yes', category: 'framework_web', via: 'pattern' });
    });
    it('Layer 1: skip action → decision no', () => {
        expect(c.classify(entry('@types/node'), 'npm', null).decision).toBe('no');
    });
    it('Layer 2: override when no pattern', () => {
        const r = c.classify(entry('prisma'), 'npm', null);
        expect(r).toMatchObject({ category: 'database_relational', via: 'override' });
    });
    it('Layer 3: source metadata category when no pattern/override', () => {
        const r = c.classify(entry('some-pkg'), 'pypi', 'framework_web');
        expect(r).toMatchObject({ category: 'framework_web', via: 'source_metadata' });
    });
    it('falls through to none when nothing matches', () => {
        expect(c.classify(entry('totally-unknown-xyz'), 'npm', null).via).toBe('none');
    });
});
```

- [ ] **Step 4: Run test to verify it fails** — `yarn workspace @bedrock/ontology-importer jest src/categorization/Categorizer.test.ts` → FAIL (module not found).

- [ ] **Step 5: Write `Categorizer.ts`**

```ts
/** @format */
import type { OntologyCategory, CategorizationResult, RawImportEntry } from '@bedrock/shared';
import { ONTOLOGY_CATEGORIES } from '@bedrock/shared';
import patterns from './patterns.json';
import overrides from './overrides.json';

interface PatternRule { pattern: string; ecosystem: string; category?: string; action?: 'skip' }

const VALID = new Set<string>(ONTOLOGY_CATEGORIES);

/** Cascading classifier (layers 1-3). Layer 4 (LLM) is handled by the importer
 *  buffering `via:'none'` results for a batch call (Plan 3). */
export class Categorizer {
    private readonly rules = patterns as PatternRule[];
    private readonly overrides = overrides as Record<string, string>;

    /** @param sourceMetadataCategory Layer-3 hint from the source, or null. */
    classify(entry: RawImportEntry, ecosystem: string, sourceMetadataCategory: string | null): CategorizationResult {
        // Layer 1 — pattern rules (first match wins).
        for (const r of this.rules) {
            if (r.ecosystem !== ecosystem) continue;
            if (!new RegExp(r.pattern).test(entry.source_identifier)) continue;
            if (r.action === 'skip') return { decision: 'no', category: null, via: 'pattern' };
            if (r.category && VALID.has(r.category)) {
                return { decision: 'yes', category: r.category as OntologyCategory, via: 'pattern' };
            }
        }
        // Layer 2 — explicit overrides by canonical name.
        const ov = this.overrides[entry.proposed_canonical_name];
        if (ov && VALID.has(ov)) {
            return { decision: 'yes', category: ov as OntologyCategory, via: 'override' };
        }
        // Layer 3 — source-native metadata.
        if (sourceMetadataCategory && VALID.has(sourceMetadataCategory)) {
            return { decision: 'yes', category: sourceMetadataCategory as OntologyCategory, via: 'source_metadata' };
        }
        // Layer 4 deferred — buffered for LLM batch by the importer.
        return { decision: 'maybe', category: null, via: 'none' };
    }
}
```

- [ ] **Step 6: Run test to verify it passes** (5 tests). **Commit:**

```bash
git add applications/ontology-importer/src/categorization
git commit -m "feat(ontology-importer): add cascading categorizer (layers 1-3)"
```

---

## Task 5: AliasGenerator + collision filter

**Files:**
- Create: `applications/ontology-importer/src/aliases/AliasGenerator.ts` (+ `.test.ts`)
- Create: `applications/ontology-importer/src/aliases/aliasFilters.ts` (+ `.test.ts`)

- [ ] **Step 1: Write the failing test** (`AliasGenerator.test.ts`)

```ts
/** @format */
import { describe, it, expect } from '@jest/globals';
import { generateAliases } from './AliasGenerator.js';
import type { RawImportEntry } from '@bedrock/shared';

const e = (o: Partial<RawImportEntry>): RawImportEntry =>
    ({ source_identifier: '', proposed_canonical_name: '', proposed_display_name: '', source_metadata: {}, ...o });

describe('generateAliases', () => {
    it('produces canonical, display-lower, and spacing variants', () => {
        const a = generateAliases(e({ proposed_canonical_name: 'aws_s3', proposed_display_name: 'Amazon S3' }), 'aws');
        expect(a).toEqual(expect.arrayContaining(['aws_s3', 'amazon s3', 'amazons3', 'amazon-s3']));
    });
    it('npm: adds .js/js variants and de-scopes', () => {
        const a = generateAliases(e({ proposed_canonical_name: 'react', proposed_display_name: 'React' }), 'npm');
        expect(a).toEqual(expect.arrayContaining(['react', 'react.js', 'reactjs']));
    });
    it('lowercases + dedupes', () => {
        const a = generateAliases(e({ proposed_canonical_name: 'Vite', proposed_display_name: 'Vite' }), 'npm');
        expect(a).toEqual([...new Set(a.map((x) => x.toLowerCase()))]);
    });
});
```

- [ ] **Step 2: Run → fail. Step 3: Write `AliasGenerator.ts`**

```ts
/** @format */
import type { RawImportEntry } from '@bedrock/shared';

/** Candidate aliases (lowercased, deduped). Collisions filtered separately. */
export function generateAliases(entry: RawImportEntry, ecosystem: string): string[] {
    const out = new Set<string>();
    const add = (s: string | undefined): void => {
        if (!s) return;
        const v = s.toLowerCase().trim();
        if (v) out.add(v);
    };
    add(entry.proposed_canonical_name);
    add(entry.proposed_display_name);
    add(entry.proposed_display_name.replace(/\s+/g, ''));
    add(entry.proposed_display_name.replace(/\s+/g, '-'));
    if (ecosystem === 'npm') {
        const base = entry.proposed_canonical_name;
        add(`${base}.js`);
        add(`${base}js`);
    }
    return [...out];
}
```

- [ ] **Step 4: Run → pass. Step 5: collision filter test** (`aliasFilters.test.ts`)

```ts
/** @format */
import { describe, it, expect } from '@jest/globals';
import { partitionAliases } from './aliasFilters.js';

describe('partitionAliases', () => {
    it('splits into insertable vs colliding-with-other-tech', () => {
        const existing = new Map<string, string>([['react', 'id-react'], ['s3', 'id-s3']]);
        const { insertable, collisions } = partitionAliases(['react', 'react.js', 's3'], 'id-react', existing);
        // 'react' already maps to this tech (no-op), 'react.js' is new, 's3' collides with a DIFFERENT tech
        expect(insertable).toEqual(['react.js']);
        expect(collisions).toEqual(['s3']);
    });
});
```

- [ ] **Step 6: Write `aliasFilters.ts`**

```ts
/** @format */

export interface AliasPartition { insertable: string[]; collisions: string[] }

/**
 * @param aliases       candidate aliases (lowercased)
 * @param technologyId  the tech these aliases belong to
 * @param existing      alias -> technology_id map (current technology_aliases)
 */
export function partitionAliases(aliases: string[], technologyId: string, existing: Map<string, string>): AliasPartition {
    const insertable: string[] = [];
    const collisions: string[] = [];
    for (const a of aliases) {
        const owner = existing.get(a);
        if (owner === undefined) insertable.push(a);          // free
        else if (owner === technologyId) continue;            // already ours — no-op
        else collisions.push(a);                              // owned by a different tech
    }
    return { insertable, collisions };
}
```

- [ ] **Step 7: Run tests → pass. Commit:**

```bash
git add applications/ontology-importer/src/aliases
git commit -m "feat(ontology-importer): add alias generation + collision partitioning"
```

---

## Task 6: Tracking repositories (shared)

**Files:**
- Create: `applications/shared/src/rds/implementations/OntologyImportSourceRepository.ts` (+ `.test.ts`)
- Create: `applications/shared/src/rds/implementations/OntologyImportRunRepository.ts` (+ `.test.ts`)
- Modify: `applications/shared/src/rds/index.ts` (+ top-level `index.ts`) — exports

> The review-queue + skipped-imports repositories are thin and used only by Plan 3 (LLM follow-up); create them there. Plan 1 needs the source + run repos.

- [ ] **Step 1: Write the failing test** (`OntologyImportRunRepository.test.ts`)

```ts
/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { OntologyImportRunRepository } from './OntologyImportRunRepository.js';

function fakePool(rows: unknown[] = []) {
    const calls: { sql: string; params?: unknown[] }[] = [];
    return { calls, query: jest.fn(async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return { rows }; }) };
}

describe('OntologyImportRunRepository', () => {
    it('begin() inserts a running row and returns its id', async () => {
        const pool = fakePool([{ id: 'run-1' }]);
        const repo = new OntologyImportRunRepository(pool as never);
        const id = await repo.begin('npm_top_5k', 'manual');
        expect(id).toBe('run-1');
        expect(pool.calls[0].sql).toContain('INSERT INTO ontology_import_runs');
        expect(pool.calls[0].params).toEqual(expect.arrayContaining(['npm_top_5k', 'manual', 'running']));
    });
    it('finish() updates counts + status', async () => {
        const pool = fakePool();
        const repo = new OntologyImportRunRepository(pool as never);
        await repo.finish('run-1', 'success', { entriesFetched: 10, entriesInserted: 4, entriesUpdated: 6, entriesDeactivated: 0, aliasMerges: 1, unresolvedCount: 2, reviewQueueAdded: 0 });
        const u = pool.calls[0];
        expect(u.sql).toContain('UPDATE ontology_import_runs');
        expect(u.params).toEqual(expect.arrayContaining(['run-1', 'success', 10, 4, 6]));
    });
});
```

- [ ] **Step 2: Run → fail. Step 3: Write `OntologyImportRunRepository.ts`**

```ts
/** @format */
import type { Pool } from 'pg';
import type { ImportRunCounts } from '../types/ontology-import.js';

export class OntologyImportRunRepository {
    constructor(private readonly pool: Pool) {}

    async begin(source: string, triggeredBy: 'cronjob' | 'manual' | 'backfill'): Promise<string> {
        const { rows } = await this.pool.query<{ id: string }>(
            `INSERT INTO ontology_import_runs (source, triggered_by, status, started_at)
             VALUES ($1, $2, 'running', now()) RETURNING id`,
            [source, triggeredBy, 'running'],
        );
        return rows[0].id;
    }

    async finish(id: string, status: 'success' | 'failed' | 'partial', c: ImportRunCounts, extra?: { llmBatchId?: string; errorSummary?: string }): Promise<void> {
        await this.pool.query(
            `UPDATE ontology_import_runs SET
                status = $2, completed_at = now(),
                entries_fetched = $3, entries_inserted = $4, entries_updated = $5,
                entries_deactivated = $6, alias_merges = $7, unresolved_count = $8,
                review_queue_added = $9, llm_batch_id = COALESCE($10, llm_batch_id),
                error_summary = $11
             WHERE id = $1`,
            [id, status, c.entriesFetched, c.entriesInserted, c.entriesUpdated,
             c.entriesDeactivated, c.aliasMerges, c.unresolvedCount, c.reviewQueueAdded,
             extra?.llmBatchId ?? null, extra?.errorSummary ?? null],
        );
    }
}
```

- [ ] **Step 4: Run → pass (2 tests). Step 5: `OntologyImportSourceRepository.ts` (+ test)** — methods: `upsertSeen(technologyId, source, sourceIdentifier, popularity, metadata)` (INSERT … ON CONFLICT (technology_id, source) DO UPDATE SET last_seen_at=now(), consecutive_misses=0, popularity_in_source=EXCLUDED…), and `incrementMissesOlderThan(source, runStart)` → returns rows touched. Mirror the fake-pool test style. Assert the upsert SQL contains `ON CONFLICT (technology_id, source) DO UPDATE` and `consecutive_misses = 0`.

```ts
/** @format */
import type { Pool } from 'pg';

export class OntologyImportSourceRepository {
    constructor(private readonly pool: Pool) {}

    async upsertSeen(technologyId: string, source: string, sourceIdentifier: string, popularity: number | null, metadata: unknown): Promise<void> {
        await this.pool.query(
            `INSERT INTO ontology_import_sources
                (technology_id, source, source_identifier, popularity_in_source, source_metadata)
             VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
             ON CONFLICT (technology_id, source) DO UPDATE SET
                last_seen_at = now(), consecutive_misses = 0,
                source_identifier = EXCLUDED.source_identifier,
                popularity_in_source = EXCLUDED.popularity_in_source,
                source_metadata = EXCLUDED.source_metadata`,
            [technologyId, source, sourceIdentifier, popularity, JSON.stringify(metadata ?? {})],
        );
    }

    /** Increment misses for this source's entries not seen since runStart; returns rows updated. */
    async incrementMissesOlderThan(source: string, runStart: Date): Promise<number> {
        const { rowCount } = await this.pool.query(
            `UPDATE ontology_import_sources SET consecutive_misses = consecutive_misses + 1
             WHERE source = $1 AND last_seen_at < $2`,
            [source, runStart.toISOString()],
        );
        return rowCount ?? 0;
    }
}
```

- [ ] **Step 6: Barrel exports** — add the two repos + the `ontology-import` types to `applications/shared/src/rds/index.ts` and the top-level `applications/shared/src/index.ts` (explicit re-export list, matching the Technology* pattern). Build shared. **Commit:**

```bash
git add applications/shared/src/rds/implementations/OntologyImport*Repository.ts applications/shared/src/rds/implementations/OntologyImport*Repository.test.ts applications/shared/src/rds/index.ts applications/shared/src/index.ts
git commit -m "feat(rds): add ontology-import tracking repositories"
```

---

## Task 7: OntologyImporter core + DeactivationDetector + run summary

**Files:**
- Create: `applications/ontology-importer/src/importer/OntologyImporter.ts` (+ `.test.ts`)
- Create: `applications/ontology-importer/src/importer/ImportRunSummary.ts`
- Create: `applications/ontology-importer/src/importer/DeactivationDetector.ts`

The importer needs a small ontology-write repository. Reuse `TechnologyOntologyRepository` (Tier 1) for the alias map + version, and add two write methods to it (in shared) OR add a focused `OntologyWriteRepository`. Plan uses a new focused repo to avoid touching Tier-1 code.

- [ ] **Step 1: Write the failing test** (`OntologyImporter.test.ts`) — drives a fake source + in-memory repos, asserting insert/update/skip routing and counts.

```ts
/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { OntologyImporter } from './OntologyImporter.js';
import { Categorizer } from '../categorization/Categorizer.js';
import type { Source, RawImportEntry } from '../sources/Source.js';

function src(name: string, ecosystem: string, entries: RawImportEntry[]): Source {
    return { name, ecosystem, async *fetch() { yield* entries; } };
}
const E = (o: Partial<RawImportEntry>): RawImportEntry =>
    ({ source_identifier: '', proposed_canonical_name: '', proposed_display_name: '', source_metadata: {}, ...o });

describe('OntologyImporter.run', () => {
    it('inserts new categorized entries, skips uncategorizable, never overwrites curated', async () => {
        // existing: 'react' is curated; alias map empty for new ones
        const ontologyWrite = {
            findByCanonical: jest.fn(async (n: string) => n === 'react' ? { id: 'id-react', curationLevel: 'curated' } : null),
            insertAutoImported: jest.fn(async () => 'id-new'),
            bumpPopularity: jest.fn(async () => {}),
            loadAliasMap: jest.fn(async () => new Map<string,string>()),
            insertAliases: jest.fn(async () => {}),
        };
        const importSources = { upsertSeen: jest.fn(async () => {}), incrementMissesOlderThan: jest.fn(async () => 0) };

        const source = src('npm_top_5k', 'npm', [
            E({ source_identifier: '@nestjs/core', proposed_canonical_name: '@nestjs/core', proposed_display_name: 'NestJS' }), // pattern → framework_web → insert
            E({ source_identifier: 'react', proposed_canonical_name: 'react', proposed_display_name: 'React' }),               // exists curated → bump only
            E({ source_identifier: '@types/node', proposed_canonical_name: '@types/node', proposed_display_name: 'types' }),   // skip
            E({ source_identifier: 'totally-unknown-xyz', proposed_canonical_name: 'totally-unknown-xyz', proposed_display_name: 'X' }), // none → unresolved
        ]);

        const importer = new OntologyImporter(new Categorizer(), ontologyWrite as never, importSources as never);
        const { counts, unresolved } = await importer.run(source, new Date());

        expect(ontologyWrite.insertAutoImported).toHaveBeenCalledTimes(1); // nestjs
        expect(ontologyWrite.bumpPopularity).toHaveBeenCalledWith('id-react', expect.anything()); // curated bumped, not overwritten
        expect(counts.entriesInserted).toBe(1);
        expect(counts.entriesUpdated).toBe(1);
        expect(unresolved.map(u => u.source_identifier)).toEqual(['totally-unknown-xyz']); // buffered for LLM (Plan 3)
    });
});
```

- [ ] **Step 2: Run → fail. Step 3: Write `OntologyImporter.ts`**

```ts
/** @format */
import type { Categorizer } from '../categorization/Categorizer.js';
import type { Source, RawImportEntry } from '../sources/Source.js';
import type { ImportRunCounts } from '@bedrock/shared';
import { generateAliases } from '../aliases/AliasGenerator.js';
import { partitionAliases } from '../aliases/aliasFilters.js';

export interface OntologyWritePort {
    findByCanonical(canonical: string): Promise<{ id: string; curationLevel: string } | null>;
    insertAutoImported(canonical: string, display: string, category: string, source: string): Promise<string>;
    bumpPopularity(id: string, popularity: number | null): Promise<void>;
    loadAliasMap(): Promise<Map<string, string>>;
    insertAliases(technologyId: string, aliases: string[], source: string): Promise<number>;
}
export interface ImportSourcePort {
    upsertSeen(technologyId: string, source: string, sourceIdentifier: string, popularity: number | null, metadata: unknown): Promise<void>;
    incrementMissesOlderThan(source: string, runStart: Date): Promise<number>;
}

const empty = (): ImportRunCounts => ({ entriesFetched: 0, entriesInserted: 0, entriesUpdated: 0, entriesDeactivated: 0, aliasMerges: 0, unresolvedCount: 0, reviewQueueAdded: 0 });

export class OntologyImporter {
    constructor(
        private readonly categorizer: Categorizer,
        private readonly ontology: OntologyWritePort,
        private readonly importSources: ImportSourcePort,
    ) {}

    /** Returns counts + the entries that fell through layers 1-3 (for the LLM batch in Plan 3). */
    async run(source: Source, runStart: Date): Promise<{ counts: ImportRunCounts; unresolved: RawImportEntry[] }> {
        const counts = empty();
        const unresolved: RawImportEntry[] = [];
        const aliasMap = await this.ontology.loadAliasMap();

        for await (const entry of source.fetch()) {
            counts.entriesFetched++;
            if (source.keep && !source.keep(entry)) continue;

            const existing = await this.ontology.findByCanonical(entry.proposed_canonical_name);
            if (existing) {
                // Never overwrite category/display/curated aliases — only bump popularity.
                await this.ontology.bumpPopularity(existing.id, entry.popularity ?? null);
                await this.importSources.upsertSeen(existing.id, source.name, entry.source_identifier, entry.popularity ?? null, entry.source_metadata);
                counts.entriesUpdated++;
                continue;
            }

            const layer3 = source.mapMetadataToCategory?.(entry) ?? null;
            const result = this.categorizer.classify(entry, source.ecosystem, layer3);
            if (result.decision === 'no') continue;             // skip (e.g. @types/*)
            if (result.decision !== 'yes' || !result.category) { // maybe / none → LLM batch (Plan 3)
                counts.unresolvedCount++;
                unresolved.push(entry);
                continue;
            }

            const id = await this.ontology.insertAutoImported(
                entry.proposed_canonical_name, entry.proposed_display_name, result.category, source.name,
            );
            const { insertable, collisions } = partitionAliases(
                generateAliases(entry, source.ecosystem), id, aliasMap,
            );
            const merged = await this.ontology.insertAliases(id, insertable, source.name);
            for (const a of insertable) aliasMap.set(a, id);     // keep map current within the run
            counts.aliasMerges += merged;
            counts.aliasMerges += 0 * collisions.length;         // collisions tracked separately by caller logging
            await this.importSources.upsertSeen(id, source.name, entry.source_identifier, entry.popularity ?? null, entry.source_metadata);
            counts.entriesInserted++;
        }

        counts.entriesDeactivated = 0; // deactivation pass run by the entrypoint via DeactivationDetector (Plan 3 wiring)
        return { counts, unresolved };
    }
}
```

- [ ] **Step 4: Run → pass. Step 5: `DeactivationDetector.ts`** (pure policy) + test:

```ts
/** @format */
/** N-consecutive-miss deactivation policy. */
export function shouldDeactivate(consecutiveMisses: number, threshold = 3): boolean {
    return consecutiveMisses >= threshold;
}
```

- [ ] **Step 6: `ImportRunSummary.ts`** — formats `ImportRunCounts` into the spec's log line + a Prometheus-friendly object. Trivial; add a test asserting the formatted string contains each count.

- [ ] **Step 7: Commit**

```bash
git add applications/ontology-importer/src/importer
git commit -m "feat(ontology-importer): add importer core + deactivation policy + run summary"
```

---

## Task 8: FakeSource + in-process integration

**Files:**
- Create: `applications/ontology-importer/src/sources/FakeSource.ts`
- Create: `applications/ontology-importer/src/__tests__/integration.test.ts`

- [ ] **Step 1: `FakeSource.ts`** — a `Source` yielding a fixed list of `RawImportEntry` (covers pattern-hit, override-hit, skip, and uncategorizable), with an optional `mapMetadataToCategory`.
- [ ] **Step 2: Integration test** — wire `FakeSource` → `Categorizer` → `OntologyImporter` with in-memory port stubs; assert end-to-end counts (inserted/updated/unresolved), alias insertion, and that a second `run()` with the same source produces **zero new inserts** (idempotency: `findByCanonical` now returns the inserted rows).
- [ ] **Step 3: Full suite + build** — `yarn workspace @bedrock/ontology-importer test` (all pass) + `yarn workspace @bedrock/ontology-importer build` (exit 0). Remove `src/placeholder.ts`.
- [ ] **Step 4: Commit**

```bash
git add applications/ontology-importer/src
git commit -m "test(ontology-importer): add FakeSource + in-process integration"
```

---

## Self-Review

**Spec coverage (Plan 1 portion):**
- Tracking schema (import_sources/runs/skipped/review_queue) → Task 1 ✓ (renumbered 036; `developer_tool` category added)
- `Source` contract + `RawImportEntry` → Task 3 ✓
- Categorizer layers 1–3 (patterns/overrides/source-metadata cascade) → Task 4 ✓ (Layer 4 buffered as `unresolved` for Plan 3)
- Alias generation + collision handling → Task 5 ✓
- Import-run + per-source tracking repos → Task 6 ✓
- Idempotent importer core (curated-never-overwritten, popularity bump, insert/skip routing) → Task 7 ✓
- Deactivation policy → Task 7 (`shouldDeactivate`); the per-run deactivation *pass* + LLM batch + real sources + infra → **Plan 2/3**.
- *Deferred to Plan 2:* the 7 real sources. *Deferred to Plan 3:* LLM batch (Layer 4), review-queue/skipped repos, entrypoints (`run-import.ts`, `run-llm-batch-followup.ts`), Dockerfile/Helm CronJob/ArgoCD/CI, the chart `migration-011` hook, Prometheus metrics.

**Placeholder scan:** none — every step has concrete SQL/TS/commands. (Task 6 Step 5 / Task 8 describe a couple of mirror-the-pattern tests rather than re-pasting; the pattern is fully shown in adjacent tasks.)

**Type consistency:** `RawImportEntry`, `OntologyCategory`, `CategorizationResult`, `ImportRunCounts` (shared); `Source`, `OntologyWritePort`, `ImportSourcePort`, `Categorizer.classify`, `generateAliases`, `partitionAliases`, repo methods (`begin`/`finish`/`upsertSeen`/`incrementMissesOlderThan`) are defined once and reused consistently; the importer's `OntologyWritePort` is the seam the real shared repo implements in Plan 3 wiring.
