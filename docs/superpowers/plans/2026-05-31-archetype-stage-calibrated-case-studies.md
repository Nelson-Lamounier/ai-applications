# Archetype/Stage-Calibrated Case Studies — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Calibrate case-study generation per project archetype × career stage by seeding the `@tucaken/ontology` catalog into ai-applications' DB, classifying each project deterministically, deriving stage from existing seniority, and injecting soft section-priority guidance into the case-study prompt.

**Architecture:** Migration seeds 9 archetypes + 36 stage overlays into two GLOBAL tables (no RLS, like `technology_ontology`) + adds 3 computed columns to `projects`. In `loadCaseStudyContext`, a pure deterministic classifier picks an archetype, stage is derived from `user_profile_rollup.direction.seniority`, the overlay is looked up, computed values are persisted, and archetype/stage/prioritySections are attached to `CaseStudyContext`. The agent appends a soft guidance block to the system prompt ONLY when an archetype is present. Output schema, evidence-gating, and the grounding verifier are untouched — additive + degradable.

**Tech Stack:** TypeScript (Node 22, ESM), `pg`, Jest (`@jest/globals`, `.js` import suffix), Postgres + pgvector, Zod, Bedrock tool-use.

**Spec:** `docs/superpowers/specs/2026-05-31-archetype-stage-calibrated-case-studies-design.md`
**Branch:** `feat/archetype-stage-calibration` off `origin/develop`.
**Ontology source (verbatim transcription source):** `/Users/nelsonlamounier/Desktop/portfolio/tucaken-skill/packages/ontology/data/` — `archetypes/*.yaml` (9 files), `stages/*.yaml` (36 files), `version.yaml` (version 0.1.0, released 2026-05-27).

---

## File Structure

- **Create** `applications/platform-rds-bootstrap/migrations/046_project_ontology.sql` — 2 global tables + seed (9+36 rows) + 3 `projects` columns.
- **Create** `applications/shared/src/projects/archetype-types.ts` — shared TS types (`ArchetypeDef`, `StageOverlay`, `StageId`, `ClassifyInput`).
- **Create** `applications/shared/src/rds/implementations/RdsProjectOntologyRepository.ts` (+ test) — DB reads of the global tables.
- **Create** `applications/shared/src/projects/archetype-classifier.ts` (+ test) — pure deterministic classifier.
- **Create** `applications/shared/src/projects/derive-stage.ts` (+ test) — seniority → stage mapping.
- **Modify** `applications/shared/src/projects/case-study-types.ts` — add optional calibration fields to `CaseStudyContext`.
- **Modify** `applications/shared/src/projects/case-study-loader.ts` — classify + derive + lookup + persist + attach.
- **Modify** `applications/shared/src/projects/case-study-agent.ts` — append guidance block when archetype present.
- **Modify** `applications/shared/src/projects/case-study-orchestrator.ts` — `computeInputHash` includes archetype/stage.

---

## Task 1: Migration 046 — ontology tables + seed + projects columns

**Files:**
- Create: `applications/platform-rds-bootstrap/migrations/046_project_ontology.sql`

- [ ] **Step 1: Write the table + columns DDL (top of file)**

Create the file starting with this header + DDL. Conventions verified against migrations 030/034 (BEGIN/COMMIT, IF NOT EXISTS, GRANT; global tables get NO RLS — mirrors `technology_ontology`).

```sql
-- 046_project_ontology.sql
--
-- Seeds the project archetype + career-stage ontology as GLOBAL reference data
-- (no user_id, no RLS — mirrors technology_ontology). Used to calibrate
-- case-study generation per archetype × stage. Also adds computed_archetype /
-- computed_stage / archetype_computed_at to projects (per-user, RLS-inherited).
--
-- Source: @tucaken/ontology v0.1.0 (released 2026-05-27), transcribed verbatim
-- from tucaken-skill/packages/ontology/data/{archetypes,stages}/*.yaml.
-- Frozen snapshot: a future upstream change is a new migration.
--
-- Idempotent: IF NOT EXISTS + INSERT ... ON CONFLICT DO UPDATE so re-bootstrap
-- reconciles rows to this migration's values.

BEGIN;

CREATE TABLE IF NOT EXISTS project_archetypes (
    id                     TEXT PRIMARY KEY,
    name                   TEXT NOT NULL,
    description            TEXT NOT NULL,
    classification_signals JSONB NOT NULL DEFAULT '{}'::jsonb,
    expected_sections      JSONB NOT NULL DEFAULT '[]'::jsonb,
    expected_artifacts     JSONB NOT NULL DEFAULT '[]'::jsonb,
    pillar_weights         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS project_stage_overlays (
    archetype_id          TEXT NOT NULL REFERENCES project_archetypes(id) ON DELETE CASCADE,
    stage                 TEXT NOT NULL CHECK (stage IN ('junior','mid','senior','staff')),
    priority_sections     JSONB NOT NULL DEFAULT '[]'::jsonb,
    priority_artifacts    JSONB NOT NULL DEFAULT '[]'::jsonb,
    deemphasized_sections JSONB NOT NULL DEFAULT '[]'::jsonb,
    required_pillars      JSONB NOT NULL DEFAULT '[]'::jsonb,
    stage_suggestions     JSONB NOT NULL DEFAULT '[]'::jsonb,
    PRIMARY KEY (archetype_id, stage)
);

GRANT SELECT ON project_archetypes      TO tucaken_app;
GRANT SELECT ON project_stage_overlays  TO tucaken_app;

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS computed_archetype    TEXT,
    ADD COLUMN IF NOT EXISTS computed_stage        TEXT,
    ADD COLUMN IF NOT EXISTS archetype_computed_at TIMESTAMPTZ;
```

- [ ] **Step 2: Append the 9 archetype seed rows (verbatim from YAML)**

