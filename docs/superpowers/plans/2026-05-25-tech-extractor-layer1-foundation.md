# Tech Extractor Layer 1 — Plan 1: Foundation (schema + shared persistence + resolver)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land migration 034 (the six technology-graph tables + triggers + minimal curated seed) and the reusable `@bedrock/shared` persistence + resolution layer that Plan 2's extraction app will build on.

**Architecture:** Reference data (`technology_ontology`, `technology_aliases`, `technology_relationships`) is global; evidence/candidate/parity tables are user-scoped with RLS. `OntologyResolver` is a pure in-memory alias→id map loaded once per Job. Repositories follow the existing constructor-`Pool` + `set_config('app.current_user_id', ...)` pattern.

**Tech Stack:** PostgreSQL (Aurora), TypeScript (CommonJS), pg, jest (`@jest/globals`), Yarn Berry workspaces.

**Spec:** `docs/superpowers/specs/2026-05-25-tech-extractor-layer1-design.md`

**Conventions locked from the codebase:**
- Enum-like columns use `TEXT ... CHECK (col IN (...))`, **not** `CREATE TYPE` (see `030_projects.sql`).
- `set_updated_at()` trigger via `CREATE OR REPLACE FUNCTION` (self-contained, idempotent).
- User-scoped tables enable RLS with `USING (user_id = current_setting('app.current_user_id', true)::uuid)`.
- Repos are unit-tested with a **fake pool** capturing `{ sql, params }` — no real DB in jest (see `RdsSyncStateRepository.test.ts`).
- All DDL idempotent: `CREATE TABLE/INDEX IF NOT EXISTS`, `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`.

---

## File Structure

- Create `applications/platform-rds-bootstrap/migrations/034_technology_graph.sql` — six tables, triggers, indexes, RLS, minimal seed.
- Create `applications/shared/src/rds/ontology/OntologyResolver.ts` — normalize + strict alias→id lookup.
- Create `applications/shared/src/rds/ontology/OntologyResolver.test.ts`.
- Create `applications/shared/src/rds/implementations/TechnologyOntologyRepository.ts` — load aliases, upsert ontology rows.
- Create `applications/shared/src/rds/implementations/TechnologyOntologyRepository.test.ts`.
- Create `applications/shared/src/rds/implementations/TechnologyEvidenceRepository.ts` — `insertMany` (ON CONFLICT), `hasEvidenceForCommit`.
- Create `applications/shared/src/rds/implementations/TechnologyEvidenceRepository.test.ts`.
- Create `applications/shared/src/rds/implementations/TechnologyCandidateRepository.ts` — `upsertCandidate` (increment).
- Create `applications/shared/src/rds/implementations/TechnologyCandidateRepository.test.ts`.
- Create `applications/shared/src/rds/implementations/TechnologyParityRunRepository.ts` — `insert`.
- Create `applications/shared/src/rds/implementations/TechnologyParityRunRepository.test.ts`.
- Create `applications/shared/src/rds/types/techgraph.ts` — shared interfaces/constants.
- Modify `applications/shared/src/rds/index.ts` — export the new types + classes.

---

## Task 1: Migration 034 — schema, triggers, RLS, seed

