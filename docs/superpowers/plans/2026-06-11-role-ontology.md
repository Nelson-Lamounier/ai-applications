# Role Ontology + Experience Grounding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the strategist role semantics from a self-improving DB role ontology, fed as a `roleEvidenceBlock` that translates a stretch candidate's experience into the target domain's vocabulary, plus a Technical Support archetype.

**Architecture:** New global `role_ontology` / `role_aliases` / `role_learning_candidates` tables (seeded by migration 072). A `RoleOntologyRepository` (shared/rds, mirrors `TechnologyOntologyRepository`) + a `resolveRoleFamilies` cascade (alias-map → Haiku classifier → Tavily). Results format a `roleEvidenceBlock` (sibling of `projectEvidenceBlock`), threaded into research + strategist. Learning stages `candidate` rows promoted to `auto_imported` on ≥3-user corroboration. Fail-open throughout.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` imports), Postgres (`pg`), Zod, AWS Bedrock (`runAgent` Haiku forced-tool), Jest (ts-jest, CJS `jest.mock`).

**Spec:** `docs/superpowers/specs/2026-06-11-role-ontology-design.md`

### ⚠️ Two deliberate scope reductions vs the spec — confirm before executing

1. **Seed = 6 families, not ~15-25.** v1 seeds `technical-support`, `software-engineer-backend`, `software-engineer-fullstack`, `sre`, `platform-infra`, `qa-engineering` — which cover the test user's three roles (support, cloud/devops→platform-infra, QA) plus common targets. The ontology grows the rest via learning + later curation. (YAGNI — curating 25 families up front is content work that delays value. Say the word to expand the seed.)
2. **Tavily is NOT wired in the cascade (deferred).** The cascade is **alias → Haiku classifier** only; a classifier-miss yields a `null` family (no grounding for that role, fail-open). The spec's step-3 Tavily online-discovery is documented as a Phase-2 add — wiring it (the `enrich-role.ts` tool + family synthesis + candidate persistence) is real extra surface for the rare novel-role case. Say the word to include it now.

All work is in `ai-applications` on branch `feat/role-ontology` (off `develop`). Build `shared` with `cd applications/shared && npx tsc --build` before typechecking dependents.

---

## Task 1: Migration 072 — tables, enums, curated seed

**Files:**
- Create: `applications/platform-rds-bootstrap/migrations/072_role_ontology.sql`

- [ ] **Step 1: Write the migration**

Create `applications/platform-rds-bootstrap/migrations/072_role_ontology.sql`. Global reference tables (no RLS, like `technology_ontology`). Idempotent. Seed 6 curated families covering the test user's roles + common targets.

```sql
-- =============================================================================
-- Migration 072 — role_ontology (self-improving role semantics)
--
-- Global reference data (NO RLS), mirrors technology_ontology. Feeds the
-- strategist a roleEvidenceBlock that translates experience into a target role's
-- vocabulary. Curated seed below; user-derived signals are learned via
-- role_learning_candidates and promoted on cross-user corroboration. Idempotent.
-- =============================================================================