For EACH of the 9 files in `tucaken-skill/packages/ontology/data/archetypes/*.yaml`, transcribe into one upsert. The `production_saas` row is fully worked below; produce the other 8 identically from their YAML (cli-tool, devops-infra, internal-tool, ml-research, mobile-app, monorepo, open-source-library, static-site). Read each YAML file directly and convert its `classification_signals`/`expected_sections`/`expected_artifacts`/`pillar_weights` to JSON. Do NOT invent values — copy them.

```sql
INSERT INTO project_archetypes (id, name, description, classification_signals, expected_sections, expected_artifacts, pillar_weights) VALUES
('production_saas',
 'Production SaaS Application',
 'A deployed software-as-a-service product, typically multi-component, with real users and operational concerns.',
 '{"required_any":["has_deployment_workflow","has_iac","has_dockerfile","has_compose"],"positive":["has_env_example","has_compose","has_monitoring_config","has_live_url_in_readme","has_ci"],"negative":["notebook_heavy","has_single_script_entry"]}'::jsonb,
 '["hero","getting_started","architecture","deployment","design_decisions"]'::jsonb,
 '["readme_demo_link","production_deployment_evidence","architecture_diagram"]'::jsonb,
 '{"authenticity":0.20,"readability":0.20,"system_thinking":0.25,"production_reality":0.25,"stage_calibration":0.10}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    classification_signals = EXCLUDED.classification_signals,
    expected_sections = EXCLUDED.expected_sections,
    expected_artifacts = EXCLUDED.expected_artifacts,
    pillar_weights = EXCLUDED.pillar_weights;
```

Repeat the `INSERT ... ON CONFLICT DO UPDATE` for each remaining archetype (one statement per archetype, or one multi-row VALUES with a single ON CONFLICT — either is fine; per-row is clearer for review). The 9 ids MUST be exactly: `production_saas`, `open_source_library`, `internal_tool`, `ml_research`, `devops_infra`, `monorepo`, `cli_tool`, `mobile_app`, `static_site`.

- [ ] **Step 3: Append the 36 stage-overlay seed rows (verbatim from YAML)**

For EACH of the 36 files in `data/stages/*.yaml`, one upsert. `senior-production-saas` fully worked below; produce the other 35 from their YAML. Note: some stage files omit `deemphasized_sections` — default to `[]`. `stage_specific_suggestions` → `stage_suggestions` JSONB array of `{id,pillar,title,description,trigger,impact,effort}`.

```sql
INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('production_saas','senior',
 '["architecture","design_decisions","deployment","operational_practices","postmortems_or_incidents"]'::jsonb,
 '["adrs","runbook","rfc_documents"]'::jsonb,
 '[]'::jsonb,
 '["system_thinking","production_reality"]'::jsonb,
 '[{"id":"adr_backfill","pillar":"system_thinking","title":"Document your architectural decisions retroactively","description":"Code shows X, Y, Z choices. Senior interviews probe the reasoning behind these. Make it visible now.","trigger":"significant_architectural_choices_detected_and_no_adrs","impact":0.95,"effort":0.5},{"id":"postmortem_invitation","pillar":"production_reality","title":"Surface a debugging or incident story","description":"Senior engineers are evaluated on failure handling. A postmortem or lessons-learned section signals operational maturity.","trigger":"has_bug_fix_or_revert_commits","impact":0.85,"effort":0.4}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

COMMIT;
```

The 36 rows cover every (archetype_id ∈ 9 ids) × (stage ∈ junior/mid/senior/staff).

- [ ] **Step 4: Verify idempotent + row counts (if local PG available)**

```bash
psql "$PGURL" -v ON_ERROR_STOP=1 -f applications/platform-rds-bootstrap/migrations/046_project_ontology.sql
psql "$PGURL" -v ON_ERROR_STOP=1 -f applications/platform-rds-bootstrap/migrations/046_project_ontology.sql   # re-run = no error
psql "$PGURL" -At -c "SELECT count(*) FROM project_archetypes;"        # expect 9
psql "$PGURL" -At -c "SELECT count(*) FROM project_stage_overlays;"    # expect 36
```
Expected: both runs succeed; counts 9 and 36. If no local PG, rely on the bootstrap Job at deploy time — do not block.

- [ ] **Step 5: Commit**

```bash
git add applications/platform-rds-bootstrap/migrations/046_project_ontology.sql
git commit -m "feat(rds-bootstrap): seed project archetype/stage ontology (046)"
```

---

## Task 2: Shared archetype types

**Files:**
- Create: `applications/shared/src/projects/archetype-types.ts`

- [ ] **Step 1: Write the types (no test — pure type module)**

```ts
/** @format */

export const ARCHETYPE_IDS = [
    'production_saas', 'open_source_library', 'internal_tool', 'ml_research',
    'devops_infra', 'monorepo', 'cli_tool', 'mobile_app', 'static_site',
] as const;
export type ArchetypeId = (typeof ARCHETYPE_IDS)[number];

export const STAGE_IDS = ['junior', 'mid', 'senior', 'staff'] as const;
export type StageId = (typeof STAGE_IDS)[number];

export interface ClassificationSignals {
    readonly required_any?: readonly string[];
    readonly positive?:     readonly string[];
    readonly negative?:     readonly string[];
}

export interface ArchetypeDef {
    readonly id:                    string;
    readonly name:                  string;
    readonly description:           string;
    readonly classificationSignals: ClassificationSignals;
    readonly expectedSections:      readonly string[];
    readonly expectedArtifacts:     readonly string[];
}

export interface StageOverlay {
    readonly archetypeId:          string;
    readonly stage:                StageId;
    readonly prioritySections:     readonly string[];
    readonly deemphasizedSections: readonly string[];
    readonly stageSuggestions:     ReadonlyArray<{ title: string; description: string }>;
}

/** Inputs the classifier reads — all already available to the loader. */
export interface ClassifyRepoInput {
    readonly primaryLanguage: string | null;
    readonly topics:          readonly string[];
    readonly techStack:       readonly string[];
    readonly filePaths:       readonly string[];
}
export interface ClassifyInput {
    readonly projectType:  string;
    readonly projectShape: string;
    readonly repos:        readonly ClassifyRepoInput[];
}
```