**Files:**
- Create: `applications/platform-rds-bootstrap/migrations/034_technology_graph.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 034_technology_graph.sql
--
-- Tech Extractor Layer 1 — deterministic technology extraction.
-- Six tables: three global reference (ontology/aliases/relationships),
-- three user-scoped (evidence/candidates/parity) + a single-row
-- ontology_version counter.
--
-- Expand-only, idempotent (ROLLBACK.md §Expand/Contract). Enum-like columns
-- use TEXT + CHECK to match the repo convention (no CREATE TYPE).

BEGIN;

-- set_updated_at() may already exist from an earlier migration; OR REPLACE
-- keeps this file self-contained.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Global reference data ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS technology_ontology (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_name   TEXT NOT NULL UNIQUE,
    display_name     TEXT NOT NULL,
    category         TEXT NOT NULL CHECK (category IN (
        'language','framework_web','framework_mobile','framework_ml','runtime',
        'database_relational','database_nosql','database_vector','database_search',
        'database_kv','message_broker','observability','cloud_compute','cloud_storage',
        'cloud_database','cloud_serverless','cloud_networking','cloud_security','iac',
        'ci_cd','container_runtime','orchestration','api_protocol','testing',
        'build_tool','package_manager','auth','payment','ai_platform')),
    curation_level   TEXT NOT NULL DEFAULT 'curated'
        CHECK (curation_level IN ('curated','auto_imported','candidate')),
    source           TEXT,
    popularity_score INT  NOT NULL DEFAULT 0,
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    notes            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS set_updated_at ON technology_ontology;
CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON technology_ontology
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS technology_aliases (
    alias         TEXT PRIMARY KEY,                       -- lowercased; one alias -> one tech
    technology_id UUID NOT NULL REFERENCES technology_ontology(id) ON DELETE CASCADE,
    source        TEXT
);
CREATE INDEX IF NOT EXISTS idx_technology_aliases_tech ON technology_aliases (technology_id);

CREATE TABLE IF NOT EXISTS technology_relationships (
    from_id UUID NOT NULL REFERENCES technology_ontology(id) ON DELETE CASCADE,
    to_id   UUID NOT NULL REFERENCES technology_ontology(id) ON DELETE CASCADE,
    kind    TEXT NOT NULL CHECK (kind IN
        ('runs_on','implements','part_of','succeeds','related_to')),
    PRIMARY KEY (from_id, to_id, kind)
);

-- ── Ontology version counter + bump trigger ──────────────────────────────
CREATE TABLE IF NOT EXISTS ontology_version (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    version   INT NOT NULL DEFAULT 1
);
INSERT INTO ontology_version (singleton, version)
    VALUES (TRUE, 1) ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION bump_ontology_version()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE ontology_version SET version = version + 1 WHERE singleton = TRUE;
    RETURN NULL;  -- AFTER STATEMENT trigger
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bump_version_on_ontology ON technology_ontology;
CREATE TRIGGER bump_version_on_ontology
    AFTER INSERT OR UPDATE OR DELETE ON technology_ontology
    FOR EACH STATEMENT EXECUTE FUNCTION bump_ontology_version();

DROP TRIGGER IF EXISTS bump_version_on_aliases ON technology_aliases;
CREATE TRIGGER bump_version_on_aliases
    AFTER INSERT OR UPDATE OR DELETE ON technology_aliases
    FOR EACH STATEMENT EXECUTE FUNCTION bump_ontology_version();

-- ── User-scoped: evidence ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS technology_evidence (
    id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repo_full_name                TEXT NOT NULL,
    commit_sha                    TEXT NOT NULL,
    technology_id                 UUID REFERENCES technology_ontology(id),   -- NULL = unmatched
    raw_name                      TEXT NOT NULL,
    ecosystem                     TEXT,
    source_layer                  TEXT NOT NULL CHECK (source_layer IN
        ('syft','treesitter','iac','dockerfile','readme')),
    file_path                     TEXT NOT NULL,
    line_start                    INT,
    line_end                      INT,
    confidence                    REAL,
    extracted_at_ontology_version INT NOT NULL,
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Portable dedup index (avoids PG15-only NULLS NOT DISTINCT). COALESCE both
-- nullable members so unmatched (technology_id NULL) and position-less
-- (line_start NULL) rows still dedup on retry.
CREATE UNIQUE INDEX IF NOT EXISTS uq_technology_evidence
    ON technology_evidence (
        user_id, repo_full_name,
        COALESCE(technology_id::text, raw_name),
        file_path,
        COALESCE(line_start, -1)
    );
CREATE INDEX IF NOT EXISTS idx_technology_evidence_repo_commit
    ON technology_evidence (user_id, repo_full_name, commit_sha);

ALTER TABLE technology_evidence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_technology_evidence ON technology_evidence;
CREATE POLICY rls_technology_evidence ON technology_evidence
    USING (user_id = current_setting('app.current_user_id', true)::uuid);

-- ── User-scoped: candidates ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS technology_candidates (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    raw_name            TEXT NOT NULL,
    normalized_name     TEXT NOT NULL,
    ecosystem           TEXT NOT NULL DEFAULT 'unknown',
    first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    occurrence_count    INT NOT NULL DEFAULT 0,
    user_count          INT NOT NULL DEFAULT 0,
    example_repos       JSONB NOT NULL DEFAULT '[]',
    suggested_canonical UUID REFERENCES technology_ontology(id),
    suggested_category  TEXT,
    resolved_at         TIMESTAMPTZ,
    resolution          TEXT CHECK (resolution IN
        ('promoted','aliased','ignored','duplicate')),
    UNIQUE (normalized_name, ecosystem)
);
CREATE INDEX IF NOT EXISTS idx_technology_candidates_unresolved
    ON technology_candidates (resolution) WHERE resolved_at IS NULL;

-- ── User-scoped: parity runs ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS technology_parity_runs (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repo_full_name         TEXT NOT NULL,
    commit_sha             TEXT NOT NULL,
    ontology_version       INT NOT NULL,
    l1_canonical_count     INT NOT NULL,
    llm_canonical_count    INT NOT NULL,
    llm_unresolvable_count INT NOT NULL,
    intersection_count     INT NOT NULL,
    recall                 REAL NOT NULL,
    l1_only_examples       JSONB NOT NULL DEFAULT '[]',
    llm_only_examples      JSONB NOT NULL DEFAULT '[]',
    ran_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_technology_parity_runs_repo
    ON technology_parity_runs (user_id, repo_full_name, ran_at DESC);

ALTER TABLE technology_parity_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_technology_parity_runs ON technology_parity_runs;
CREATE POLICY rls_technology_parity_runs ON technology_parity_runs
    USING (user_id = current_setting('app.current_user_id', true)::uuid);

-- ── Minimal curated seed (~Phase 1 baseline; grows by data-track PRs) ─────
-- canonical_name is the slug form; display_name the human form.
INSERT INTO technology_ontology (canonical_name, display_name, category, curation_level, source)
VALUES
    ('typescript','TypeScript','language','curated','seed'),
    ('javascript','JavaScript','language','curated','seed'),
    ('python','Python','language','curated','seed'),
    ('go','Go','language','curated','seed'),
    ('rust','Rust','language','curated','seed'),
    ('java','Java','language','curated','seed'),
    ('react','React','framework_web','curated','seed'),
    ('nextjs','Next.js','framework_web','curated','seed'),
    ('nodejs','Node.js','runtime','curated','seed'),
    ('postgresql','PostgreSQL','database_relational','curated','seed'),
    ('redis','Redis','database_kv','curated','seed'),
    ('pgvector','pgvector','database_vector','curated','seed'),
    ('docker','Docker','container_runtime','curated','seed'),
    ('kubernetes','Kubernetes','orchestration','curated','seed'),
    ('helm','Helm','iac','curated','seed'),
    ('terraform','Terraform','iac','curated','seed'),
    ('aws_cdk','AWS CDK','iac','curated','seed'),
    ('aws_lambda','AWS Lambda','cloud_serverless','curated','seed'),
    ('aws_s3','Amazon S3','cloud_storage','curated','seed'),
    ('aws_rds','Amazon RDS','cloud_database','curated','seed'),
    ('aws_bedrock','Amazon Bedrock','ai_platform','curated','seed'),
    ('github_actions','GitHub Actions','ci_cd','curated','seed'),
    ('jest','Jest','testing','curated','seed'),
    ('prometheus','Prometheus','observability','curated','seed'),
    ('grafana','Grafana','observability','curated','seed')
ON CONFLICT (canonical_name) DO NOTHING;

-- Aliases (lowercased). One alias -> one technology.
INSERT INTO technology_aliases (alias, technology_id, source)
SELECT a.alias, o.id, 'seed'
FROM (VALUES
    ('typescript','typescript'), ('ts','typescript'),
    ('javascript','javascript'), ('js','javascript'),
    ('python','python'), ('py','python'),
    ('go','go'), ('golang','go'),
    ('rust','rust'),
    ('java','java'),
    ('react','react'), ('react.js','react'), ('reactjs','react'),
    ('next.js','nextjs'), ('nextjs','nextjs'), ('next','nextjs'),
    ('node.js','nodejs'), ('node','nodejs'), ('nodejs','nodejs'),
    ('postgresql','postgresql'), ('postgres','postgresql'), ('pg','postgresql'),
    ('redis','redis'),
    ('pgvector','pgvector'),
    ('docker','docker'),
    ('kubernetes','kubernetes'), ('k8s','kubernetes'),
    ('helm','helm'),
    ('terraform','terraform'), ('tf','terraform'),
    ('aws-cdk','aws_cdk'), ('aws_cdk','aws_cdk'), ('cdk','aws_cdk'), ('aws-cdk-lib','aws_cdk'),
    ('aws-lambda','aws_lambda'), ('lambda','aws_lambda'),
    ('s3','aws_s3'), ('aws-s3','aws_s3'),
    ('rds','aws_rds'),
    ('bedrock','aws_bedrock'), ('amazon-bedrock','aws_bedrock'),
    ('github-actions','github_actions'), ('gha','github_actions'),
    ('jest','jest'),
    ('prometheus','prometheus'), ('prom-client','prometheus'),
    ('grafana','grafana')
) AS a(alias, canon)
JOIN technology_ontology o ON o.canonical_name = a.canon
ON CONFLICT (alias) DO NOTHING;

COMMIT;
```