DO $$ BEGIN
  CREATE TYPE role_class_enum AS ENUM ('customer_facing','builder','ops','hybrid');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE role_curation_enum AS ENUM ('curated','auto_imported','candidate');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS role_ontology (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_key                 TEXT NOT NULL UNIQUE,
  display_name               TEXT NOT NULL,
  role_class                 role_class_enum NOT NULL,
  canonical_responsibilities TEXT[] NOT NULL DEFAULT '{}',
  vocabulary                 TEXT[] NOT NULL DEFAULT '{}',
  transferable_skills        TEXT[] NOT NULL DEFAULT '{}',
  industry_notes             TEXT NOT NULL DEFAULT '',
  curation                   role_curation_enum NOT NULL DEFAULT 'curated',
  popularity_score           INT NOT NULL DEFAULT 0,
  is_active                  BOOLEAN NOT NULL DEFAULT TRUE,
  source                     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_aliases (
  alias       TEXT PRIMARY KEY,
  family_key  TEXT NOT NULL REFERENCES role_ontology(family_key) ON DELETE CASCADE,
  curation    role_curation_enum NOT NULL DEFAULT 'curated',
  source      TEXT NOT NULL DEFAULT 'seed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_learning_candidates (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_key           TEXT NOT NULL,
  candidate_type       TEXT NOT NULL CHECK (candidate_type IN ('alias','vocabulary','transferable_skill')),
  value                TEXT NOT NULL,
  contributing_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (family_key, candidate_type, value, contributing_user_id)
);
CREATE INDEX IF NOT EXISTS idx_role_learning_lookup
  ON role_learning_candidates (family_key, candidate_type, value);

-- ── Curated seed (curation='curated', source='seed-072') ─────────────────────
INSERT INTO role_ontology (family_key, display_name, role_class, canonical_responsibilities, vocabulary, transferable_skills, industry_notes, source)
VALUES
('technical-support', 'Technical Support / Customer Engineering', 'customer_facing',
 ARRAY['Triage case queues to SLA and response-time targets','Participate in on-call rotations','Manage customer relationships and account health','Educate and enable customers on the platform','Drive and coordinate escalations','Partner cross-functionally with product, engineering, and go-to-market'],
 ARRAY['SLA','response time','on-call','queue','ticket','escalation','customer success','enablement','onboarding','churn','subscription','account health','SaaS support','customer education'],
 ARRAY['customer empathy','incident triage','technical communication','stakeholder management','root-cause analysis','documentation'],
 'Cloud-provider support (e.g. AWS) operates like SaaS support — paying customers, subscriptions, account health. Frame infrastructure-provider support as customer-facing SaaS support.', 'seed-072'),
('software-engineer-backend', 'Backend Software Engineer', 'builder',
 ARRAY['Design and build APIs and services','Model data and own database schemas','Write tested, reviewed production code','Operate services they build'],
 ARRAY['API','microservices','database','distributed systems','latency','throughput','testing','code review','CI/CD'],
 ARRAY['systems design','debugging','data modelling','code quality','collaboration'],
 '', 'seed-072'),
('software-engineer-fullstack', 'Full-Stack Software Engineer', 'builder',
 ARRAY['Build user-facing features end to end','Develop frontend and backend','Ship and iterate on product'],
 ARRAY['React','TypeScript','frontend','backend','API','full-stack','UX','testing'],
 ARRAY['product sense','systems design','debugging','collaboration'],
 '', 'seed-072'),
('sre', 'Site Reliability Engineer', 'ops',
 ARRAY['Own service reliability and SLOs','Run on-call and incident response','Reduce toil through automation','Track DORA/MTTR and drive postmortems'],
 ARRAY['SLO','SLI','error budget','on-call','incident','MTTR','DORA','reliability','observability','runbook'],
 ARRAY['incident response','automation','systems thinking','calm under pressure'],
 '', 'seed-072'),
('platform-infra', 'Platform / Infrastructure Engineer', 'builder',
 ARRAY['Build internal platforms and IaC','Own cloud infrastructure and golden paths','Enable other engineers via self-service'],
 ARRAY['IaC','Terraform','CDK','Kubernetes','platform','golden path','self-service','cloud'],
 ARRAY['systems design','automation','developer experience','documentation'],
 '', 'seed-072'),
('qa-engineering', 'Quality Assurance / Quality Engineering', 'hybrid',
 ARRAY['Define and run test strategy and quality gates','Build monitoring and quality dashboards','Partner cross-functionally with product, engineering, and go-to-market to find process bottlenecks','Standardise operational procedures'],
 ARRAY['test strategy','quality gates','monitoring','dashboards','cross-functional','process standardisation','reliability'],
 ARRAY['attention to detail','process design','cross-functional partnership','data analysis'],
 '', 'seed-072')
ON CONFLICT (family_key) DO NOTHING;

INSERT INTO role_aliases (alias, family_key) VALUES
('technical customer service associate','technical-support'),
('customer service','technical-support'),
('support engineer','technical-support'),
('technical support','technical-support'),
('service associate','technical-support'),
('customer support','technical-support'),
('cloud support','technical-support'),
('backend engineer','software-engineer-backend'),
('backend developer','software-engineer-backend'),
('software engineer','software-engineer-backend'),
('full-stack engineer','software-engineer-fullstack'),
('fullstack developer','software-engineer-fullstack'),
('full stack engineer','software-engineer-fullstack'),
('site reliability engineer','sre'),
('sre','sre'),
('reliability engineer','sre'),
('platform engineer','platform-infra'),
('infrastructure engineer','platform-infra'),
('cloud engineer','platform-infra'),
('devops engineer','platform-infra'),
('cloud & devops engineer','platform-infra'),
('quality assurance analyst','qa-engineering'),
('qa analyst','qa-engineering'),
('quality engineer','qa-engineering')
ON CONFLICT (alias) DO NOTHING;

-- =============================================================================
-- Verification
--   SELECT family_key, role_class, array_length(vocabulary,1) FROM role_ontology;
--   SELECT alias, family_key FROM role_aliases WHERE family_key='technical-support';
-- =============================================================================
```

- [ ] **Step 2: Validate the SQL parses**

Run: `cd applications/platform-rds-bootstrap && cat migrations/072_role_ontology.sql | head -5` (sanity), and if a local Postgres is available, `psql "$LOCAL_PG" -f migrations/072_role_ontology.sql` then the verification SELECTs. If no local DB, confirm the file is syntactically consistent with `070_repo_sync_type.sql` (no BEGIN/COMMIT, idempotent guards).

- [ ] **Step 3: Commit**

```bash
git add applications/platform-rds-bootstrap/migrations/072_role_ontology.sql
git commit -m "feat(rds): migration 072 — role_ontology tables + curated seed"
```

---

## Task 2: Types + RoleOntologyRepository

**Files:**
- Create: `applications/shared/src/rds/types/role-ontology.ts`
- Create: `applications/shared/src/rds/implementations/RoleOntologyRepository.ts`
- Test: `applications/shared/src/rds/implementations/RoleOntologyRepository.test.ts`

- [ ] **Step 1: Create the types**

Create `applications/shared/src/rds/types/role-ontology.ts`:

```ts
/** @format */
export type RoleClass = 'customer_facing' | 'builder' | 'ops' | 'hybrid';

export interface RoleFamily {
    familyKey:                 string;
    displayName:               string;
    roleClass:                 RoleClass;
    canonicalResponsibilities: string[];
    vocabulary:                string[];
    transferableSkills:        string[];
    industryNotes:             string;
}

export type RoleCandidateType = 'alias' | 'vocabulary' | 'transferable_skill';

export interface RoleLearningCandidate {
    familyKey:          string;
    candidateType:      RoleCandidateType;
    value:              string;
    contributingUserId: string;
}
```

- [ ] **Step 2: Write the failing repository test**

Create `applications/shared/src/rds/implementations/RoleOntologyRepository.test.ts`:

```ts
/** @format */
import type { Pool } from 'pg';
import { RoleOntologyRepository } from './RoleOntologyRepository.js';

function mockPool(handlers: Array<(sql: string, params?: unknown[]) => { rows: unknown[] }>) {
    let i = 0;
    const query = jest.fn((sql: string, params?: unknown[]) => Promise.resolve(handlers[i++]?.(sql, params) ?? { rows: [] }));
    return { pool: { query } as unknown as Pool, query };
}

describe('RoleOntologyRepository', () => {
    it('loadAliasMap builds a lowercase alias→family map', async () => {
        const { pool } = mockPool([() => ({ rows: [{ alias: 'support engineer', family_key: 'technical-support' }] })]);
        const map = await new RoleOntologyRepository(pool).loadAliasMap();
        expect(map.get('support engineer')).toBe('technical-support');
    });

    it('loadFamilies returns curated+auto_imported only (excludes candidate), mapped to camelCase', async () => {
        const { pool, query } = mockPool([() => ({ rows: [{
            family_key: 'technical-support', display_name: 'Technical Support / Customer Engineering',
            role_class: 'customer_facing', canonical_responsibilities: ['Triage queues'],
            vocabulary: ['SLA'], transferable_skills: ['customer empathy'], industry_notes: 'note',
        }] })]);
        const fams = await new RoleOntologyRepository(pool).loadFamilies();
        expect(fams[0]).toMatchObject({ familyKey: 'technical-support', roleClass: 'customer_facing', vocabulary: ['SLA'] });
        expect((query.mock.calls[0][0] as string)).toMatch(/curation IN \('curated','auto_imported'\)/i);
    });

    it('stageCandidate upserts one vote per user (ON CONFLICT DO NOTHING)', async () => {
        const { pool, query } = mockPool([() => ({ rows: [] })]);
        await new RoleOntologyRepository(pool).stageCandidate({ familyKey: 'technical-support', candidateType: 'alias', value: 'tech support rep', contributingUserId: 'u-1' });
        expect(query.mock.calls[0][0] as string).toMatch(/INSERT INTO role_learning_candidates/i);
        expect(query.mock.calls[0][0] as string).toMatch(/ON CONFLICT.*DO NOTHING/i);
        expect(query.mock.calls[0][1]).toEqual(['technical-support', 'alias', 'tech support rep', 'u-1']);
    });

    it('promote runs the two corroboration UPSERTs with the quorum', async () => {
        const { pool, query } = mockPool([() => ({ rows: [] }), () => ({ rows: [] })]);
        await new RoleOntologyRepository(pool).promote(3);
        const sqls = query.mock.calls.map((c) => c[0] as string).join('\n');
        expect(sqls).toMatch(/role_aliases/);
        expect(sqls).toMatch(/array_append|vocabulary/i);
        expect(query.mock.calls.every((c) => (c[1] as unknown[]).includes(3))).toBe(true);
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd applications/shared && npx jest RoleOntologyRepository` → FAIL (module not found).

- [ ] **Step 4: Implement the repository**

Create `applications/shared/src/rds/implementations/RoleOntologyRepository.ts`:

```ts
/** @format */
import type { Pool } from 'pg';
import type { RoleFamily, RoleLearningCandidate } from '../types/role-ontology.js';

interface FamilyRow {
    family_key: string; display_name: string; role_class: RoleFamily['roleClass'];
    canonical_responsibilities: string[]; vocabulary: string[]; transferable_skills: string[]; industry_notes: string;
}

/** Global role-ontology reference data (no RLS), mirrors TechnologyOntologyRepository. */
export class RoleOntologyRepository {
    constructor(private readonly pool: Pool) {}

    /** alias → family_key (lowercased), curated + learned. */
    async loadAliasMap(): Promise<Map<string, string>> {
        const { rows } = await this.pool.query<{ alias: string; family_key: string }>(
            `SELECT alias, family_key FROM role_aliases`,
        );
        const map = new Map<string, string>();
        for (const r of rows) map.set(r.alias.toLowerCase().trim(), r.family_key);
        return map;
    }

    /** Active families usable in grounding — curated + auto_imported only. */
    async loadFamilies(): Promise<RoleFamily[]> {
        const { rows } = await this.pool.query<FamilyRow>(
            `SELECT family_key, display_name, role_class, canonical_responsibilities, vocabulary, transferable_skills, industry_notes
               FROM role_ontology
              WHERE is_active = TRUE AND curation IN ('curated','auto_imported')`,
        );
        return rows.map((r) => ({
            familyKey: r.family_key, displayName: r.display_name, roleClass: r.role_class,
            canonicalResponsibilities: r.canonical_responsibilities ?? [], vocabulary: r.vocabulary ?? [],
            transferableSkills: r.transferable_skills ?? [], industryNotes: r.industry_notes ?? '',
        }));
    }

    /** Stage one learning vote (one per user via the UNIQUE constraint). */
    async stageCandidate(c: RoleLearningCandidate): Promise<void> {
        await this.pool.query(
            `INSERT INTO role_learning_candidates (family_key, candidate_type, value, contributing_user_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (family_key, candidate_type, value, contributing_user_id) DO NOTHING`,
            [c.familyKey, c.candidateType, c.value, c.contributingUserId],
        );
    }

    /** Bump usage telemetry for a matched family. */
    async incrementPopularity(familyKey: string): Promise<void> {
        await this.pool.query(`UPDATE role_ontology SET popularity_score = popularity_score + 1 WHERE family_key = $1`, [familyKey]);
    }

    /** Promote candidates corroborated by >= quorum distinct users to auto_imported. Idempotent. */
    async promote(quorum: number): Promise<void> {
        // aliases → role_aliases
        await this.pool.query(
            `INSERT INTO role_aliases (alias, family_key, curation, source)
             SELECT value, family_key, 'auto_imported', 'learned'
               FROM role_learning_candidates
              WHERE candidate_type = 'alias'
              GROUP BY value, family_key
             HAVING COUNT(DISTINCT contributing_user_id) >= $1
             ON CONFLICT (alias) DO NOTHING`,
            [quorum],
        );
        // vocabulary + transferable_skill → append to the family arrays if absent
        await this.pool.query(
            `UPDATE role_ontology o SET
                vocabulary          = CASE WHEN c.candidate_type = 'vocabulary' AND NOT (c.value = ANY(o.vocabulary))
                                           THEN array_append(o.vocabulary, c.value) ELSE o.vocabulary END,
                transferable_skills = CASE WHEN c.candidate_type = 'transferable_skill' AND NOT (c.value = ANY(o.transferable_skills))
                                           THEN array_append(o.transferable_skills, c.value) ELSE o.transferable_skills END,
                updated_at = now()
               FROM (
                 SELECT family_key, candidate_type, value
                   FROM role_learning_candidates
                  WHERE candidate_type IN ('vocabulary','transferable_skill')
                  GROUP BY family_key, candidate_type, value
                 HAVING COUNT(DISTINCT contributing_user_id) >= $1
               ) c
              WHERE o.family_key = c.family_key`,
            [quorum],
        );
    }
}
```

- [ ] **Step 5: Run test + build**

Run: `cd applications/shared && npx jest RoleOntologyRepository` → PASS (4). Then `npx tsc --build` → clean.

- [ ] **Step 6: Commit**

```bash
git add applications/shared/src/rds/types/role-ontology.ts applications/shared/src/rds/implementations/RoleOntologyRepository.ts applications/shared/src/rds/implementations/RoleOntologyRepository.test.ts
git commit -m "feat(rds): RoleOntologyRepository (alias map, families, stage, promote)"
```

---

## Task 3: Role classifier (Haiku forced-tool)

**Files:**
- Create: `applications/job-strategist/src/agents/role-classifier.ts`
- Test: `applications/job-strategist/src/agents/role-classifier.test.ts`

- [ ] **Step 1: Write the failing test**

Create `applications/job-strategist/src/agents/role-classifier.test.ts` (CJS `jest.mock`, like `recruiter-snapshot.test.ts`):

```ts
/** @format */
jest.mock('@bedrock/shared', () => ({ runAgent: jest.fn(), log: () => undefined }));
import { runAgent } from '@bedrock/shared';
import { classifyRole } from './role-classifier.js';

const KNOWN = ['technical-support', 'sre'];
const mockRun = runAgent as jest.Mock;

describe('classifyRole', () => {
    it('returns the classified family + suggestions when the model picks a known family', async () => {
        mockRun.mockResolvedValue({ data: { familyKey: 'technical-support', confidence: 0.9, suggestedVocabulary: ['SLA'], suggestedTransferableSkills: ['empathy'] } });
        const r = await classifyRole({ title: 'Support Rep', company: 'Acme', highlights: ['handled tickets'] }, KNOWN);
        expect(r).toEqual({ familyKey: 'technical-support', confidence: 0.9, suggestedVocabulary: ['SLA'], suggestedTransferableSkills: ['empathy'] });
    });

    it('returns null when the model returns an unknown family (caller falls back to Tavily)', async () => {
        mockRun.mockResolvedValue({ data: { familyKey: 'astronaut', confidence: 0.5, suggestedVocabulary: [], suggestedTransferableSkills: [] } });
        expect(await classifyRole({ title: 'Astronaut', company: 'NASA', highlights: [] }, KNOWN)).toBeNull();
    });

    it('returns null on agent error (fail-open)', async () => {
        mockRun.mockRejectedValue(new Error('bedrock down'));
        expect(await classifyRole({ title: 'X', company: 'Y', highlights: [] }, KNOWN)).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn test role-classifier` → FAIL (module not found).

- [ ] **Step 3: Implement the classifier**

Create `applications/job-strategist/src/agents/role-classifier.ts`:

```ts
/** @format */
import { z } from 'zod';
import { runAgent, log } from '@bedrock/shared';
import type { AgentConfig, BasePipelineContext } from '@bedrock/shared';

const MODEL_ID = process.env['ROLE_CLASSIFIER_MODEL'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

export interface RoleClassification {
    familyKey: string;
    confidence: number;
    suggestedVocabulary: string[];
    suggestedTransferableSkills: string[];
}

const ResultSchema = z.object({
    familyKey:                   z.string(),
    confidence:                  z.number().min(0).max(1),
    suggestedVocabulary:         z.array(z.string()).max(12).default([]),
    suggestedTransferableSkills: z.array(z.string()).max(12).default([]),
});

const TOOL = {
    name: 'classify_role',
    description: 'Classify a job title into a known role family and suggest domain vocabulary.',
    input_schema: {
        type: 'object',
        properties: {
            familyKey:                   { type: 'string', description: 'One of the provided known family keys, or your best new kebab-case key if none fit.' },
            confidence:                  { type: 'number', minimum: 0, maximum: 1 },
            suggestedVocabulary:         { type: 'array', items: { type: 'string' }, description: 'Domain terms this role implies, derived from the title/highlights.' },
            suggestedTransferableSkills: { type: 'array', items: { type: 'string' }, description: 'Transferable skills this role implies.' },
        },
        required: ['familyKey', 'confidence', 'suggestedVocabulary', 'suggestedTransferableSkills'],
        additionalProperties: false,
    },
} as const;

const CTX: BasePipelineContext = { pipelineId: 'role-classify', environment: process.env['DEPLOY_ENV'] ?? 'dev', cumulativeTokens: { input: 0, output: 0, thinking: 0 }, cumulativeCostUsd: 0 };

/**
 * Classify a role title into one of `knownFamilies`. FAIL-OPEN: returns null on
 * any error, and null when the model's family is NOT in knownFamilies (caller
 * then falls back to Tavily). The model reads the highlights, so per-user phrasing
 * informs the suggestions.
 */
export async function classifyRole(
    role: { title: string; company: string; highlights: string[] },
    knownFamilies: string[],
): Promise<RoleClassification | null> {
    const system = [
        'You classify a job title into a known role family. Call classify_role.',
        `Known families: ${knownFamilies.join(', ')}.`,
        '- Prefer a known family. Only invent a kebab-case key if none reasonably fit.',
        '- suggestedVocabulary/suggestedTransferableSkills: derive from the title + highlights provided; do not invent unrelated terms.',
    ].join('\n');
    const config: AgentConfig = {
        agentName: 'role-classifier', modelId: MODEL_ID, maxTokens: 512, thinkingBudget: 0,
        systemPrompt: [{ text: system }], pipeline: 'job-strategist',
        tool: { name: TOOL.name, description: TOOL.description, inputSchema: TOOL.input_schema as Record<string, unknown> },
    };
    const userMessage = `<role><title>${role.title}</title><company>${role.company}</company><highlights>${role.highlights.join(' | ')}</highlights></role>`;
    try {
        const result = await runAgent<RoleClassification>({
            config, userMessage, pipelineContext: CTX,
            parseResponse: (s) => {
                const v = ResultSchema.safeParse(JSON.parse(s));
                if (!v.success) throw new Error(`role-classifier: schema validation failed: ${v.error.message}`);
                return v.data;
            },
        });
        if (!knownFamilies.includes(result.data.familyKey)) return null;
        return result.data;
    } catch (e) {
        log('WARN', 'role classification failed (non-fatal)', { agent: 'role-classifier', error: e instanceof Error ? e.message : String(e) });
        return null;
    }
}
```

- [ ] **Step 4: Run test + commit**

Run: `cd applications/job-strategist && yarn test role-classifier` → PASS (3). `npx tsc --noEmit` → clean.
```bash
git add applications/job-strategist/src/agents/role-classifier.ts applications/job-strategist/src/agents/role-classifier.test.ts
git commit -m "feat(strategist): role classifier (Haiku forced-tool, fail-open)"
```

---

## Task 4: resolveRoleFamilies cascade

**Files:**
- Create: `applications/job-strategist/src/agents/resolve-role-families.ts`
- Test: `applications/job-strategist/src/agents/resolve-role-families.test.ts`

- [ ] **Step 1: Write the failing test**

Create `applications/job-strategist/src/agents/resolve-role-families.test.ts`:

```ts
/** @format */
jest.mock('./role-classifier.js', () => ({ classifyRole: jest.fn() }));
import type { Pool } from 'pg';
import { classifyRole } from './role-classifier.js';
import { resolveRoleFamilies } from './resolve-role-families.js';
import { RoleOntologyRepository } from '@bedrock/shared';

const FAM = { familyKey: 'technical-support', displayName: 'Technical Support', roleClass: 'customer_facing', canonicalResponsibilities: ['Triage queues'], vocabulary: ['SLA'], transferableSkills: ['empathy'], industryNotes: 'AWS≈SaaS' };

function repoStub(over: Partial<RoleOntologyRepository> = {}): RoleOntologyRepository {
    return {
        loadAliasMap: jest.fn().mockResolvedValue(new Map([['technical customer service associate', 'technical-support']])),
        loadFamilies: jest.fn().mockResolvedValue([FAM]),
        stageCandidate: jest.fn().mockResolvedValue(undefined),
        incrementPopularity: jest.fn().mockResolvedValue(undefined),
        promote: jest.fn().mockResolvedValue(undefined),
        ...over,
    } as unknown as RoleOntologyRepository;
}

const pool = {} as Pool;

describe('resolveRoleFamilies', () => {
    it('alias hit → returns the matched family + bumps popularity (no classifier call)', async () => {
        const repo = repoStub();
        const res = await resolveRoleFamilies(pool, 'u-1', [{ title: 'Technical Customer Service Associate', company: 'AWS', highlights: ['triaged IAM'] }], repo);
        expect(res[0].family?.familyKey).toBe('technical-support');
        expect(repo.incrementPopularity).toHaveBeenCalledWith('technical-support');
        expect(classifyRole).not.toHaveBeenCalled();
    });

    it('miss → classifier hit → stages alias + vocab candidates and returns the family', async () => {
        (classifyRole as jest.Mock).mockResolvedValue({ familyKey: 'technical-support', confidence: 0.9, suggestedVocabulary: ['queue'], suggestedTransferableSkills: ['triage'] });
        const repo = repoStub({ loadAliasMap: jest.fn().mockResolvedValue(new Map()) });
        const res = await resolveRoleFamilies(pool, 'u-1', [{ title: 'Cust Svc Rep', company: 'AWS', highlights: ['tickets'] }], repo);
        expect(res[0].family?.familyKey).toBe('technical-support');
        expect(repo.stageCandidate).toHaveBeenCalledWith(expect.objectContaining({ candidateType: 'alias', value: 'cust svc rep' }));
        expect(repo.stageCandidate).toHaveBeenCalledWith(expect.objectContaining({ candidateType: 'vocabulary', value: 'queue' }));
    });

    it('miss + classifier null → returns null family (fail-open, no throw)', async () => {
        (classifyRole as jest.Mock).mockResolvedValue(null);
        const repo = repoStub({ loadAliasMap: jest.fn().mockResolvedValue(new Map()) });
        const res = await resolveRoleFamilies(pool, 'u-1', [{ title: 'Astronaut', company: 'NASA', highlights: [] }], repo);
        expect(res[0].family).toBeNull();
    });

    it('calls promote with the quorum at the end', async () => {
        const repo = repoStub();
        await resolveRoleFamilies(pool, 'u-1', [{ title: 'Technical Customer Service Associate', company: 'AWS', highlights: [] }], repo);
        expect(repo.promote).toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn test resolve-role-families` → FAIL. (Note: `RoleOntologyRepository` must be exported from `@bedrock/shared` — see Step 3a.)

- [ ] **Step 3a: Export the repository from shared**

In `applications/shared/src/index.ts`, add (next to other rds exports):
```ts
export { RoleOntologyRepository } from './rds/implementations/RoleOntologyRepository.js';
export type { RoleFamily, RoleClass, RoleCandidateType, RoleLearningCandidate } from './rds/types/role-ontology.js';
```
Then `cd applications/shared && npx tsc --build`.

- [ ] **Step 3b: Implement the cascade**

Create `applications/job-strategist/src/agents/resolve-role-families.ts`:

```ts
/** @format */
import type { Pool } from 'pg';
import { RoleOntologyRepository, log } from '@bedrock/shared';
import type { RoleFamily } from '@bedrock/shared';
import { classifyRole } from './role-classifier.js';

const QUORUM = Number(process.env['ROLE_LEARNING_QUORUM'] ?? '3');

export interface ResolvedRole {
    title:   string;
    company: string;
    family:  RoleFamily | null;
    matchVia: 'alias' | 'classifier' | 'none';
}

function normaliseTitle(t: string): string { return t.toLowerCase().trim(); }

/** Match a title against the alias map by exact + substring containment. */
function aliasLookup(title: string, aliasMap: Map<string, string>): string | null {
    const n = normaliseTitle(title);
    if (aliasMap.has(n)) return aliasMap.get(n) ?? null;
    for (const [alias, family] of aliasMap) if (n.includes(alias)) return family;
    return null;
}

/**
 * Resolve each experience to a role family via the cascade (alias → classifier),
 * staging learning candidates + promoting on quorum. FAIL-OPEN per entry: a null
 * family on any error. (Tavily family-discovery is the documented Phase-2 last
 * resort and is intentionally not wired here; classifier-miss yields null.)
 */
export async function resolveRoleFamilies(
    pool: Pool,
    userId: string,
    experiences: Array<{ title: string; company: string; highlights: string[] }>,
    repo: RoleOntologyRepository = new RoleOntologyRepository(pool),
): Promise<ResolvedRole[]> {
    let aliasMap: Map<string, string>;
    let families: RoleFamily[];
    try {
        [aliasMap, families] = await Promise.all([repo.loadAliasMap(), repo.loadFamilies()]);
    } catch (e) {
        log('WARN', 'role ontology load failed (non-fatal)', { error: e instanceof Error ? e.message : String(e) });
        return experiences.map((x) => ({ title: x.title, company: x.company, family: null, matchVia: 'none' }));
    }
    const byKey = new Map(families.map((f) => [f.familyKey, f]));
    const knownKeys = families.map((f) => f.familyKey);

    const out: ResolvedRole[] = [];
    for (const x of experiences) {
        try {
            const aliasHit = aliasLookup(x.title, aliasMap);
            if (aliasHit && byKey.has(aliasHit)) {
                await repo.incrementPopularity(aliasHit);
                out.push({ title: x.title, company: x.company, family: byKey.get(aliasHit) ?? null, matchVia: 'alias' });
                continue;
            }
            const cls = await classifyRole({ title: x.title, company: x.company, highlights: x.highlights }, knownKeys);
            if (cls && byKey.has(cls.familyKey)) {
                await repo.stageCandidate({ familyKey: cls.familyKey, candidateType: 'alias', value: normaliseTitle(x.title), contributingUserId: userId });
                for (const v of cls.suggestedVocabulary) await repo.stageCandidate({ familyKey: cls.familyKey, candidateType: 'vocabulary', value: v, contributingUserId: userId });
                for (const s of cls.suggestedTransferableSkills) await repo.stageCandidate({ familyKey: cls.familyKey, candidateType: 'transferable_skill', value: s, contributingUserId: userId });
                await repo.incrementPopularity(cls.familyKey);
                out.push({ title: x.title, company: x.company, family: byKey.get(cls.familyKey) ?? null, matchVia: 'classifier' });
                continue;
            }
            out.push({ title: x.title, company: x.company, family: null, matchVia: 'none' });
        } catch (e) {
            log('WARN', 'role resolve failed for entry (non-fatal)', { title: x.title, error: e instanceof Error ? e.message : String(e) });
            out.push({ title: x.title, company: x.company, family: null, matchVia: 'none' });
        }
    }
    await repo.promote(QUORUM).catch(() => undefined);
    return out;
}
```

- [ ] **Step 4: Run test + commit**

Run: `cd applications/job-strategist && yarn test resolve-role-families` → PASS (4). `npx tsc --noEmit` → clean.
```bash
git add applications/shared/src/index.ts applications/job-strategist/src/agents/resolve-role-families.ts applications/job-strategist/src/agents/resolve-role-families.test.ts
git commit -m "feat(strategist): resolveRoleFamilies cascade (alias→classifier, learn+promote)"
```

---

## Task 5: roleEvidenceBlock formatter

**Files:**
- Create: `applications/job-strategist/src/agents/role-evidence-block.ts`
- Test: `applications/job-strategist/src/agents/role-evidence-block.test.ts`

- [ ] **Step 1: Write the failing test**

Create `applications/job-strategist/src/agents/role-evidence-block.test.ts`:

```ts
/** @format */
import { formatRoleEvidence } from './role-evidence-block.js';
import type { ResolvedRole } from './resolve-role-families.js';

const resolved: ResolvedRole[] = [
    { title: 'Technical Customer Service Associate', company: 'AWS', matchVia: 'alias',
      family: { familyKey: 'technical-support', displayName: 'Technical Support', roleClass: 'customer_facing',
                canonicalResponsibilities: ['Triage queues to SLA'], vocabulary: ['SLA', 'on-call'], transferableSkills: ['customer empathy'], industryNotes: 'AWS support ≈ SaaS support.' } },
    { title: 'Mystery Role', company: 'X', matchVia: 'none', family: null },
];

describe('formatRoleEvidence', () => {
    it('emits a TRANSLATE-framed block with vocabulary, transferable skills, and the industry note', () => {
        const block = formatRoleEvidence(resolved);
        expect(block).toMatch(/TRANSLATE/);
        expect(block).toContain('Technical Customer Service Associate @ AWS');
        expect(block).toContain('SLA');
        expect(block).toContain('customer empathy');
        expect(block).toContain('AWS support ≈ SaaS support.');
    });
    it('skips entries with no family and returns "" when none matched', () => {
        expect(formatRoleEvidence([{ title: 'X', company: 'Y', matchVia: 'none', family: null }])).toBe('');
        expect(formatRoleEvidence(resolved)).not.toContain('Mystery Role');
    });
});
```

- [ ] **Step 2: Run test to verify it fails** → `cd applications/job-strategist && yarn test role-evidence-block` → FAIL.

- [ ] **Step 3: Implement the formatter**

Create `applications/job-strategist/src/agents/role-evidence-block.ts`:

```ts
/** @format */
import type { ResolvedRole } from './resolve-role-families.js';

const HEADER = [
    'ROLE EVIDENCE — use to TRANSLATE the candidate\'s real work into the target',
    'role\'s vocabulary. You may surface a term ONLY when a highlight demonstrates it;',
    'never claim a responsibility the highlights don\'t support, and never name or',
    'apologise for any gap.',
].join('\n');

/** Format matched role families into a grounding block (sibling of projectEvidenceBlock). */
export function formatRoleEvidence(resolved: ResolvedRole[]): string {
    const matched = resolved.filter((r) => r.family !== null);
    if (matched.length === 0) return '';
    const lines: string[] = [HEADER];
    for (const r of matched) {
        const f = r.family!;
        lines.push(
            `- ${r.title} @ ${r.company}  [${f.roleClass}]`,
            `  transferable: ${f.transferableSkills.join(', ')}`,
            `  vocabulary: ${f.vocabulary.join(', ')}`,
        );
        if (f.industryNotes) lines.push(`  note: ${f.industryNotes}`);
    }
    return lines.join('\n');
}
```
NOTE: `r.family!` is safe here — the array is filtered to non-null `family` on the line above; the non-null assertion is load-bearing (TS can't narrow across `.filter`). This is an accepted SonarLint exception per the project's verification-discipline note.

- [ ] **Step 4: Run test + commit**

Run: `cd applications/job-strategist && yarn test role-evidence-block` → PASS (2). `npx tsc --noEmit` → clean.
```bash
git add applications/job-strategist/src/agents/role-evidence-block.ts applications/job-strategist/src/agents/role-evidence-block.test.ts
git commit -m "feat(strategist): roleEvidenceBlock formatter (translate-framed grounding)"
```

---

## Task 6: Wire into run-pipeline + research/strategist signatures

**Files:**
- Modify: `applications/job-strategist/src/agents/research-agent.ts` (signature)
- Modify: `applications/job-strategist/src/agents/strategist-agent.ts` (signature + input)
- Modify: `applications/job-strategist/src/run-pipeline.ts` (load + pass)

- [ ] **Step 1: Add `roleEvidenceBlock` param to both agents**

In `research-agent.ts`, the `executeResearchAgent` signature — append a last param:
```ts
    careerEntries: CareerEntry[] | null = null,
    roleEvidenceBlock = '',
): Promise<AgentResult<StrategistResearchResult>> {
```
Use it where the research user-message is assembled — append a section when non-empty (find where `projectEvidenceBlock` is injected into the message and add an adjacent block):
```ts
        ...(roleEvidenceBlock ? ['', roleEvidenceBlock] : []),
```
(Match the existing message-assembly style; if `projectEvidenceBlock` is concatenated differently, mirror that exact mechanism.)

In `strategist-agent.ts`, `executeStrategistAgent` — append `roleEvidenceBlock = ''` as the last param and forward it into the agent input object (where `projectEvidence`/`educationFacts`/`experienceFacts` are passed):
```ts
): Promise<AgentResult<StrategistAnalysisResult>> {
    // ...
    const input: StrategistAgentInput = { research, projectEvidence, educationFacts, experienceFacts, roleEvidence: roleEvidenceBlock };
```
Add `readonly roleEvidence?: string;` to the `StrategistAgentInput` interface, and inject it into the strategist user message next to `experienceFacts` (mirror that block's injection).

- [ ] **Step 2: Load + pass in run-pipeline**

In `run-pipeline.ts`, add the import:
```ts
import { resolveRoleFamilies } from './agents/resolve-role-families.js';
import { formatRoleEvidence } from './agents/role-evidence-block.js';
```
In the parallel `Promise.all` loads block, after `careerEntries` is available, build the role evidence. Because role resolution needs `careerEntries`, do it right after the `Promise.all` (careerEntries is already destructured there):
```ts
        // Role-ontology grounding — translate experience into target-role vocabulary. Fail-open.
        const roleEvidenceBlock = formatRoleEvidence(
            await resolveRoleFamilies(
                pool, ctx.userId,
                careerEntries.map((c) => ({ title: c.title, company: c.company, highlights: c.highlights })),
            ).catch(() => []),
        );
```
(`careerEntries` items have `title`/`company`/`highlights` per `CareerEntry`. If a field name differs, adjust the mapping to the actual `CareerEntry` shape.)

Then thread it into both calls:
```ts
        const research  = await executeResearchAgent(ctx, pool, projectEvidenceBlock, educationBlock, jdExtraction, careerEntries, roleEvidenceBlock);
        // ...
        const analysis  = await executeStrategistAgent(ctx, research.data, projectEvidenceBlock, educationBlock, experienceFactsBlock, roleEvidenceBlock);
```

- [ ] **Step 3: Typecheck + full suite**

Run: `cd applications/shared && npx tsc --build && cd ../job-strategist && npx tsc --noEmit && yarn test` → tsc clean; all suites pass (note any PRE-EXISTING `parse-back` ESM flake, not newly broken).

- [ ] **Step 4: Commit**

```bash
git add applications/job-strategist/src/agents/research-agent.ts applications/job-strategist/src/agents/strategist-agent.ts applications/job-strategist/src/run-pipeline.ts
git commit -m "feat(strategist): wire roleEvidenceBlock into research + strategist"
```

---

## Task 7: Support archetype 7 + persona rules

**Files:**
- Modify: `applications/shared/src/strategist-types.ts` (`ArchetypeId`)
- Modify: `applications/job-strategist/src/agents/strategist-agent.ts` (`extractArchetypeSelection` clamp)
- Modify: `applications/job-strategist/src/prompts/strategist-persona.ts` (archetype 7 + rules)
- Test: `applications/job-strategist/src/agents/strategist-tailored-resume.test.ts` (clamp regression) — or the existing archetype test file

- [ ] **Step 1: Extend `ArchetypeId`**

In `applications/shared/src/strategist-types.ts` line ~451:
```ts
export type ArchetypeId = 1 | 2 | 3 | 4 | 5 | 6 | 7;
```
Then `cd applications/shared && npx tsc --build`.

- [ ] **Step 2: Failing test for the clamp**

In `applications/job-strategist/src/agents/strategist-tailored-resume.test.ts` (or wherever `extractArchetypeSelection` is unit-tested — grep `extractArchetypeSelection`), add a case asserting an archetype_id of `7` in the XML is accepted (not clamped to 1). If `extractArchetypeSelection` is not exported, add a regression at the analysis-extraction layer that feeds a `<phase_0_archetype_selection><archetype_id>7</archetype_id>...` block and asserts `archetypeId === 7`. Run it → FAIL (clamps to 1).

- [ ] **Step 3: Extend the clamp**

In `applications/job-strategist/src/agents/strategist-agent.ts` (`extractArchetypeSelection`, ~line 460):
```ts
    const archetypeId: ArchetypeId = ([1, 2, 3, 4, 5, 6, 7].includes(archetypeIdRaw)
        ? archetypeIdRaw
        : 1) as ArchetypeId;
```

- [ ] **Step 4: Add archetype 7 + rules to the persona**

In `applications/job-strategist/src/prompts/strategist-persona.ts`, after the Archetype 6 trigger lines (~229), append:
```ts
`   - "support", "customer service", "SLA", "on-call", "escalations", "queue",`,
`     "ticketing", "customer success", "technical account", "education on the use of our platforms"`,
`     → Archetype 7 (Technical Support / Customer Engineering)`,
```
And wherever the persona documents each archetype's `leadIdentity` / `excludedContentCategories` / `sectionOrder` (grep the archetype detail block), add an Archetype 7 entry: lead identity = a support-engineer-who-ships-production-systems framing; section order leads with customer-impact + reliability + the production/AI proof, work history beneath. Also add two global rules near the resume-generation rules:
```ts
`- TRANSLATE, DON'T INVENT: when ROLE EVIDENCE is present, use its transferable-skills`,
`  and vocabulary to relabel the candidate's actual highlights into the target domain.`,
`  Surface a vocabulary term ONLY when a highlight demonstrates it.`,
`- NEVER name, explain, or apologise for missing experience in the resume or cover letter.`,
```

- [ ] **Step 5: Run test + full suite + commit**

Run: `cd applications/job-strategist && npx tsc --noEmit && yarn test` → clamp test passes, full suite green.
```bash
git add applications/shared/src/strategist-types.ts applications/job-strategist/src/agents/strategist-agent.ts applications/job-strategist/src/prompts/strategist-persona.ts applications/job-strategist/src/agents/strategist-tailored-resume.test.ts
git commit -m "feat(strategist): add Technical Support archetype 7 + translate/never-name-gap rules"
git push -u origin feat/role-ontology
```

- [ ] **Step 6: Open the PR** (controller does this via gh/MCP)

PR `feat/role-ontology` → `develop`, title `feat(strategist): self-improving role ontology + experience grounding + support archetype`.

---

## Task 8: Migration 073 — scalability schema (A+C) + seed expansion (B)

**Files:** Create `applications/platform-rds-bootstrap/migrations/073_role_ontology_scale.sql`

- [ ] **Step 1: Write the migration** (idempotent, no BEGIN/COMMIT, like 072):

```sql
-- =============================================================================
-- Migration 073 — role_ontology scalability: new-family votes, company-type
-- overlay, and curated-seed expansion (to ~20 families). Idempotent.
-- =============================================================================

-- A: allow 'family' learning votes (extend the CHECK; DROP+ADD is idempotent)
ALTER TABLE role_learning_candidates
  DROP CONSTRAINT IF EXISTS role_learning_candidates_candidate_type_check,
  ADD  CONSTRAINT role_learning_candidates_candidate_type_check
       CHECK (candidate_type IN ('alias','vocabulary','transferable_skill','family'));

-- C: company-type enum + framing overlay
DO $$ BEGIN
  CREATE TYPE company_type_enum AS ENUM ('saas','infra_provider','fintech','hardware','agency','enterprise','marketplace','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS company_type_framing (
  company_type company_type_enum PRIMARY KEY,
  framing_note TEXT NOT NULL DEFAULT ''
);
INSERT INTO company_type_framing (company_type, framing_note) VALUES
('saas',           'Subscription product — frame work around customers, subscriptions, churn/expansion, and a customer-success motion.'),
('infra_provider', 'Operates like SaaS — paying customers, subscriptions, account health; frame infrastructure-provider work as customer-facing SaaS.'),
('fintech',        'Regulated financial product — frame work around compliance, reliability, security, and customer trust.'),
('hardware',       'Hardware/device company — frame support around RMA, firmware, supply chain, and field reliability.'),
('agency',         'Services/agency — frame work around client delivery, multiple accounts, and billable outcomes.'),
('enterprise',     'Large enterprise — frame work around scale, governance, stakeholder management, and process.'),
('marketplace',    'Two-sided marketplace — frame work around supply/demand, trust & safety, and growth loops.'),
('other',          '')
ON CONFLICT (company_type) DO NOTHING;

-- C: move the AWS-specific note out of the family (now company-type-driven)
UPDATE role_ontology SET industry_notes = '' WHERE family_key = 'technical-support';

-- B: expand the curated seed (~15 more families)
INSERT INTO role_ontology (family_key, display_name, role_class, canonical_responsibilities, vocabulary, transferable_skills, industry_notes, source) VALUES
('product-management','Product Manager','hybrid',
 ARRAY['Define product strategy and roadmap','Prioritise based on user + business value','Coordinate engineering, design, and GTM','Measure outcomes with metrics'],
 ARRAY['roadmap','prioritisation','user research','metrics','stakeholder','OKRs','discovery','go-to-market'],
 ARRAY['prioritisation','communication','data-driven decisions','cross-functional leadership'],'', 'seed-073'),
('data-science','Data Scientist','builder',
 ARRAY['Frame business problems as data problems','Build models and run experiments','Communicate insights to stakeholders'],
 ARRAY['statistics','machine learning','experimentation','A/B testing','Python','SQL','modelling','inference'],
 ARRAY['analytical thinking','experimentation','communication','statistical rigour'],'', 'seed-073'),
('ml-engineering','Machine Learning Engineer','builder',
 ARRAY['Productionise ML models and pipelines','Serve and monitor models at scale','Build training/inference infrastructure'],
 ARRAY['MLOps','model serving','feature store','training pipeline','inference','GPU','LLM','RAG','vector'],
 ARRAY['systems design','ML fundamentals','automation','debugging'],'', 'seed-073'),
('data-engineering','Data Engineer','builder',
 ARRAY['Build and operate data pipelines','Model warehouses and own data quality','Enable analytics and ML on reliable data'],
 ARRAY['ETL','ELT','warehouse','pipeline','dbt','Airflow','streaming','data quality','SQL'],
 ARRAY['data modelling','pipeline reliability','SQL','systems thinking'],'', 'seed-073'),
('security-engineering','Security Engineer','ops',
 ARRAY['Identify and remediate security risks','Run incident response and threat detection','Build security tooling and guardrails'],
 ARRAY['threat detection','incident response','IAM','vulnerability','SIEM','zero trust','compliance','encryption'],
 ARRAY['risk analysis','incident response','attention to detail','systems thinking'],'', 'seed-073'),
('solutions-engineering','Solutions / Sales Engineer','customer_facing',
 ARRAY['Partner with sales on technical wins','Run demos, POCs, and architecture sessions','Translate customer needs to product + back'],
 ARRAY['POC','demo','pre-sales','architecture','customer requirements','technical win','cross-functional','enablement'],
 ARRAY['technical communication','customer empathy','stakeholder management','problem framing'],'', 'seed-073'),
('ux-design','Product / UX Designer','hybrid',
 ARRAY['Design user flows and interfaces','Run user research and usability testing','Partner with product + engineering'],
 ARRAY['user research','wireframe','prototype','usability','design system','accessibility','Figma'],
 ARRAY['user empathy','visual communication','research','cross-functional collaboration'],'', 'seed-073'),
('devrel','Developer Relations / Advocate','customer_facing',
 ARRAY['Educate and grow a developer community','Build samples, docs, and talks','Feed developer feedback to product'],
 ARRAY['community','documentation','developer experience','content','enablement','advocacy','API'],
 ARRAY['technical communication','community building','empathy','content creation'],'', 'seed-073'),
('engineering-management','Engineering Manager','hybrid',
 ARRAY['Lead and grow an engineering team','Own delivery and technical direction','Coach, hire, and manage performance'],
 ARRAY['people management','delivery','hiring','coaching','roadmap','1:1s','team health'],
 ARRAY['leadership','communication','coaching','prioritisation'],'', 'seed-073'),
('program-management','Technical Program Manager','hybrid',
 ARRAY['Drive cross-team programs to delivery','Manage dependencies, risks, and timelines','Communicate status to stakeholders'],
 ARRAY['program management','dependencies','risk','timeline','stakeholder','cross-functional','delivery'],
 ARRAY['organisation','cross-functional leadership','risk management','communication'],'', 'seed-073'),
('customer-success','Customer Success Manager','customer_facing',
 ARRAY['Own customer outcomes and renewals','Drive adoption and reduce churn','Advocate for customers internally'],
 ARRAY['adoption','renewal','churn','onboarding','QBR','account health','expansion','customer outcomes'],
 ARRAY['relationship management','customer empathy','data-driven','communication'],'', 'seed-073'),
('technical-writing','Technical Writer','customer_facing',
 ARRAY['Write and maintain product documentation','Make complex systems understandable','Partner with engineering + support'],
 ARRAY['documentation','API docs','tutorials','information architecture','content','enablement'],
 ARRAY['clear writing','technical communication','empathy','attention to detail'],'', 'seed-073'),
('mobile-engineering','Mobile Engineer','builder',
 ARRAY['Build and ship mobile apps','Optimise performance and UX on device','Integrate with backend services'],
 ARRAY['iOS','Android','Swift','Kotlin','React Native','mobile','app store','performance'],
 ARRAY['product sense','debugging','UX awareness','collaboration'],'', 'seed-073'),
('marketing','Marketing','hybrid',
 ARRAY['Drive awareness and demand','Run campaigns and measure funnel','Position the product to the market'],
 ARRAY['campaign','funnel','positioning','content','SEO','demand gen','brand','analytics'],
 ARRAY['communication','data-driven','creativity','positioning'],'', 'seed-073'),
('business-analyst','Business / Data Analyst','hybrid',
 ARRAY['Turn data into business decisions','Build dashboards and reports','Partner with stakeholders on requirements'],
 ARRAY['SQL','dashboards','reporting','requirements','KPIs','analytics','stakeholder'],
 ARRAY['analytical thinking','communication','requirements gathering','data fluency'],'', 'seed-073')
ON CONFLICT (family_key) DO NOTHING;

INSERT INTO role_aliases (alias, family_key) VALUES
('product manager','product-management'),('product owner','product-management'),
('data scientist','data-science'),('machine learning scientist','data-science'),
('machine learning engineer','ml-engineering'),('ml engineer','ml-engineering'),('ai engineer','ml-engineering'),
('data engineer','data-engineering'),
('security engineer','security-engineering'),('security analyst','security-engineering'),
('solutions engineer','solutions-engineering'),('sales engineer','solutions-engineering'),('solutions architect','solutions-engineering'),
('product designer','ux-design'),('ux designer','ux-design'),('ui designer','ux-design'),
('developer advocate','devrel'),('developer relations','devrel'),
('engineering manager','engineering-management'),('team lead','engineering-management'),
('technical program manager','program-management'),('program manager','program-management'),('project manager','program-management'),
('customer success manager','customer-success'),('account manager','customer-success'),
('technical writer','technical-writing'),
('mobile engineer','mobile-engineering'),('ios engineer','mobile-engineering'),('android engineer','mobile-engineering'),
('marketing manager','marketing'),('growth marketer','marketing'),
('business analyst','business-analyst'),('data analyst','business-analyst')
ON CONFLICT (alias) DO NOTHING;

-- Verification: SELECT count(*) FROM role_ontology;  SELECT * FROM company_type_framing;
```

- [ ] **Step 2: Validate structure** (vs 072), **Step 3: Commit**
```bash
git add applications/platform-rds-bootstrap/migrations/073_role_ontology_scale.sql
git commit -m "feat(rds): migration 073 — family votes, company-type overlay, seed expansion"
```

---

## Task 9: Repository extensions (candidate families, company framing, family promote)

**Files:** Modify `applications/shared/src/rds/types/role-ontology.ts`, `applications/shared/src/rds/implementations/RoleOntologyRepository.ts` + its `.test.ts`.

- [ ] **Step 1: Extend the types.** In `role-ontology.ts`:
  - Add `'family'` to `RoleCandidateType`: `export type RoleCandidateType = 'alias' | 'vocabulary' | 'transferable_skill' | 'family';`
  - Add: `export type CompanyType = 'saas'|'infra_provider'|'fintech'|'hardware'|'agency'|'enterprise'|'marketplace'|'other';`
  - Add: `export interface NewFamily { familyKey: string; displayName: string; roleClass: RoleClass; canonicalResponsibilities: string[]; vocabulary: string[]; transferableSkills: string[]; }`

- [ ] **Step 2: Failing tests** (append to `RoleOntologyRepository.test.ts`, same `mockPool` helper): 
  - `loadAllFamilyKeys` → `SELECT family_key FROM role_ontology WHERE is_active = TRUE` (no curation filter) → returns the keys.
  - `insertCandidateFamily(f)` → `INSERT INTO role_ontology (...) VALUES (...,'candidate','seed-learned') ON CONFLICT (family_key) DO NOTHING` with the family fields as params.
  - `loadCompanyFraming` → `SELECT company_type, framing_note FROM company_type_framing` → `Map`.
  - `promote(3, 5)` runs a THIRD query promoting candidate families (`UPDATE role_ontology SET curation='auto_imported' ... candidate_type='family' ... HAVING COUNT(DISTINCT contributing_user_id) >= $1` with param `5`).
  Run → FAIL.

- [ ] **Step 3: Implement.** Add to `RoleOntologyRepository`:
```ts
import type { RoleFamily, RoleLearningCandidate, NewFamily, CompanyType } from '../types/role-ontology.js';

    /** ALL family keys (curated+auto_imported+candidate) — feeds the classifier for convergence. */
    async loadAllFamilyKeys(): Promise<string[]> {
        const { rows } = await this.pool.query<{ family_key: string }>(
            `SELECT family_key FROM role_ontology WHERE is_active = TRUE`,
        );
        return rows.map((r) => r.family_key);
    }

    /** Insert a classifier-proposed novel family as a 'candidate' (not grounded until promoted). */
    async insertCandidateFamily(f: NewFamily): Promise<void> {
        await this.pool.query(
            `INSERT INTO role_ontology (family_key, display_name, role_class, canonical_responsibilities, vocabulary, transferable_skills, curation, source)
             VALUES ($1,$2,$3,$4,$5,$6,'candidate','classifier-learned')
             ON CONFLICT (family_key) DO NOTHING`,
            [f.familyKey, f.displayName, f.roleClass, f.canonicalResponsibilities, f.vocabulary, f.transferableSkills],
        );
    }

    /** company_type → framing note. */
    async loadCompanyFraming(): Promise<Map<CompanyType, string>> {
        const { rows } = await this.pool.query<{ company_type: CompanyType; framing_note: string }>(
            `SELECT company_type, framing_note FROM company_type_framing`,
        );
        const m = new Map<CompanyType, string>();
        for (const r of rows) m.set(r.company_type, r.framing_note);
        return m;
    }
```
Change `promote` signature to `promote(aliasQuorum: number, familyQuorum: number): Promise<void>` (use `aliasQuorum` for the existing two queries) and append a third query:
```ts
        // promote candidate FAMILIES to auto_imported on >= familyQuorum distinct users
        await this.pool.query(
            `UPDATE role_ontology SET curation = 'auto_imported', updated_at = now()
              WHERE curation = 'candidate' AND family_key IN (
                SELECT value FROM role_learning_candidates
                 WHERE candidate_type = 'family'
                 GROUP BY value
                HAVING COUNT(DISTINCT contributing_user_id) >= $1)`,
            [familyQuorum],
        );
```

- [ ] **Step 4:** `cd applications/shared && npx jest RoleOntologyRepository` → all pass; `npx tsc --build` clean. Commit:
```bash
git add applications/shared/src/rds/types/role-ontology.ts applications/shared/src/rds/implementations/RoleOntologyRepository.ts applications/shared/src/rds/implementations/RoleOntologyRepository.test.ts
git commit -m "feat(rds): candidate families, company framing, family promotion"
```
(Export `NewFamily`, `CompanyType` from `applications/shared/src/index.ts` alongside the existing role-ontology type exports.)

---

## Task 10: Classifier extensions (company type + novel family payload + candidate convergence)

**Files:** Modify `applications/job-strategist/src/agents/role-classifier.ts` + `.test.ts`.

- [ ] **Step 1: Failing tests** (append): the classifier now returns `companyType` and an optional `newFamily`; a model that returns a family NOT in knownFamilies is allowed ONLY if it includes a `newFamily` payload (else null). Cases: known family + companyType; novel family with payload → returned; novel family WITHOUT payload → null; error → null. Run → FAIL.

- [ ] **Step 2: Implement.** Extend `RoleClassification`:
```ts
export interface RoleClassification {
    familyKey: string;
    confidence: number;
    companyType: CompanyType;           // NEW
    suggestedVocabulary: string[];
    suggestedTransferableSkills: string[];
    newFamily?: NewFamily;              // NEW — present only when proposing a novel family
}
```
Import `CompanyType, NewFamily` from `@bedrock/shared`. Extend `ResultSchema` (zod): `companyType: z.enum(['saas','infra_provider','fintech','hardware','agency','enterprise','marketplace','other'])`, `newFamily: z.object({ familyKey: z.string(), displayName: z.string(), roleClass: z.enum(['customer_facing','builder','ops','hybrid']), canonicalResponsibilities: z.array(z.string()).default([]), vocabulary: z.array(z.string()).default([]), transferableSkills: z.array(z.string()).default([]) }).optional()`. Add both to the tool `input_schema.properties` (companyType required; newFamily optional, with `additionalProperties:false`). Update the system prompt: "infer companyType from the company; pick an existing family (incl. candidate) if one fits; only when NONE fits, return a new family in `newFamily` with a kebab-case `familyKey`." 
Change the post-call guard so a novel family is accepted when accompanied by a payload:
```ts
        const d = result.data;
        if (!knownFamilies.includes(d.familyKey) && !d.newFamily) return null;
        return d;
```

- [ ] **Step 3:** `yarn test role-classifier` → pass; `npx tsc --noEmit` clean. Commit `feat(strategist): classifier infers company type + proposes novel families`.

---

## Task 11: Cascade + grounding overlay + pipeline (the integration)

**Files:** Modify `resolve-role-families.ts` + `.test.ts`, `role-evidence-block.ts` + `.test.ts`, `run-pipeline.ts`.

- [ ] **Step 1: resolve cascade.** `ResolvedRole` gains `companyType?: CompanyType`. In `resolveRoleFamilies`:
  - load `knownKeys = await repo.loadAllFamilyKeys()` (NOT just grounded families) for the classifier; keep `byKey` from `loadFamilies()` (grounded only) for grounding.
  - classifier hit in `byKey` (grounded) → ground + stage alias/vocab/skill candidates (as today) + set `companyType`.
  - classifier hit NOT in `byKey` but in `knownKeys` (a candidate family) → `stageCandidate({candidateType:'family', value: familyKey, ...})` (a vote); family stays null (not grounded yet); set companyType.
  - classifier returns `newFamily` (novel) → `repo.insertCandidateFamily(newFamily)` + `stageCandidate({candidateType:'family', value: newFamily.familyKey, ...})`; family null; companyType set.
  - `promote(ALIAS_QUORUM, FAMILY_QUORUM)` at the end (`ROLE_LEARNING_QUORUM` default 3, `ROLE_FAMILY_QUORUM` default 5).
  Tests: candidate-family path stages a 'family' vote (not grounded); novel path calls `insertCandidateFamily` + stages vote; companyType threaded.

- [ ] **Step 2: grounding overlay.** `formatRoleEvidence(resolved, companyFraming: Map<CompanyType,string>)` — for each matched role, after the family lines, append `  note: ${companyFraming.get(r.companyType) || family.industryNotes}` when non-empty (company-type framing replaces/supplements the family note). Test: an `infra_provider` role emits the SaaS framing note.

- [ ] **Step 3: run-pipeline.** Load the framing map once and pass it: build a `RoleOntologyRepository` (or reuse), `const companyFraming = await repo.loadCompanyFraming().catch(() => new Map())`, pass the same `repo` into `resolveRoleFamilies(pool, userId, exps, repo)`, then `formatRoleEvidence(resolved, companyFraming)`. Keep fail-open.

- [ ] **Step 4:** `cd applications/shared && npx tsc --build && cd ../job-strategist && npx tsc --noEmit && yarn test` → all green. Commit `feat(strategist): wire candidate-family discovery + company-type grounding overlay`, then `git push origin feat/role-ontology` (updates PR #179).

---

## Deploy + verify

1. Migrations 072 + 073 apply at platform-rds bootstrap (verify the verification SELECTs).
2. ai-applications PR → `develop` → build → SSM → job-strategist.
3. Re-run a JB for the test user → the `roleEvidenceBlock` supplies the `technical-support` family (alias hit on "Technical Customer Service Associate") → the resume should now surface SLA/on-call/customer-relationship/cross-functional vocabulary and frame AWS support as SaaS-like; Phase 0 may route to archetype 7.