- [ ] **Step 2: Typecheck**

Run: `cd applications/shared && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add applications/shared/src/projects/archetype-types.ts
git commit -m "feat(shared): archetype/stage ontology types"
```

---

## Task 3: RdsProjectOntologyRepository

**Files:**
- Create: `applications/shared/src/rds/implementations/RdsProjectOntologyRepository.ts`
- Test:   `applications/shared/src/rds/implementations/RdsProjectOntologyRepository.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { RdsProjectOntologyRepository } from './RdsProjectOntologyRepository.js';

function fakePool(rowsBySql: Array<{ match: RegExp; rows: unknown[] }>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query = jest.fn(async (sql: string) => {
        const hit = rowsBySql.find(r => r.match.test(sql));
        return { rows: hit ? hit.rows : [] };
    });
    return { pool: { query } as any, query };
}

describe('RdsProjectOntologyRepository', () => {
    it('getArchetype maps a row to ArchetypeDef', async () => {
        const { pool } = fakePool([{ match: /FROM project_archetypes/, rows: [{
            id: 'production_saas', name: 'Production SaaS Application', description: 'd',
            classification_signals: { required_any: ['has_iac'], positive: ['has_ci'], negative: [] },
            expected_sections: ['architecture'], expected_artifacts: ['adrs'],
        }] }]);
        const repo = new RdsProjectOntologyRepository(pool);
        const a = await repo.getArchetype('production_saas');
        expect(a?.id).toBe('production_saas');
        expect(a?.classificationSignals.required_any).toEqual(['has_iac']);
        expect(a?.expectedSections).toEqual(['architecture']);
    });

    it('getArchetype returns null when no row', async () => {
        const { pool } = fakePool([{ match: /FROM project_archetypes/, rows: [] }]);
        const repo = new RdsProjectOntologyRepository(pool);
        expect(await repo.getArchetype('nope')).toBeNull();
    });

    it('listArchetypes returns all rows mapped', async () => {
        const { pool } = fakePool([{ match: /FROM project_archetypes/, rows: [
            { id: 'a', name: 'A', description: 'd', classification_signals: {}, expected_sections: [], expected_artifacts: [] },
            { id: 'b', name: 'B', description: 'd', classification_signals: {}, expected_sections: [], expected_artifacts: [] },
        ] }]);
        const repo = new RdsProjectOntologyRepository(pool);
        const all = await repo.listArchetypes();
        expect(all.map(a => a.id)).toEqual(['a', 'b']);
    });

    it('getStageOverlay maps a row, returns null when absent', async () => {
        const { pool } = fakePool([{ match: /FROM project_stage_overlays/, rows: [{
            archetype_id: 'production_saas', stage: 'senior',
            priority_sections: ['architecture','deployment'],
            deemphasized_sections: [],
            stage_suggestions: [{ id: 'x', pillar: 'p', title: 'T', description: 'D', trigger: 'any', impact: 0.9, effort: 0.3 }],
        }] }]);
        const repo = new RdsProjectOntologyRepository(pool);
        const o = await repo.getStageOverlay('production_saas', 'senior');
        expect(o?.prioritySections).toEqual(['architecture','deployment']);
        expect(o?.stageSuggestions[0]).toEqual({ title: 'T', description: 'D' });

        const { pool: empty } = fakePool([{ match: /FROM project_stage_overlays/, rows: [] }]);
        expect(await new RdsProjectOntologyRepository(empty).getStageOverlay('x', 'junior')).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/shared && npx jest src/rds/implementations/RdsProjectOntologyRepository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/** @format */
import type { Pool } from 'pg';
import type { ArchetypeDef, StageOverlay, StageId } from '../../projects/archetype-types.js';

interface ArchetypeRow {
    id: string; name: string; description: string;
    classification_signals: { required_any?: string[]; positive?: string[]; negative?: string[] };
    expected_sections: string[]; expected_artifacts: string[];
}
interface OverlayRow {
    archetype_id: string; stage: string;
    priority_sections: string[]; deemphasized_sections: string[];
    stage_suggestions: Array<{ title: string; description: string }>;
}

function toArchetype(r: ArchetypeRow): ArchetypeDef {
    return {
        id: r.id, name: r.name, description: r.description,
        classificationSignals: r.classification_signals ?? {},
        expectedSections: r.expected_sections ?? [],
        expectedArtifacts: r.expected_artifacts ?? [],
    };
}

export class RdsProjectOntologyRepository {
    constructor(private readonly pool: Pool) {}

    async getArchetype(id: string): Promise<ArchetypeDef | null> {
        const r = await this.pool.query<ArchetypeRow>(
            `SELECT id, name, description, classification_signals, expected_sections, expected_artifacts
               FROM project_archetypes WHERE id = $1`,
            [id],
        );
        return r.rows[0] ? toArchetype(r.rows[0]) : null;
    }

    async listArchetypes(): Promise<ArchetypeDef[]> {
        const r = await this.pool.query<ArchetypeRow>(
            `SELECT id, name, description, classification_signals, expected_sections, expected_artifacts
               FROM project_archetypes`,
        );
        return r.rows.map(toArchetype);
    }

    async getStageOverlay(archetypeId: string, stage: StageId): Promise<StageOverlay | null> {
        const r = await this.pool.query<OverlayRow>(
            `SELECT archetype_id, stage, priority_sections, deemphasized_sections, stage_suggestions
               FROM project_stage_overlays WHERE archetype_id = $1 AND stage = $2`,
            [archetypeId, stage],
        );
        const row = r.rows[0];
        if (!row) return null;
        return {
            archetypeId: row.archetype_id,
            stage: row.stage as StageId,
            prioritySections: row.priority_sections ?? [],
            deemphasizedSections: row.deemphasized_sections ?? [],
            stageSuggestions: (row.stage_suggestions ?? []).map(s => ({ title: s.title, description: s.description })),
        };
    }
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `cd applications/shared && npx jest src/rds/implementations/RdsProjectOntologyRepository.test.ts && npx tsc --noEmit`
Expected: 4 tests PASS; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/rds/implementations/RdsProjectOntologyRepository.ts applications/shared/src/rds/implementations/RdsProjectOntologyRepository.test.ts
git commit -m "feat(shared): RdsProjectOntologyRepository — read archetype/stage ontology"
```