- [ ] **Step 2: Verify the migration applies idempotently**

Run against a throwaway Postgres (the table needs `users` + `gen_random_uuid`; create a stub `users` if testing in isolation):

```bash
docker run --rm -d --name pg-mig -e POSTGRES_PASSWORD=pw -p 5599:5432 postgres:16
sleep 4
psql "postgresql://postgres:pw@localhost:5599/postgres" -v ON_ERROR_STOP=1 -c \
  "CREATE TABLE users (id uuid primary key default gen_random_uuid());"
# apply twice — second run must be a clean no-op
psql "postgresql://postgres:pw@localhost:5599/postgres" -v ON_ERROR_STOP=1 \
  -f applications/platform-rds-bootstrap/migrations/034_technology_graph.sql
psql "postgresql://postgres:pw@localhost:5599/postgres" -v ON_ERROR_STOP=1 \
  -f applications/platform-rds-bootstrap/migrations/034_technology_graph.sql
```

Expected: both applies exit 0 (idempotent).

- [ ] **Step 3: Verify seed + version counter**

```bash
psql "postgresql://postgres:pw@localhost:5599/postgres" -c \
  "SELECT count(*) FROM technology_ontology;"          # expect 25
psql "postgresql://postgres:pw@localhost:5599/postgres" -c \
  "SELECT count(*) FROM technology_aliases;"           # expect 40+
psql "postgresql://postgres:pw@localhost:5599/postgres" -c \
  "SELECT version FROM ontology_version;"              # expect > 1 (seed inserts bumped it)
docker rm -f pg-mig
```