---

## Task 4: Archetype classifier (pure, deterministic)

**Files:**
- Create: `applications/shared/src/projects/archetype-classifier.ts`
- Test:   `applications/shared/src/projects/archetype-classifier.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from '@jest/globals';
import { deriveSignals, classifyArchetype } from './archetype-classifier.js';
import type { ArchetypeDef, ClassifyInput } from './archetype-types.js';

const ARCHETYPES: ArchetypeDef[] = [
    { id: 'production_saas', name: 'P', description: '', expectedSections: [], expectedArtifacts: [],
      classificationSignals: { required_any: ['has_iac','has_dockerfile'], positive: ['has_ci'], negative: ['notebook_heavy'] } },
    { id: 'ml_research', name: 'M', description: '', expectedSections: [], expectedArtifacts: [],
      classificationSignals: { required_any: ['has_notebooks'], positive: ['has_data_dir'], negative: ['has_iac'] } },
    { id: 'cli_tool', name: 'C', description: '', expectedSections: [], expectedArtifacts: [],
      classificationSignals: { required_any: ['has_bin_field'], positive: [], negative: ['has_iac'] } },
];

describe('deriveSignals', () => {
    it('detects notebooks + iac + mobile from file paths and tech stack', () => {
        const s = deriveSignals({
            projectType: 'side_project', projectShape: 'single_repo',
            repos: [{ primaryLanguage: 'Python', topics: ['ml'], techStack: ['pytorch'],
                      filePaths: ['train.ipynb', 'data/x.csv'] }],
        });
        expect(s.has_notebooks).toBe(true);
        expect(s.has_iac).toBe(false);
    });
    it('detects iac from infra-ish paths', () => {
        const s = deriveSignals({
            projectType: 'production_saas', projectShape: 'multi_repo',
            repos: [{ primaryLanguage: 'TypeScript', topics: [], techStack: ['kubernetes'],
                      filePaths: ['infra/terraform/main.tf', 'src/app.ts'] }],
        });
        expect(s.has_iac).toBe(true);
    });
});

describe('classifyArchetype', () => {
    it('classifies an ML repo (notebooks) over production_saas', () => {
        const input: ClassifyInput = {
            projectType: 'learning_project', projectShape: 'single_repo',
            repos: [{ primaryLanguage: 'Python', topics: ['machine-learning'], techStack: ['pytorch','jupyter'],
                      filePaths: ['notebooks/explore.ipynb', 'data/train.csv'] }],
        };
        const r = classifyArchetype(input, ARCHETYPES);
        expect(r?.archetypeId).toBe('ml_research');
    });

    it('classifies a SaaS repo (iac + ci) and applies projectType prior', () => {
        const input: ClassifyInput = {
            projectType: 'production_saas', projectShape: 'multi_repo',
            repos: [{ primaryLanguage: 'TypeScript', topics: [], techStack: ['docker','github-actions'],
                      filePaths: ['infra/k8s/deploy.yaml', '.github/workflows/ci.yml'] }],
        };
        const r = classifyArchetype(input, ARCHETYPES);
        expect(r?.archetypeId).toBe('production_saas');
    });

    it('returns null when no archetype scores positively', () => {
        const input: ClassifyInput = {
            projectType: 'side_project', projectShape: 'single_repo',
            repos: [{ primaryLanguage: 'TypeScript', topics: [], techStack: [], filePaths: ['README.md'] }],
        };
        const r = classifyArchetype(input, ARCHETYPES);
        expect(r).toBeNull();
    });

    it('tolerates empty repos array (returns null, no throw)', () => {
        expect(classifyArchetype({ projectType: 'side_project', projectShape: 'single_repo', repos: [] }, ARCHETYPES)).toBeNull();
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd applications/shared && npx jest src/projects/archetype-classifier.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/** @format */
import type { ArchetypeDef, ClassifyInput } from './archetype-types.js';

export type SignalMap = Record<string, boolean>;

const RE = {
    notebook: /\.ipynb$/i,
    iac:      /(^|\/)(infra|terraform|deploy|helm|k8s|kubernetes|cdk|pulumi|argocd)(\/|$)/i,
    docker:   /(^|\/)(dockerfile|docker-compose\.ya?ml)$/i,
    ci:       /(^|\/)\.github\/workflows\//i,
    dataDir:  /(^|\/)(data|datasets)(\/|$)/i,
    mobile:   /(^|\/)(ios|android)(\/|$)|\.xcodeproj|pubspec\.yaml/i,
};

function anyPath(repos: ClassifyInput['repos'], re: RegExp): boolean {
    return repos.some(r => r.filePaths.some(p => re.test(p)));
}
function techHas(repos: ClassifyInput['repos'], needles: string[]): boolean {
    const hay = repos.flatMap(r => [...r.techStack, ...r.topics, r.primaryLanguage ?? ''])
        .map(s => s.toLowerCase());
    return needles.some(n => hay.some(h => h.includes(n)));
}

/** Best-effort boolean signals derived from DB-available data. Missing data = false. */
export function deriveSignals(input: ClassifyInput): SignalMap {
    const { repos, projectShape } = input;
    return {
        has_notebooks:           anyPath(repos, RE.notebook),
        notebook_heavy:          anyPath(repos, RE.notebook) && techHas(repos, ['python','jupyter']),
        has_iac:                 anyPath(repos, RE.iac) || techHas(repos, ['terraform','kubernetes','helm','pulumi']),
        has_k8s_manifests:       anyPath(repos, RE.iac) || techHas(repos, ['kubernetes','helm']),
        has_dockerfile:          anyPath(repos, RE.docker) || techHas(repos, ['docker']),
        has_compose:             anyPath(repos, RE.docker),
        has_ci:                  anyPath(repos, RE.ci) || techHas(repos, ['github-actions','gitlab-ci','circleci']),
        has_deployment_workflow: anyPath(repos, RE.ci),
        has_data_dir:            anyPath(repos, RE.dataDir),
        has_workspaces_field:    projectShape === 'monorepo_subset' || projectShape === 'multi_repo',
        has_bin_field:           techHas(repos, ['cli','commander','clap','cobra']),
        mobile:                  anyPath(repos, RE.mobile) || techHas(repos, ['react-native','flutter','swift','kotlin']),
        has_package_publish:     techHas(repos, ['npm','pypi','crates']),
    };
}

/** projectType → a weak archetype prior (a +1 nudge), not a constraint. */
function priorFor(projectType: string): string | null {
    switch (projectType) {
        case 'production_saas': return 'production_saas';
        case 'open_source':     return 'open_source_library';
        case 'internal_tool':   return 'internal_tool';
        default:                return null;
    }
}

function scoreArchetype(def: ArchetypeDef, signals: SignalMap): number {
    const s = def.classificationSignals;
    let score = 0;
    if (s.required_any && s.required_any.some(k => signals[k])) score += 2;
    for (const k of s.positive ?? []) if (signals[k]) score += 1;
    for (const k of s.negative ?? []) if (signals[k]) score -= 2;
    return score;
}

/**
 * Deterministic archetype classification. Returns null when nothing scores
 * positively (caller falls back to no calibration). Pure — no IO.
 */
export function classifyArchetype(
    input: ClassifyInput,
    archetypes: readonly ArchetypeDef[],
): { archetypeId: string; confidence: number } | null {
    if (input.repos.length === 0) return null;
    const signals = deriveSignals(input);
    const prior = priorFor(input.projectType);

    let best: { id: string; score: number } | null = null;
    for (const def of archetypes) {
        let score = scoreArchetype(def, signals);
        if (prior && def.id === prior) score += 1;
        if (best === null || score > best.score) best = { id: def.id, score };
    }
    if (!best || best.score <= 0) return null;
    // Confidence: normalise loosely into (0,1]; capped.
    const confidence = Math.min(1, best.score / 4);
    return { archetypeId: best.id, confidence };
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `cd applications/shared && npx jest src/projects/archetype-classifier.test.ts && npx tsc --noEmit`
Expected: all tests PASS; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/projects/archetype-classifier.ts applications/shared/src/projects/archetype-classifier.test.ts
git commit -m "feat(shared): deterministic project archetype classifier"
```

---

## Task 5: deriveStage (seniority → stage)

**Files:**
- Create: `applications/shared/src/projects/derive-stage.ts`
- Test:   `applications/shared/src/projects/derive-stage.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from '@jest/globals';
import { mapSeniorityLevel, pickStage } from './derive-stage.js';

describe('mapSeniorityLevel', () => {
    it('maps the 5 source levels to 4 ontology stages', () => {
        expect(mapSeniorityLevel('junior')).toBe('junior');
        expect(mapSeniorityLevel('mid')).toBe('mid');
        expect(mapSeniorityLevel('mid-senior')).toBe('senior');
        expect(mapSeniorityLevel('senior')).toBe('senior');
        expect(mapSeniorityLevel('staff+')).toBe('staff');
    });
    it('returns null for an unknown level', () => {
        expect(mapSeniorityLevel('wizard')).toBeNull();
    });
});

describe('pickStage', () => {
    it('returns null for empty seniority', () => {
        expect(pickStage([])).toBeNull();
    });
    it('picks the highest area level', () => {
        expect(pickStage([
            { area: 'frontend', level: 'mid' },
            { area: 'backend',  level: 'staff+' },
            { area: 'infra',    level: 'senior' },
        ])).toBe('staff');
    });
    it('ignores unmappable levels but still picks the highest valid', () => {
        expect(pickStage([
            { area: 'x', level: 'wizard' },
            { area: 'y', level: 'mid' },
        ])).toBe('mid');
        expect(pickStage([{ area: 'x', level: 'wizard' }])).toBeNull();
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd applications/shared && npx jest src/projects/derive-stage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/** @format */
import type { StageId } from './archetype-types.js';

/** Source seniority levels from DirectionSynthesizer (migration 026). */
const LEVEL_TO_STAGE: Record<string, StageId> = {
    'junior':     'junior',
    'mid':        'mid',
    'mid-senior': 'senior',
    'senior':     'senior',
    'staff+':     'staff',
};

const STAGE_RANK: Record<StageId, number> = { junior: 0, mid: 1, senior: 2, staff: 3 };

export function mapSeniorityLevel(level: string): StageId | null {
    return LEVEL_TO_STAGE[level] ?? null;
}

/**
 * Pick the highest-ranked stage across the user's per-area seniority.
 * Returns null when nothing maps (sparse/new profile) → caller uses
 * archetype-only calibration.
 */
export function pickStage(
    seniority: ReadonlyArray<{ area: string; level: string }>,
): StageId | null {
    let best: StageId | null = null;
    for (const s of seniority) {
        const stage = mapSeniorityLevel(s.level);
        if (stage && (best === null || STAGE_RANK[stage] > STAGE_RANK[best])) best = stage;
    }
    return best;
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `cd applications/shared && npx jest src/projects/derive-stage.test.ts && npx tsc --noEmit`
Expected: all PASS; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/projects/derive-stage.ts applications/shared/src/projects/derive-stage.test.ts
git commit -m "feat(shared): derive ontology stage from DirectionSynthesizer seniority"
```