Expected: counts match; `version > 1` proves the bump trigger fired on seed inserts.

- [ ] **Step 4: Commit**

```bash
git add applications/platform-rds-bootstrap/migrations/034_technology_graph.sql
git commit -m "feat(rds): add migration 034 technology-graph schema + seed"
```

---

## Task 2: Shared types for the technology graph

**Files:**
- Create: `applications/shared/src/rds/types/techgraph.ts`

- [ ] **Step 1: Write the types**

```ts
/** @format */

export type SourceLayer = 'syft' | 'treesitter' | 'iac' | 'dockerfile' | 'readme';

export const CONFIDENCE_BY_LAYER: Record<SourceLayer, number> = {
    syft:       0.95,
    treesitter: 0.85,
    iac:        0.85,
    dockerfile: 0.80,
    readme:     0.50,
};

/** One extracted occurrence before ontology resolution. */
export interface RawTechnologyEvidence {
    raw_name:     string;
    ecosystem?:   string;
    source_layer: SourceLayer;
    file_path:    string;
    line_start?:  number;
    line_end?:    number;
}

/** A resolved (or unresolved) evidence row ready to persist. */
export interface TechnologyEvidenceRow {
    userId:        string;
    repoFullName:  string;
    commitSha:     string;
    technologyId:  string | null;
    rawName:       string;
    ecosystem:     string | null;
    sourceLayer:   SourceLayer;
    filePath:      string;
    lineStart:     number | null;
    lineEnd:       number | null;
    confidence:    number;
    ontologyVersion: number;
}

export interface OntologyRow {
    canonicalName: string;
    displayName:   string;
    category:      string;
}

export interface ParityRunRow {
    userId:               string;
    repoFullName:         string;
    commitSha:            string;
    ontologyVersion:      number;
    l1CanonicalCount:     number;
    llmCanonicalCount:    number;
    llmUnresolvableCount: number;
    intersectionCount:    number;
    recall:               number;
    l1OnlyExamples:       string[];
    llmOnlyExamples:      string[];
}
```

- [ ] **Step 2: Commit**

```bash
git add applications/shared/src/rds/types/techgraph.ts
git commit -m "feat(rds): add technology-graph shared types"
```

---

## Task 3: OntologyResolver (strict normalize + alias→id)

**Files:**
- Create: `applications/shared/src/rds/ontology/OntologyResolver.ts`
- Test: `applications/shared/src/rds/ontology/OntologyResolver.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
/** @format */
import { describe, it, expect } from '@jest/globals';
import { OntologyResolver, normalizeAlias } from './OntologyResolver.js';

describe('normalizeAlias', () => {
    it('lowercases and trims', () => {
        expect(normalizeAlias('  React.JS ')).toBe('react.js');
    });
});

describe('OntologyResolver', () => {
    const resolver = new OntologyResolver(new Map([
        ['k8s', 'tech-kube'],
        ['kubernetes', 'tech-kube'],
        ['react', 'tech-react'],
    ]));

    it('resolves a known alias to its technology id', () => {
        expect(resolver.resolve('Kubernetes')).toBe('tech-kube');
        expect(resolver.resolve('K8s')).toBe('tech-kube');
    });

    it('returns null for an unknown token (strict — no fuzzy)', () => {
        expect(resolver.resolve('reach')).toBeNull();
        expect(resolver.resolve('kubernetex')).toBeNull();
    });

    it('normalizes input before lookup', () => {
        expect(resolver.resolve('  REACT ')).toBe('tech-react');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @bedrock/shared jest src/rds/ontology/OntologyResolver.test.ts`
Expected: FAIL — `Cannot find module './OntologyResolver.js'`.

- [ ] **Step 3: Write the implementation**