---

## Task 6: CaseStudyContext calibration fields

**Files:**
- Modify: `applications/shared/src/projects/case-study-types.ts`

- [ ] **Step 1: Add optional fields to the CaseStudyContext interface**

Locate the `CaseStudyContext` interface (ends after `kbChunks: ReadonlyArray<{...}>`). Add, before the closing brace:

```ts
    // ── Archetype/stage calibration (optional, additive) ──────────────────
    // Populated by the loader when classification succeeds. Absent → the
    // agent prompt is unchanged (today's behavior).
    readonly archetype?:        { readonly id: string; readonly name: string } | null;
    readonly stage?:            'junior' | 'mid' | 'senior' | 'staff' | null;
    readonly prioritySections?: readonly string[];
    readonly deemphasizedSections?: readonly string[];
```

- [ ] **Step 2: Typecheck**

Run: `cd applications/shared && npx tsc --noEmit`
Expected: exit 0 (fields optional → no break at existing construction sites).

- [ ] **Step 3: Commit**

```bash
git add applications/shared/src/projects/case-study-types.ts
git commit -m "feat(case-study): add optional archetype/stage fields to context"
```

---

## Task 7: computeInputHash includes archetype/stage

**Files:**
- Modify: `applications/shared/src/projects/case-study-orchestrator.ts`
- Test:   `applications/shared/src/projects/case-study-orchestrator.test.ts` (exists from a prior PR — extend it)

- [ ] **Step 1: Add a failing test (append to the existing describe block)**

```ts
it('hash changes when archetype/stage is added; identical when absent', () => {
    const base = ctx();                                   // helper from existing test file
    const withArch = ctx({ archetype: { id: 'production_saas', name: 'P' }, stage: 'senior' });
    expect(computeInputHash(withArch)).not.toBe(computeInputHash(base));
    // absent archetype hashes identically to a second absent-archetype context
    expect(computeInputHash(ctx())).toBe(computeInputHash(base));
});
```

> If the existing `ctx()` helper does not accept overrides, extend it to spread overrides into `context` (it already does for pulls/commits per the prior PR). Add `archetype`/`stage` to the override object type.

- [ ] **Step 2: Run to verify it fails**

Run: `cd applications/shared && npx jest src/projects/case-study-orchestrator.test.ts`
Expected: FAIL — archetype not in hash, so `withArch` equals `base`.

- [ ] **Step 3: Add archetype/stage to computeInputHash**

In `computeInputHash`, after the existing `for (const pr of c.pulls)` loop (added by the prior PR), add:

```ts
    if (c.archetype) h.update(`arch:${c.archetype.id}`);
    if (c.stage)     h.update(`stage:${c.stage}`);
```

- [ ] **Step 4: Run test + typecheck**

Run: `cd applications/shared && npx jest src/projects/case-study-orchestrator.test.ts && npx tsc --noEmit`
Expected: PASS; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/projects/case-study-orchestrator.ts applications/shared/src/projects/case-study-orchestrator.test.ts
git commit -m "feat(case-study): include archetype/stage in cache input hash"
```

---

## Task 8: Loader — classify, derive stage, persist, attach

**Files:**
- Modify: `applications/shared/src/projects/case-study-loader.ts`
- Test:   `applications/shared/src/projects/case-study-loader.test.ts` (exists — extend it)

- [ ] **Step 1: Add a failing test**

Extend the existing loader test. Add a case where the project + repos classify to an archetype and the seniority row yields a stage, asserting the context carries `archetype`, `stage`, `prioritySections`, and that an UPDATE to `projects` was issued. Use the existing fake-pool-by-regex pattern; add rows for `/FROM user_profile_rollup/` (returns `direction.seniority`) and `/FROM project_archetypes/` + `/FROM project_stage_overlays/`, and assert one `/UPDATE projects SET computed_archetype/` query fired.

```ts
it('classifies archetype + stage, persists, and attaches calibration to context', async () => {
    const pool = poolReturning([
        { match: /FROM projects WHERE id/, rows: [{ id: 'p', user_id: 'u', name: 'P', tagline: null, pitch: null, user_overrides: {}, type: 'production_saas', shape: 'multi_repo' }] },
        { match: /FROM project_components/, rows: [] },
        { match: /FROM project_repositories/, rows: [{ id: 'r', full_name: 'o/a', primary_language: 'TypeScript', topics: [], tech_stack: ['docker','kubernetes'], default_branch: 'main' }] },
        { match: /FROM document_embeddings/, rows: [{ repo_full_name: 'o/a', file_path: 'infra/k8s/deploy.yaml', chunk_type: 'document', content: 'x' }] },
        { match: /FROM repo_commits/, rows: [] },
        { match: /FROM repo_pull_requests/, rows: [] },
        { match: /FROM user_profile_rollup/, rows: [{ direction: { seniority: [{ area: 'backend', level: 'senior' }] } }] },
        { match: /FROM project_archetypes/, rows: [{ id: 'production_saas', name: 'Production SaaS Application', description: 'd', classification_signals: { required_any: ['has_iac'], positive: ['has_ci'], negative: [] }, expected_sections: ['architecture'], expected_artifacts: [] }] },
        { match: /FROM project_stage_overlays/, rows: [{ archetype_id: 'production_saas', stage: 'senior', priority_sections: ['architecture','deployment'], deemphasized_sections: [], stage_suggestions: [] }] },
        { match: /UPDATE projects SET computed_archetype/, rows: [] },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await loadCaseStudyContext(pool as any, 'p');
    expect(out.context.archetype?.id).toBe('production_saas');
    expect(out.context.stage).toBe('senior');
    expect(out.context.prioritySections).toEqual(['architecture','deployment']);
});

it('attaches no calibration when classification finds nothing (fallback)', async () => {
    const pool = poolReturning([
        { match: /FROM projects WHERE id/, rows: [{ id: 'p', user_id: 'u', name: 'P', tagline: null, pitch: null, user_overrides: {}, type: 'side_project', shape: 'single_repo' }] },
        { match: /FROM project_components/, rows: [] },
        { match: /FROM project_repositories/, rows: [{ id: 'r', full_name: 'o/a', primary_language: 'TypeScript', topics: [], tech_stack: [], default_branch: 'main' }] },
        { match: /FROM document_embeddings/, rows: [] },
        { match: /FROM repo_commits/, rows: [] },
        { match: /FROM repo_pull_requests/, rows: [] },
        { match: /FROM project_archetypes/, rows: [{ id: 'production_saas', name: 'P', description: 'd', classification_signals: { required_any: ['has_iac'], positive: [], negative: [] }, expected_sections: [], expected_artifacts: [] }] },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await loadCaseStudyContext(pool as any, 'p');
    expect(out.context.archetype ?? null).toBeNull();
    expect(out.context.stage ?? null).toBeNull();
});
```

> Adjust `poolReturning` if the existing helper matches the FIRST regex per call vs scanning — match the existing file's helper exactly. The project SELECT must now also return `type` + `shape`; update the existing project-row mock in OTHER tests to include `type`/`shape` (default `'side_project'`/`'single_repo'`) so they still pass.

- [ ] **Step 2: Run to verify it fails**

Run: `cd applications/shared && npx jest src/projects/case-study-loader.test.ts`
Expected: FAIL — context has no `archetype`.

- [ ] **Step 3: Extend the project SELECT to fetch type + shape**

In `loadCaseStudyContext`, the first query (`SELECT id, user_id, name, tagline, pitch, user_overrides FROM projects WHERE id = $1`) → add `type, shape`:

```ts
    const project = await pool.query<ProjectRow>(
        `SELECT id, user_id, name, tagline, pitch, user_overrides, type, shape
         FROM projects WHERE id = $1`,
        [projectId],
    );
```
And extend the `ProjectRow` interface with `type: string; shape: string;`.

- [ ] **Step 4: Add the calibration step before `packContext`**

After `rawContext` is built and BEFORE `const context = packContext(...)`, insert:

```ts
    // ── Archetype/stage calibration (additive; absent fields = no change) ──
    const ontology   = new RdsProjectOntologyRepository(pool);
    const archetypes = await ontology.listArchetypes();
    const classified = classifyArchetype(
        {
            projectType:  p.type,
            projectShape: p.shape,
            repos: repos.map((r) => ({
                primaryLanguage: r.primary_language,
                topics:          r.topics ?? [],
                techStack:       r.tech_stack ?? [],
                filePaths:       kb.filter((k) => k.repo_full_name === r.full_name)
                                    .map((k) => k.file_path ?? '')
                                    .filter(Boolean),
            })),
        },
        archetypes,
    );

    let calibration: Pick<CaseStudyContext,
        'archetype' | 'stage' | 'prioritySections' | 'deemphasizedSections'> = {};

    if (classified) {
        const def = archetypes.find((a) => a.id === classified.archetypeId) ?? null;
        const seniorityRow = await pool.query<{ direction: { seniority?: Array<{ area: string; level: string }> } | null }>(
            `SELECT direction FROM user_profile_rollup WHERE user_id = $1`,
            [p.user_id],
        );
        const seniority = seniorityRow.rows[0]?.direction?.seniority ?? [];
        const stage = pickStage(seniority);
        const overlay = stage ? await ontology.getStageOverlay(classified.archetypeId, stage) : null;

        calibration = {
            archetype: def ? { id: def.id, name: def.name } : { id: classified.archetypeId, name: classified.archetypeId },
            stage,
            prioritySections: overlay?.prioritySections ?? def?.expectedSections ?? [],
            deemphasizedSections: overlay?.deemphasizedSections ?? [],
        };

        await pool.query(
            `UPDATE projects
                SET computed_archetype = $2, computed_stage = $3, archetype_computed_at = now()
              WHERE id = $1`,
            [projectId, classified.archetypeId, stage],
        );
    }

    const rawContextCalibrated = { ...rawContext, ...calibration };
    const context = packContext(rawContextCalibrated, { maxTokens: CONTEXT_TOKEN_BUDGET });
    return { userId: p.user_id, context };
```

> Replace the existing `const context = packContext(rawContext, ...)` + return with the block above. Add imports at top of file:
> ```ts
> import { RdsProjectOntologyRepository } from '../rds/implementations/RdsProjectOntologyRepository.js';
> import { classifyArchetype } from './archetype-classifier.js';
> import { pickStage } from './derive-stage.js';
> ```
> Note: `packContext` must pass through the new optional fields unchanged. Verify `packContext` spreads `...context` (it does per the prior PR — it only trims commits/pulls/kbChunks). If packContext rebuilds the object field-by-field, add the 4 calibration fields to its passthrough.

- [ ] **Step 5: Run test + full shared suite + typecheck**

Run: `cd applications/shared && npx jest src/projects/case-study-loader.test.ts && npx tsc --noEmit`
Then: `cd applications/shared && npx jest`
Expected: loader tests PASS; tsc 0; full suite green (fix any other loader test whose project-row mock now needs `type`/`shape`).

- [ ] **Step 6: Commit**

```bash
git add applications/shared/src/projects/case-study-loader.ts applications/shared/src/projects/case-study-loader.test.ts
git commit -m "feat(case-study): classify archetype + stage, persist, attach to context"
```

---

## Task 9: Agent — soft calibration guidance in the prompt

**Files:**
- Modify: `applications/shared/src/projects/case-study-agent.ts`

- [ ] **Step 1: Add a failing test**

Create/extend `applications/shared/src/projects/case-study-agent.test.ts`. The agent invokes Bedrock, so test the prompt-building helper directly. Extract the system-prompt assembly into an exported pure helper `buildSystemPrompt(context)` (see Step 3), then test:

```ts
import { describe, it, expect } from '@jest/globals';
import { buildSystemPrompt } from './case-study-agent.js';

const baseCtx = {
    projectId: 'p', projectName: 'P', tagline: null, pitch: null, userOverrides: {},
    components: [], repositories: [], commits: [], pulls: [], kbChunks: [],
} as const;

it('appends a calibration block when archetype is present', () => {
    const prompt = buildSystemPrompt({ ...baseCtx, archetype: { id: 'production_saas', name: 'Production SaaS Application' }, stage: 'senior', prioritySections: ['architecture','deployment'] } as never);
    expect(prompt).toMatch(/Project calibration/);
    expect(prompt).toMatch(/senior-level Production SaaS Application/);
    expect(prompt).toMatch(/architecture, deployment/);
    expect(prompt).toMatch(/never truthfulness/);
});

it('returns the base prompt unchanged when no archetype', () => {
    const prompt = buildSystemPrompt(baseCtx as never);
    expect(prompt).not.toMatch(/Project calibration/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd applications/shared && npx jest src/projects/case-study-agent.test.ts`
Expected: FAIL — `buildSystemPrompt` not exported.

- [ ] **Step 3: Extract + extend the system prompt builder**

In `case-study-agent.ts`, keep `SYSTEM_PROMPT_TEXT` as the base. Add an exported helper and use it where the system prompt is passed to `runAgent`:

```ts
export function buildSystemPrompt(context: CaseStudyContext): string {
    if (!context.archetype) return SYSTEM_PROMPT_TEXT;
    const stageLabel = context.stage ?? 'unspecified';
    const priority = (context.prioritySections ?? []).join(', ');
    const deemph = (context.deemphasizedSections ?? []).join(', ');
    const block = [
        '',
        'Project calibration:',
        `This is a ${stageLabel}-level ${context.archetype.name} project.` +
        (priority ? ` Recruiters at this level look hardest at: ${priority}. Prioritise depth and evidence in those sections.` : ''),
        deemph ? `De-emphasise: ${deemph}.` : '',
        'Still emit every section the evidence supports — calibration changes emphasis, never truthfulness. Omit any section you cannot ground.',
    ].filter(Boolean).join('\n');
    return `${SYSTEM_PROMPT_TEXT}\n${block}`;
}
```

Then where the agent builds its request (currently `SYSTEM_PROMPT` constant from `SYSTEM_PROMPT_TEXT`), build it per-invocation from the context:

```ts
        const systemPrompt: SystemContentBlock[] = [{ text: buildSystemPrompt(context) }];
```
(Replace the module-level `SYSTEM_PROMPT` usage inside the invoke path with this per-call value. Leave `SYSTEM_PROMPT_TEXT` as the base constant.)

- [ ] **Step 4: Run test + full suite + typecheck**

Run: `cd applications/shared && npx jest src/projects/case-study-agent.test.ts && npx tsc --noEmit && npx jest`
Expected: agent tests PASS; tsc 0; full `@bedrock/shared` suite green.

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/projects/case-study-agent.ts applications/shared/src/projects/case-study-agent.test.ts
git commit -m "feat(case-study): soft archetype/stage guidance in the system prompt"
```

---

## Task 10: Open the PR

- [ ] **Step 1: Push + PR**

```bash
git push -u origin feat/archetype-stage-calibration
gh pr create --base develop --title "feat(case-study): archetype/stage-calibrated generation" --body "Implements docs/superpowers/specs/2026-05-31-archetype-stage-calibrated-case-studies-design.md. Seeds the @tucaken/ontology archetype/stage catalog into global DB tables (migration 046), classifies each project deterministically, derives stage from DirectionSynthesizer seniority, and injects soft section-priority guidance into the case-study prompt. Additive + degradable: schema/evidence-gating/grounding untouched; absent classification = today's behavior. Multi-tenant: shared catalog + per-user application."
```

---

## Notes for the implementer

- **Verbatim transcription (Task 1):** the 45 YAML files are the source of truth. Open each, convert to the JSON shape shown, do not paraphrase values. Stage files lacking `deemphasized_sections` → `[]`. `stage_specific_suggestions` keeps only what we use downstream but store the full object (id/pillar/title/description/trigger/impact/effort) for fidelity.
- **packContext passthrough (Task 8):** the calibration fields must survive packing. Confirm `packContext` returns `{ ...context, commits, pulls, kbChunks }` (spread) — if it constructs the object explicitly, add the 4 fields.
- **Other loader tests (Task 8):** adding `type`/`shape` to the project SELECT means existing loader-test project-row mocks need those keys; update them to keep the suite green.
- **No persistence/schema changes for sections** — the `emit_case_study` tool schema + Zod stay exactly as-is. This PR never makes a section optional.
```