```ts
/** @format */

/** Strict normalization for alias lookup: lowercase + trim only. */
export function normalizeAlias(raw: string): string {
    return raw.toLowerCase().trim();
}

/**
 * In-memory strict resolver. Built from the alias table once per Job.
 * No fuzzy matching — near-misses are the candidate loop's job (spec §Resolved
 * decisions #1).
 */
export class OntologyResolver {
    constructor(private readonly aliasToId: Map<string, string>) {}

    /** @returns technology id, or null when the token is unknown. */
    resolve(rawName: string): string | null {
        return this.aliasToId.get(normalizeAlias(rawName)) ?? null;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace @bedrock/shared jest src/rds/ontology/OntologyResolver.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/rds/ontology/OntologyResolver.ts applications/shared/src/rds/ontology/OntologyResolver.test.ts
git commit -m "feat(rds): add OntologyResolver strict alias lookup"
```

---

## Task 4: TechnologyOntologyRepository (load aliases)

**Files:**
- Create: `applications/shared/src/rds/implementations/TechnologyOntologyRepository.ts`
- Test: `applications/shared/src/rds/implementations/TechnologyOntologyRepository.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { TechnologyOntologyRepository } from './TechnologyOntologyRepository.js';

function fakePool(rows: unknown[] = []) {
    const calls: { sql: string; params?: unknown[] }[] = [];
    return {
        calls,
        query: jest.fn(async (sql: string, params?: unknown[]) => {
            calls.push({ sql, params });
            return { rows };
        }),
    };
}

describe('TechnologyOntologyRepository.loadAliasMap', () => {
    it('builds a Map from alias rows and reads the ontology version', async () => {
        const pool = fakePool([
            { alias: 'k8s', technology_id: 'id-kube' },
            { alias: 'react', technology_id: 'id-react' },
        ]);
        const repo = new TechnologyOntologyRepository(pool as never);
        const map = await repo.loadAliasMap();
        expect(map.get('k8s')).toBe('id-kube');
        expect(map.get('react')).toBe('id-react');
        expect(pool.calls[0].sql).toContain('FROM technology_aliases');
    });
});

describe('TechnologyOntologyRepository.currentVersion', () => {
    it('returns the single-row version', async () => {
        const pool = fakePool([{ version: 7 }]);
        const repo = new TechnologyOntologyRepository(pool as never);
        expect(await repo.currentVersion()).toBe(7);
        expect(pool.calls[0].sql).toContain('FROM ontology_version');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @bedrock/shared jest src/rds/implementations/TechnologyOntologyRepository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
/** @format */
import type { Pool } from 'pg';

/**
 * Reads the global technology ontology + aliases. Reference data is not
 * user-scoped, so no RLS / set_config needed.
 */
export class TechnologyOntologyRepository {
    constructor(private readonly pool: Pool) {}

    /** Load the full alias -> technology_id map (one query per Job). */
    async loadAliasMap(): Promise<Map<string, string>> {
        const { rows } = await this.pool.query<{ alias: string; technology_id: string }>(
            `SELECT alias, technology_id FROM technology_aliases`,
        );
        const map = new Map<string, string>();
        for (const r of rows) map.set(r.alias, r.technology_id);
        return map;
    }

    /** Current ontology version (for tagging evidence rows). */
    async currentVersion(): Promise<number> {
        const { rows } = await this.pool.query<{ version: number }>(
            `SELECT version FROM ontology_version WHERE singleton = TRUE`,
        );
        return rows[0]?.version ?? 1;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace @bedrock/shared jest src/rds/implementations/TechnologyOntologyRepository.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/rds/implementations/TechnologyOntologyRepository.ts applications/shared/src/rds/implementations/TechnologyOntologyRepository.test.ts
git commit -m "feat(rds): add TechnologyOntologyRepository"
```

---

## Task 5: TechnologyEvidenceRepository (insert + short-circuit check)

**Files:**
- Create: `applications/shared/src/rds/implementations/TechnologyEvidenceRepository.ts`
- Test: `applications/shared/src/rds/implementations/TechnologyEvidenceRepository.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { TechnologyEvidenceRepository } from './TechnologyEvidenceRepository.js';
import type { TechnologyEvidenceRow } from '../types/techgraph.js';

function fakeClient(rows: unknown[] = []) {
    const calls: { sql: string; params?: unknown[] }[] = [];
    return {
        calls,
        query: jest.fn(async (sql: string, params?: unknown[]) => {
            calls.push({ sql, params });
            return { rows };
        }),
        release: jest.fn(),
    };
}
function fakePool(client: ReturnType<typeof fakeClient>) {
    return { connect: jest.fn(async () => client) };
}

const row: TechnologyEvidenceRow = {
    userId: 'u1', repoFullName: 'o/r', commitSha: 'abc', technologyId: 'id-kube',
    rawName: 'k8s', ecosystem: 'iac', sourceLayer: 'iac',
    filePath: 'deploy.yaml', lineStart: 3, lineEnd: 3, confidence: 0.85, ontologyVersion: 5,
};

describe('TechnologyEvidenceRepository.insertMany', () => {
    it('sets the RLS user and inserts with ON CONFLICT DO NOTHING', async () => {
        const client = fakeClient();
        const repo = new TechnologyEvidenceRepository(fakePool(client) as never);
        await repo.insertMany('u1', [row]);
        const sqls = client.calls.map(c => c.sql).join('\n');
        expect(sqls).toContain("set_config('app.current_user_id'");
        const insert = client.calls.find(c => c.sql.includes('INSERT INTO technology_evidence'))!;
        expect(insert.sql).toContain('ON CONFLICT');
        expect(insert.sql).toContain('DO NOTHING');
        expect(client.release).toHaveBeenCalled();
    });

    it('no-ops on an empty batch', async () => {
        const client = fakeClient();
        const repo = new TechnologyEvidenceRepository(fakePool(client) as never);
        await repo.insertMany('u1', []);
        expect(client.calls.find(c => c.sql.includes('INSERT INTO technology_evidence'))).toBeUndefined();
    });
});

describe('TechnologyEvidenceRepository.hasEvidenceForCommit', () => {
    it('returns true when a row exists for (user, repo, sha)', async () => {
        const client = fakeClient([{ one: 1 }]);
        const repo = new TechnologyEvidenceRepository(fakePool(client) as never);
        expect(await repo.hasEvidenceForCommit('u1', 'o/r', 'abc')).toBe(true);
    });
    it('returns false when no row exists', async () => {
        const client = fakeClient([]);
        const repo = new TechnologyEvidenceRepository(fakePool(client) as never);
        expect(await repo.hasEvidenceForCommit('u1', 'o/r', 'zzz')).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @bedrock/shared jest src/rds/implementations/TechnologyEvidenceRepository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
/** @format */
import type { Pool } from 'pg';
import type { TechnologyEvidenceRow } from '../types/techgraph.js';

export class TechnologyEvidenceRepository {
    constructor(private readonly pool: Pool) {}

    /** Commit-SHA short-circuit: has this exact commit already been extracted? */
    async hasEvidenceForCommit(userId: string, repoFullName: string, commitSha: string): Promise<boolean> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
            const { rows } = await client.query(
                `SELECT 1 FROM technology_evidence
                 WHERE user_id = $1::uuid AND repo_full_name = $2 AND commit_sha = $3
                 LIMIT 1`,
                [userId, repoFullName, commitSha],
            );
            await client.query('COMMIT');
            return rows.length > 0;
        } finally {
            client.release();
        }
    }

    /** Insert a batch; duplicates (per uq_technology_evidence) are skipped. */
    async insertMany(userId: string, rows: TechnologyEvidenceRow[]): Promise<void> {
        if (rows.length === 0) return;
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
            for (const r of rows) {
                await client.query(
                    `INSERT INTO technology_evidence (
                        user_id, repo_full_name, commit_sha, technology_id, raw_name,
                        ecosystem, source_layer, file_path, line_start, line_end,
                        confidence, extracted_at_ontology_version
                    ) VALUES (
                        $1::uuid, $2, $3, $4::uuid, $5,
                        $6, $7, $8, $9, $10,
                        $11, $12
                    )
                    ON CONFLICT (
                        user_id, repo_full_name,
                        COALESCE(technology_id::text, raw_name),
                        file_path, COALESCE(line_start, -1)
                    ) DO NOTHING`,
                    [
                        userId, r.repoFullName, r.commitSha, r.technologyId, r.rawName,
                        r.ecosystem, r.sourceLayer, r.filePath, r.lineStart, r.lineEnd,
                        r.confidence, r.ontologyVersion,
                    ],
                );
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }
}
```

> Note: `ON CONFLICT` against an expression index is matched by repeating the exact index expression list, as written above.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace @bedrock/shared jest src/rds/implementations/TechnologyEvidenceRepository.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/rds/implementations/TechnologyEvidenceRepository.ts applications/shared/src/rds/implementations/TechnologyEvidenceRepository.test.ts
git commit -m "feat(rds): add TechnologyEvidenceRepository"
```

---

## Task 6: TechnologyCandidateRepository (upsert increment)

**Files:**
- Create: `applications/shared/src/rds/implementations/TechnologyCandidateRepository.ts`
- Test: `applications/shared/src/rds/implementations/TechnologyCandidateRepository.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { TechnologyCandidateRepository } from './TechnologyCandidateRepository.js';

function fakePool() {
    const calls: { sql: string; params?: unknown[] }[] = [];
    return {
        calls,
        query: jest.fn(async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return { rows: [] }; }),
    };
}

describe('TechnologyCandidateRepository.upsert', () => {
    it('upserts with occurrence increment on conflict', async () => {
        const pool = fakePool();
        const repo = new TechnologyCandidateRepository(pool as never);
        await repo.upsert({
            rawName: 'K8s-Operator', normalizedName: 'k8soperator', ecosystem: 'iac',
            userId: 'u1', repoFullName: 'o/r', filePath: 'main.tf',
        });
        const c = pool.calls[0];
        expect(c.sql).toContain('INSERT INTO technology_candidates');
        expect(c.sql).toContain('ON CONFLICT (normalized_name, ecosystem)');
        expect(c.sql).toContain('occurrence_count = technology_candidates.occurrence_count + 1');
        expect(c.params).toContain('k8soperator');
    });

    it("defaults ecosystem to 'unknown' when not provided", async () => {
        const pool = fakePool();
        const repo = new TechnologyCandidateRepository(pool as never);
        await repo.upsert({
            rawName: 'mystery', normalizedName: 'mystery',
            userId: 'u1', repoFullName: 'o/r', filePath: 'README.md',
        });
        expect(pool.calls[0].params).toContain('unknown');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @bedrock/shared jest src/rds/implementations/TechnologyCandidateRepository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
/** @format */
import type { Pool } from 'pg';

export interface CandidateUpsertInput {
    rawName:        string;
    normalizedName: string;
    ecosystem?:     string;
    userId:         string;
    repoFullName:   string;
    filePath:       string;
}

export class TechnologyCandidateRepository {
    constructor(private readonly pool: Pool) {}

    /**
     * Record an unmatched token. On repeat (same normalized_name + ecosystem)
     * increment occurrence_count and append the example repo (capped client-side
     * by the JSONB array; trimming is a data-track concern, not Phase 1).
     */
    async upsert(input: CandidateUpsertInput): Promise<void> {
        const ecosystem = input.ecosystem ?? 'unknown';
        const example = JSON.stringify([{ user_id: input.userId, repo: input.repoFullName, file_path: input.filePath }]);
        await this.pool.query(
            `INSERT INTO technology_candidates (
                raw_name, normalized_name, ecosystem,
                occurrence_count, user_count, example_repos
             ) VALUES ($1, $2, $3, 1, 1, $4::jsonb)
             ON CONFLICT (normalized_name, ecosystem) DO UPDATE SET
                occurrence_count = technology_candidates.occurrence_count + 1,
                example_repos    = technology_candidates.example_repos || EXCLUDED.example_repos`,
            [input.rawName, input.normalizedName, ecosystem, example],
        );
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace @bedrock/shared jest src/rds/implementations/TechnologyCandidateRepository.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/rds/implementations/TechnologyCandidateRepository.ts applications/shared/src/rds/implementations/TechnologyCandidateRepository.test.ts
git commit -m "feat(rds): add TechnologyCandidateRepository"
```

---

## Task 7: TechnologyParityRunRepository (insert)

**Files:**
- Create: `applications/shared/src/rds/implementations/TechnologyParityRunRepository.ts`
- Test: `applications/shared/src/rds/implementations/TechnologyParityRunRepository.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { TechnologyParityRunRepository } from './TechnologyParityRunRepository.js';
import type { ParityRunRow } from '../types/techgraph.js';

function fakeClient() {
    const calls: { sql: string; params?: unknown[] }[] = [];
    return {
        calls,
        query: jest.fn(async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return { rows: [] }; }),
        release: jest.fn(),
    };
}
function fakePool(client: ReturnType<typeof fakeClient>) {
    return { connect: jest.fn(async () => client) };
}

const run: ParityRunRow = {
    userId: 'u1', repoFullName: 'o/r', commitSha: 'abc', ontologyVersion: 5,
    l1CanonicalCount: 10, llmCanonicalCount: 9, llmUnresolvableCount: 2,
    intersectionCount: 8, recall: 0.888,
    l1OnlyExamples: ['pgvector', 'helm'], llmOnlyExamples: ['kafka'],
};

describe('TechnologyParityRunRepository.insert', () => {
    it('sets RLS user and inserts the parity run with jsonb examples', async () => {
        const client = fakeClient();
        const repo = new TechnologyParityRunRepository(fakePool(client) as never);
        await repo.insert(run);
        const sqls = client.calls.map(c => c.sql).join('\n');
        expect(sqls).toContain("set_config('app.current_user_id'");
        const insert = client.calls.find(c => c.sql.includes('INSERT INTO technology_parity_runs'))!;
        expect(insert.sql).toContain('llm_only_examples');
        expect(insert.params!.some(p => typeof p === 'string' && p.includes('kafka'))).toBe(true);
        expect(insert.params).toContain(0.888);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @bedrock/shared jest src/rds/implementations/TechnologyParityRunRepository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
/** @format */
import type { Pool } from 'pg';
import type { ParityRunRow } from '../types/techgraph.js';

export class TechnologyParityRunRepository {
    constructor(private readonly pool: Pool) {}

    async insert(run: ParityRunRow): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [run.userId]);
            await client.query(
                `INSERT INTO technology_parity_runs (
                    user_id, repo_full_name, commit_sha, ontology_version,
                    l1_canonical_count, llm_canonical_count, llm_unresolvable_count,
                    intersection_count, recall, l1_only_examples, llm_only_examples
                 ) VALUES (
                    $1::uuid, $2, $3, $4,
                    $5, $6, $7,
                    $8, $9, $10::jsonb, $11::jsonb
                 )`,
                [
                    run.userId, run.repoFullName, run.commitSha, run.ontologyVersion,
                    run.l1CanonicalCount, run.llmCanonicalCount, run.llmUnresolvableCount,
                    run.intersectionCount, run.recall,
                    JSON.stringify(run.l1OnlyExamples), JSON.stringify(run.llmOnlyExamples),
                ],
            );
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace @bedrock/shared jest src/rds/implementations/TechnologyParityRunRepository.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/rds/implementations/TechnologyParityRunRepository.ts applications/shared/src/rds/implementations/TechnologyParityRunRepository.test.ts
git commit -m "feat(rds): add TechnologyParityRunRepository"
```

---

## Task 8: Barrel exports

**Files:**
- Modify: `applications/shared/src/rds/index.ts`

- [ ] **Step 1: Add exports**

Append to `applications/shared/src/rds/index.ts` (match the existing `export { ... } from './implementations/...js'` style):

```ts
// Technology graph (Layer 1)
export { OntologyResolver, normalizeAlias } from './ontology/OntologyResolver.js';
export { TechnologyOntologyRepository }     from './implementations/TechnologyOntologyRepository.js';
export { TechnologyEvidenceRepository }     from './implementations/TechnologyEvidenceRepository.js';
export { TechnologyCandidateRepository }    from './implementations/TechnologyCandidateRepository.js';
export { TechnologyParityRunRepository }    from './implementations/TechnologyParityRunRepository.js';
export type {
    SourceLayer, RawTechnologyEvidence, TechnologyEvidenceRow,
    OntologyRow, ParityRunRow,
} from './types/techgraph.js';
export { CONFIDENCE_BY_LAYER } from './types/techgraph.js';
export type { CandidateUpsertInput } from './implementations/TechnologyCandidateRepository.js';
```

- [ ] **Step 2: Build shared to verify exports resolve**

Run: `yarn workspace @bedrock/shared build`
Expected: tsc completes; `dist/index.d.ts` includes the new symbols.

- [ ] **Step 3: Run the full shared test suite**

Run: `yarn workspace @bedrock/shared test`
Expected: all tests pass (existing + the 13 new tests from Tasks 3–7).

- [ ] **Step 4: Commit**

```bash
git add applications/shared/src/rds/index.ts applications/shared/src/index.ts
git commit -m "feat(rds): export technology-graph layer from @bedrock/shared"
```

> If `applications/shared/src/index.ts` re-exports from `./rds/index.js` via an explicit symbol list (it does — see the `BedrockChunkEnricher` entry), add the same new symbols there too; that's why it's staged in Step 4.

---

## Self-Review

**Spec coverage (Plan 1 portion):**
- Six tables incl. `technology_parity_runs` → Task 1 ✓
- Expression unique index covering NULL technology_id + line_start (issue #1) → Task 1 ✓
- `ontology_version` bump trigger on ontology + aliases (issue #3) → Task 1 ✓
- Minimal curated seed → Task 1 ✓
- RLS on user-scoped tables → Task 1 ✓
- Resolver strict, no ecosystem arg (issues #2, decision #1) → Task 3 ✓
- Per-source-layer confidence constants in code (decision #2) → Task 2 ✓
- Evidence `ON CONFLICT DO NOTHING` + commit-SHA short-circuit (issues #1, #9) → Task 5 ✓
- Candidate ecosystem default `'unknown'` → Task 1 + Task 6 ✓
- Parity run persistence (open-q #3) → Task 7 ✓
- *Deferred to Plan 2:* extractors, tarball, orchestrator, ParityReporter compute logic, the Job. *Deferred to Plan 3:* Dockerfile/Helm/ArgoCD/trigger. *Deferred to data-track:* ontology backfill, full curation.

**Placeholder scan:** none — every step has concrete SQL/TS/commands.

**Type consistency:** `RawTechnologyEvidence`, `TechnologyEvidenceRow`, `ParityRunRow`, `SourceLayer`, `CONFIDENCE_BY_LAYER`, `normalizeAlias`, `OntologyResolver.resolve`, repo method names (`loadAliasMap`, `currentVersion`, `hasEvidenceForCommit`, `insertMany`, `upsert`, `insert`) are defined once and reused consistently across tasks and the Plan 2 hand-off.
