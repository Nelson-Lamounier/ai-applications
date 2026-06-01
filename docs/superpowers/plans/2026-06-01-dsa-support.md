# DSA Support (v1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Calibrate which DSA topics matter for a specific role (from the JD) and frame honest gaps in the Technical workspace — no GitHub code-scanning, no practice generation (those are v1.5/deferred).

**Architecture:** New constraint-only `dsa_topics` reference table (mirrors Spec-1 049). The research agent emits a `dsaTopicCalibration` field (JD × `jd_signal_keywords`). `round_type` is added per-stage to `company_interview_profiles.process_shape`. The Technical workspace gains a gated Section B that lists calibrated topics with honest "practice externally" framing. The coach constraint block becomes DSA-aware.

**Tech Stack:** PostgreSQL/pgvector, TypeScript (ESM `.js`), Jest (shared/job-strategist + admin-api `NODE_OPTIONS='--experimental-vm-modules'`), Vitest (tucaken-app UI). Bedrock forced-tool (research agent).

**Spec:** `docs/superpowers/specs/2026-06-01-dsa-support-design.md` (+ design-input `…-design-input.md`).

**Migrations:** next numbers are **051** (dsa_topics) + **052** (company round_type backfill) — 050 is Spec 2b's `interview_stage_lifecycle`.

---

## Two PRs

- **PR1** (`ai-applications`): dsa_topics table+seed+repo; research `dsaTopicCalibration`; `round_type` type + backfill; coach constraint DSA-awareness; DSA gap templates.
- **PR2** (`tucaken-app`): admin-api serves `dsaTopicCalibration` + technical `round_type`; Technical workspace Section B + honest framing; demote PracticeModal to pointers.

Runners: shared/job-strategist `cd applications/<pkg> && npx jest <path>`; migration via `psql` apply (no harness, like 049); UI `npm test` / `npm run typecheck`.

---

# PR1 — ai-applications

## Task 1: Migration 051 — `dsa_topics` (constraint-only) + DSA gap templates

**Files:** Create `applications/platform-rds-bootstrap/migrations/051_dsa_topics.sql`

- [ ] **Step 1: Write the migration** (idempotent, mirrors 049 header discipline; constraint-only — NO problems/solutions/plans):

```sql
-- 051_dsa_topics.sql
-- Constraint-only DSA topic taxonomy + JD-signal mappings (NOT example content).
-- Global reference (no user_id, no RLS), frozen snapshot, idempotent ON CONFLICT.
-- Source: Tech Interview Handbook + NeetCode topic taxonomy + interviewing.io topic
-- frequency, retrieved 2026-06-01. Also seeds DSA gap-handling scaffolds.
BEGIN;

CREATE TABLE IF NOT EXISTS dsa_topics (
  canonical_name     TEXT PRIMARY KEY,
  display_name       TEXT NOT NULL,
  category           TEXT NOT NULL,
  jd_signal_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  prerequisites      JSONB NOT NULL DEFAULT '[]'::jsonb,
  practice_pointer   TEXT,
  source             TEXT NOT NULL,
  as_of              DATE NOT NULL
);

INSERT INTO dsa_topics (canonical_name, display_name, category, jd_signal_keywords, prerequisites, practice_pointer, source, as_of) VALUES
('dsa_arrays_strings','Arrays & Strings','arrays_strings','["parsing","string processing","array","buffer"]'::jsonb,'[]'::jsonb,'leetcode.com/tag/array','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_hashing','Hash Maps / Sets','hashing','["lookup","dedup","cache","index","frequency"]'::jsonb,'[]'::jsonb,'leetcode.com/tag/hash-table','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_two_pointers','Two Pointers','arrays_strings','["sorted","in-place","partition"]'::jsonb,'["dsa_arrays_strings"]'::jsonb,'leetcode.com/tag/two-pointers','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_sliding_window','Sliding Window','arrays_strings','["substring","subarray","streaming","window","rate"]'::jsonb,'["dsa_arrays_strings"]'::jsonb,'leetcode.com/tag/sliding-window','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_binary_search','Binary Search','searching','["sorted","search","log n","threshold"]'::jsonb,'[]'::jsonb,'leetcode.com/tag/binary-search','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_linked_list','Linked Lists','linked_list','["linked list","pointer","node"]'::jsonb,'[]'::jsonb,'leetcode.com/tag/linked-list','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_stack_queue','Stacks & Queues','stack_queue','["stack","queue","LIFO","FIFO","parsing","expression"]'::jsonb,'[]'::jsonb,'leetcode.com/tag/stack','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_trees','Trees & BST','trees','["tree","hierarchy","BST","traversal","DOM","filesystem"]'::jsonb,'["dsa_recursion"]'::jsonb,'leetcode.com/tag/tree','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_tries','Tries','trees','["prefix","autocomplete","dictionary","search suggestion"]'::jsonb,'["dsa_trees"]'::jsonb,'leetcode.com/tag/trie','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_heaps','Heaps / Priority Queues','heaps','["top k","priority","scheduling","ranking","median","streaming"]'::jsonb,'[]'::jsonb,'leetcode.com/tag/heap-priority-queue','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_graph_traversal','Graph Traversal (BFS/DFS)','graphs','["graph","dependency","shortest path","network","relationship","traversal"]'::jsonb,'["dsa_recursion","dsa_stack_queue"]'::jsonb,'leetcode.com/tag/graph','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_union_find','Union-Find','graphs','["connected components","grouping","disjoint","merge accounts"]'::jsonb,'["dsa_graph_traversal"]'::jsonb,'leetcode.com/tag/union-find','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_topological_sort','Topological Sort','graphs','["dependency order","build order","scheduling","DAG"]'::jsonb,'["dsa_graph_traversal"]'::jsonb,'leetcode.com/tag/topological-sort','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_recursion','Recursion','recursion','["recursive","divide and conquer","tree"]'::jsonb,'[]'::jsonb,'leetcode.com/tag/recursion','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_backtracking','Backtracking','recursion','["combinations","permutations","constraint","search space"]'::jsonb,'["dsa_recursion"]'::jsonb,'leetcode.com/tag/backtracking','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_dynamic_programming','Dynamic Programming','dynamic_programming','["optimi","maximi","minimi","count ways","subsequence","DP"]'::jsonb,'["dsa_recursion"]'::jsonb,'neetcode.io/roadmap (DP)','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_greedy','Greedy','greedy','["interval","schedule","minimum number","optimi"]'::jsonb,'[]'::jsonb,'leetcode.com/tag/greedy','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_intervals','Intervals','arrays_strings','["interval","merge","overlap","calendar","range"]'::jsonb,'["dsa_arrays_strings"]'::jsonb,'leetcode.com/tag/intervals','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_sorting','Sorting & Comparators','sorting','["sort","order","ranking","comparator"]'::jsonb,'[]'::jsonb,'leetcode.com/tag/sorting','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_bit_manipulation','Bit Manipulation','math','["bit","mask","XOR","binary","flags"]'::jsonb,'[]'::jsonb,'leetcode.com/tag/bit-manipulation','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_matrix','Matrix / Grid','arrays_strings','["grid","matrix","2d","image","board"]'::jsonb,'["dsa_arrays_strings"]'::jsonb,'leetcode.com/tag/matrix','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_concurrency','Concurrency Primitives','concurrency','["concurren","thread","lock","atomic","race","parallel"]'::jsonb,'[]'::jsonb,'leetcode.com/tag/concurrency','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01'),
('dsa_complexity','Complexity Analysis','foundations','["scale","performance","latency","big o","efficient","optimi"]'::jsonb,'[]'::jsonb,'Tech Interview Handbook (complexity)','Tech Interview Handbook, retrieved 2026-06-01','2026-06-01')
ON CONFLICT (canonical_name) DO UPDATE SET
  display_name=EXCLUDED.display_name, category=EXCLUDED.category,
  jd_signal_keywords=EXCLUDED.jd_signal_keywords, prerequisites=EXCLUDED.prerequisites,
  practice_pointer=EXCLUDED.practice_pointer, source=EXCLUDED.source, as_of=EXCLUDED.as_of;

-- DSA-specific gap-handling scaffolds (reuse prep_scaffolds, kind='gap_handling')
INSERT INTO prep_scaffolds (id, kind, title, structure, source, as_of) VALUES
('gap-dsa-adjacent','gap_handling','Bridge a DSA gap to a production pattern',
 '{"trigger":"dsa_topic_no_practice","template":"I haven''t drilled {topic} on LeetCode recently, but I''ve applied the underlying idea in production — {adjacent} in {project}. For an interview I''d revisit {topic} on {practice_pointer}; here''s how I''d reason about it: {approach}."}'::jsonb,
 'UI-spec DSA honesty guidance','2026-06-01'),
('gap-dsa-practice','gap_handling','Acknowledge a DSA gap + commit to practice',
 '{"trigger":"dsa_topic_no_evidence","template":"That topic ({topic}) is likely on this round and I haven''t practiced it recently. I''d allocate focused prep on {practice_pointer} before the interview rather than wing it."}'::jsonb,
 'UI-spec DSA honesty guidance','2026-06-01')
ON CONFLICT (id) DO UPDATE SET kind=EXCLUDED.kind, title=EXCLUDED.title, structure=EXCLUDED.structure, source=EXCLUDED.source, as_of=EXCLUDED.as_of;

COMMIT;
```

> **Curation note:** 23 canonical topics is the v1 starter (the spec's ~60-80 includes finer subtopics — expand later following the same shape; every row keeps a real `source`). Keep it constraint-only.

- [ ] **Step 2: Apply + verify** (psql, like 049): apply the file, then `SELECT count(*) FROM dsa_topics;` (expect 23) and `SELECT count(*) FROM prep_scaffolds WHERE id LIKE 'gap-dsa-%';` (expect 2).

- [ ] **Step 3: Commit**
```bash
git add applications/platform-rds-bootstrap/migrations/051_dsa_topics.sql
git commit -m "feat(rds): migration 051 — dsa_topics taxonomy (constraint-only) + DSA gap scaffolds"
```

## Task 2: `RdsDsaTopicRepository` (shared, TDD)

**Files:** Create `applications/shared/src/stage-prep/dsa-topics.ts` + `dsa-topics.test.ts`; export from `applications/shared/src/stage-prep/index.ts`.

- [ ] **Step 1: Failing test** `dsa-topics.test.ts`:
```typescript
import { describe, it, expect, jest } from '@jest/globals';
import { RdsDsaTopicRepository } from './dsa-topics.js';

function fakePool(rows: unknown[]) {
  const query = jest.fn(async () => ({ rows }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { pool: { query } as any, query };
}

describe('RdsDsaTopicRepository.listTopics', () => {
  it('maps rows to DsaTopic', async () => {
    const { pool } = fakePool([{
      canonical_name: 'dsa_graph_traversal', display_name: 'Graph traversal (BFS/DFS)',
      category: 'graphs', jd_signal_keywords: ['graph','dependency'], prerequisites: ['dsa_recursion'],
      practice_pointer: 'leetcode.com/tag/graph',
    }]);
    const out = await new RdsDsaTopicRepository(pool).listTopics();
    expect(out[0]).toMatchObject({ canonicalName: 'dsa_graph_traversal', category: 'graphs', jdSignalKeywords: ['graph','dependency'] });
  });
  it('returns [] when empty', async () => {
    const { pool } = fakePool([]);
    expect(await new RdsDsaTopicRepository(pool).listTopics()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run → FAIL.** `cd applications/shared && npx jest src/stage-prep/dsa-topics.test.ts`

- [ ] **Step 3: Implement** `dsa-topics.ts`:
```typescript
/** @format */
import type { Pool } from 'pg';

export interface DsaTopic {
  readonly canonicalName: string;
  readonly displayName: string;
  readonly category: string;
  readonly jdSignalKeywords: string[];
  readonly prerequisites: string[];
  readonly practicePointer: string | null;
}

interface DsaRow {
  canonical_name: string; display_name: string; category: string;
  jd_signal_keywords: string[]; prerequisites: string[]; practice_pointer: string | null;
}

function toTopic(r: DsaRow): DsaTopic {
  return {
    canonicalName: r.canonical_name, displayName: r.display_name, category: r.category,
    jdSignalKeywords: r.jd_signal_keywords ?? [], prerequisites: r.prerequisites ?? [],
    practicePointer: r.practice_pointer ?? null,
  };
}

/** Read-only repository over the dsa_topics constraint table. */
export class RdsDsaTopicRepository {
  constructor(private readonly pool: Pool) {}
  async listTopics(): Promise<DsaTopic[]> {
    const r = await this.pool.query<DsaRow>(
      `SELECT canonical_name, display_name, category, jd_signal_keywords, prerequisites, practice_pointer
         FROM dsa_topics ORDER BY category, canonical_name`);
    return r.rows.map(toTopic);
  }
  async listByCategory(category: string): Promise<DsaTopic[]> {
    const r = await this.pool.query<DsaRow>(
      `SELECT canonical_name, display_name, category, jd_signal_keywords, prerequisites, practice_pointer
         FROM dsa_topics WHERE category = $1 ORDER BY canonical_name`, [category]);
    return r.rows.map(toTopic);
  }
}
```

- [ ] **Step 4: Run → PASS.** Add `export * from './dsa-topics.js';` to `applications/shared/src/stage-prep/index.ts` (propagates via the root barrel from Spec 1).

- [ ] **Step 5: tsc + commit**
```bash
cd applications/shared && npx tsc --noEmit && npx jest src/stage-prep/dsa-topics.test.ts
git add applications/shared/src/stage-prep/dsa-topics.ts applications/shared/src/stage-prep/dsa-topics.test.ts applications/shared/src/stage-prep/index.ts
git commit -m "feat(shared): RdsDsaTopicRepository over dsa_topics (TDD)"
```

## Task 3: `dsaTopicCalibration` in the research agent

**Files:** Modify `applications/shared/src/strategist-types.ts` (type), `applications/job-strategist/src/agents/research-agent.ts` (forced-tool schema + Zod + load dsa_topics), `applications/job-strategist/src/prompts/research-persona.ts` (instruction). Test: `applications/job-strategist/src/agents/research-agent.test.ts` (extend or create).

- [ ] **Step 1: Add the type** to `StrategistResearchResult` in `strategist-types.ts` (after `gaps`/before `fitSummary` is fine):
```typescript
  /** JD-implied DSA topics (calibration, not guarantee). Optional — empty for no-DSA roles. */
  readonly dsaTopicCalibration?: {
    readonly likelyTopics: ReadonlyArray<{
      readonly canonicalName: string;
      readonly displayName: string;
      readonly confidence: number;
      readonly rationale: string;
      readonly jdEvidenceQuote: string;
    }>;
    readonly honestyNote: string;
  };
```

- [ ] **Step 2: Add to the forced tool schema** (`RESEARCH_TOOL.inputSchema.properties`, ~line 379) as an OPTIONAL property (NOT in the `required` array at ~line 452 — mirrors how the coach phone-screen fields were added):
```typescript
            dsaTopicCalibration: {
                type: 'object',
                properties: {
                    likelyTopics: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                canonicalName:  { type: 'string' },
                                displayName:    { type: 'string' },
                                confidence:     { type: 'number' },
                                rationale:      { type: 'string' },
                                jdEvidenceQuote:{ type: 'string' },
                            },
                            required: ['canonicalName','displayName','confidence','rationale','jdEvidenceQuote'],
                            additionalProperties: false,
                        },
                    },
                    honestyNote: { type: 'string' },
                },
                required: ['likelyTopics','honestyNote'],
                additionalProperties: false,
            },
```

- [ ] **Step 3: Add to the Zod `ResearchModelSchema`** (~line 470) as `.optional()`:
```typescript
    dsaTopicCalibration: z.object({
        likelyTopics: z.array(z.object({
            canonicalName: z.string(), displayName: z.string(), confidence: z.number(),
            rationale: z.string(), jdEvidenceQuote: z.string(),
        }).strict()),
        honestyNote: z.string(),
    }).strict().optional(),
```

- [ ] **Step 4: Feed the topic taxonomy into the prompt.** In `executeResearchAgent`, before building the user message, load the topics and inject them so the model maps JD→topics from the canonical list (do NOT let it invent canonicalNames):
```typescript
import { RdsDsaTopicRepository } from '@bedrock/shared';
// ... in executeResearchAgent, using the pipeline pool (getPool from '../lib/pg.js' or the existing store's pool):
const dsaTopics = await new RdsDsaTopicRepository(getPool(/* pg config as run-pipeline builds it */)).listTopics().catch(() => []);
const dsaCatalog = dsaTopics.map(t => `${t.canonicalName} (${t.displayName}) — signals: ${t.jdSignalKeywords.join(', ')}`).join('\n');
```
Append a section to the research user message: a "## DSA topic catalog (map the JD to these canonical names only)" block with `dsaCatalog`, instructing: emit `dsaTopicCalibration` with the JD-implied subset (canonicalName MUST be from the catalog), each with a JD quote + confidence; empty `likelyTopics` if the role implies no DSA round; `honestyNote` mandatory. Add the matching instruction to `research-persona.ts`.

- [ ] **Step 5: Pass-through in `validateResearchResult`.** Confirm `dsaTopicCalibration` survives validation (it's in `ResearchModelSchema` now). No injected-field handling needed (it's model output).

- [ ] **Step 6: Test.** Extend the research-agent test: a forced-tool reply WITH `dsaTopicCalibration` parses + survives; a reply WITHOUT it still validates (optional). If the package lacks a research-agent test, add a minimal `validateResearchResult` unit asserting both. Run `cd applications/job-strategist && npx jest src/agents/research-agent.test.ts && npx tsc --noEmit`.

- [ ] **Step 7: Commit**
```bash
git add applications/shared/src/strategist-types.ts applications/job-strategist/src/agents/research-agent.ts applications/job-strategist/src/prompts/research-persona.ts applications/job-strategist/src/agents/research-agent.test.ts
git commit -m "feat(research): emit dsaTopicCalibration (JD-implied DSA topics, optional)"
```

## Task 4: Per-stage `round_type` (type + backfill)

**Files:** Modify `applications/shared/src/stage-prep/stage-prep-types.ts` (`ProcessStage`); create migration `applications/platform-rds-bootstrap/migrations/052_company_round_type.sql` (backfill seeded company process_shape).

- [ ] **Step 1: Type.** Add to `ProcessStage`:
```typescript
    readonly round_type?: 'dsa' | 'practical' | 'take-home' | 'system-design' | 'behavioral' | 'mixed';
```

- [ ] **Step 2: Backfill migration** `052_company_round_type.sql` — set `round_type` on the technical stage element(s) of the companies seeded in 049 (Amazon, Stripe). Idempotent. Example using jsonb rebuild per company (adapt to the actual seeded process_shape shape):
```sql
-- 052_company_round_type.sql — annotate seeded company process_shape stages with round_type.
-- Source: Glassdoor / public eng-interview reports, retrieved 2026-06-01.
BEGIN;
UPDATE company_interview_profiles
   SET process_shape = '[{"stage":"phone-screen","format":"recruiter screen","note":"fit + logistics + comp alignment","round_type":"behavioral"},{"stage":"technical-1","format":"technical phone (coding)","note":"One coding problem, LP probing begins","round_type":"dsa"},{"stage":"final-round","format":"onsite loop (4-5)","note":"Coding, system design, behavioural — scored vs LPs","round_type":"mixed"}]'::jsonb
 WHERE company_key = 'amazon';
UPDATE company_interview_profiles
   SET process_shape = '[{"stage":"phone-screen","format":"recruiter screen","note":"fit + role interest","round_type":"behavioral"},{"stage":"technical-1","format":"technical phone","note":"Practical coding close to real product work","round_type":"practical"},{"stage":"final-round","format":"onsite (4 rounds)","note":"2 coding, 1 system design, 1 behavioural","round_type":"mixed"}]'::jsonb
 WHERE company_key = 'stripe';
COMMIT;
```
> Read the actual 049 process_shape values first and preserve them, only adding `round_type` per element. (Stripe technical = `practical`; Amazon technical = `dsa` — per the reports.)

- [ ] **Step 3: Apply + verify** (`psql`): `SELECT company_key, process_shape FROM company_interview_profiles;` — confirm `round_type` present per stage element.

- [ ] **Step 4: tsc + commit**
```bash
cd applications/shared && npx tsc --noEmit
git add applications/shared/src/stage-prep/stage-prep-types.ts applications/platform-rds-bootstrap/migrations/052_company_round_type.sql
git commit -m "feat(stage-prep): ProcessStage.round_type + backfill seeded company process_shape"
```

## Task 5: Coach constraint DSA-awareness

**Files:** Modify `applications/shared/src/stage-prep/constraint-block.ts` (add DSA to the block) + `applications/job-strategist/src/run-coach.ts` (pass research.dsaTopicCalibration + technical round_type).

- [ ] **Step 1:** Add an optional `dsaTopics` + `roundType` to `StagePrepConstraints` and render them in `buildStagePrepConstraintBlock` (after the comp/process sections, before the truthfulness reminder):
```typescript
// in StagePrepConstraints:
  readonly dsaTopics?: string[];     // display names of JD-implied DSA topics
  readonly roundType?: string;       // technical round_type
// in buildStagePrepConstraintBlock:
    if (c.roundType) lines.push(`Technical round type for this company: ${c.roundType}.`);
    if (c.dsaTopics && c.dsaTopics.length) {
        lines.push(`DSA topics this role likely tests (calibrated from the JD): ${c.dsaTopics.join(', ')}. ` +
            `Coach on these honestly — surface the user's real-work patterns where they exist, and for gaps recommend external practice rather than fabricating competence.`);
    }
```

- [ ] **Step 2:** In `run-coach.ts`, when building constraints for a technical stage, source `dsaTopics` from `research.dsaTopicCalibration?.likelyTopics.map(t => t.displayName)` and `roundType` from the company profile's technical `round_type` (the repo already loads the company profile in `loadStagePrepConstraints`; thread `round_type` + dsaTopics into the constraints object). Keep it null-safe (no DSA → omitted).

- [ ] **Step 3:** Extend `constraint-block.test.ts`: a constraints object with `dsaTopics` + `roundType` renders them; without → omitted. Run `cd applications/shared && npx jest src/stage-prep/constraint-block.test.ts && npx tsc --noEmit`.

- [ ] **Step 4: Commit**
```bash
git add applications/shared/src/stage-prep/constraint-block.ts applications/shared/src/stage-prep/constraint-block.test.ts applications/job-strategist/src/run-coach.ts
git commit -m "feat(coach): DSA-aware constraint block (topics + round_type for technical stage)"
```

## Task 6: PR1 gate + PR
- [ ] `cd applications/shared && npx tsc --noEmit && npx jest` ; `cd applications/job-strategist && npx tsc --noEmit && npx jest` — green. Rebuild shared dist if job-strategist consumes built `@bedrock/shared`.
- [ ] Migrations 051 + 052 applied to dev + verified.
- [ ] Push + `gh pr create --base develop` — "feat: DSA topic calibration + ontology + coach awareness (Spec DSA v1, PR1)".

---

# PR2 — tucaken-app (admin-api + UI)

> Read each file before editing.

## Task 7: admin-api serves `dsaTopicCalibration` + technical `round_type`

**Files:** Modify `admin-api/src/routes/applications.ts` (`GET /:slug`).

- [ ] **Step 1:** Confirm `GET /:slug` already serves `research` fields from `pipeline_runs.metadata.research` (it serves `coaching` + research-derived fields). Ensure `dsaTopicCalibration` is included in the served research object (if the detail maps specific research fields, add `dsaTopicCalibration`; if it passes `research` through, it's already there — verify).
- [ ] **Step 2:** Resolve the technical `round_type`: load the company profile for the app's company (`getCompanyProfile(normalizeCompanyKey(company))` via the stage-prep repo, OR query `company_interview_profiles`), find the `process_shape` element whose `stage` starts with `technical`, expose `technicalRoundType: <round_type> ?? 'dsa'` on the detail response. Default `'dsa'` when no profile/round_type.
- [ ] **Step 3: Test** (admin-api jest): detail includes `dsaTopicCalibration` when research has it; `technicalRoundType` resolves from the company profile, defaults `'dsa'` when absent. Run the suite + tsc.
- [ ] **Step 4: Commit** `git commit -m "feat(admin-api): serve dsaTopicCalibration + technicalRoundType in application detail"`

## Task 8: UI types
**Files:** Modify `src/lib/types/applications.types.ts`.
- [ ] Add `DsaTopicCalibration` (mirror Task 3 shape, camelCase) + `readonly dsaTopicCalibration?: DsaTopicCalibration` on `ResearchOutput` (or wherever research fields live) and `readonly technicalRoundType?: 'dsa'|'practical'|'take-home'|'system-design'|'behavioral'|'mixed'` on `ApplicationDetail`. tsc clean. Commit.

## Task 9: Technical workspace Section B + honest framing
**Files:** Modify `src/features/applications/stages/workspaces/TechnicalWorkspace.tsx`; demote `PracticeModal` generate/mock.
- [ ] **Step 1:** Read `TechnicalWorkspace.tsx`. Below the existing system-design topic cards (Section A), add **Section B (DSA)**, gated: render only when `detail.technicalRoundType ∈ {'dsa','mixed','practical'}`.
- [ ] **Step 2:** Data-sources **banner** at the top of Section B (verbatim from the spec: "We calibrate which DSA topics matter for this role and flag gaps. DSA practice happens off-GitHub — we point you to LeetCode/NeetCode; we don't drill. (Real-work pattern detection is coming.)").
- [ ] **Step 3:** Topic cards from `detail.research?.dsaTopicCalibration?.likelyTopics`: each shows `displayName`, a relevance indicator (from `confidence`), `rationale`, and an honest **"practice externally"** treatment with the topic's practice pointer (the calibration carries displayName + rationale; for the practice pointer, either include it in the calibration payload from Task 3 OR render a generic "practice on LeetCode/NeetCode" link — keep v1 simple: generic pointer + the gap-acknowledge copy). **No 🟢/🟡 from real work in v1** (no GitHub DSA evidence) — do not render fake "your work shows this".
- [ ] **Step 4:** Empty `likelyTopics` → "This role likely has no DSA round — focus on system design / practical work." `practical` round_type → relaxed framing (ship-ready emphasis).
- [ ] **Step 5:** Demote `PracticeModal` `PRACTICE_GENERATE`/`PRACTICE_MOCK` to external links (LeetCode/NeetCode) instead of in-product generation/mock (align with positioning). If that's too entangled, gate those states off + render a pointer; note any deferral.
- [ ] **Step 6: Verify** `npm run typecheck` + `npm test`; add/extend a vitest asserting Section B shows for `dsa` round_type with calibrated topics, hides for `take-home`, and shows the "no DSA round" message on empty topics. Commit.

## Task 10: PR2 gate + PR
- [ ] tucaken-app `npm run typecheck` + `npm test` green; admin-api suite green. Push + `gh pr create` — "feat: Technical workspace DSA Section B + detail serving (Spec DSA v1, PR2)". Depends on PR1 deployed.

---

## Final E2E (manual, after merge+deploy)
- [ ] Analyse a FAANG-style JD → detail.research.dsaTopicCalibration populated; Technical workspace Section B lists calibrated topics + practice pointers + banner.
- [ ] Analyse a senior-platform JD with no DSA signal → empty likelyTopics → "no DSA round likely".
- [ ] A company with technical `round_type='take-home'` → Section B hidden.

## Self-review notes
- **Honesty:** v1 renders NO real-work DSA evidence (🟢) — Section B is calibration + honest gaps only. `honestyNote` mandatory on calibration. Ontology constraint-only.
- **Optional-field discipline:** `dsaTopicCalibration` is optional in tool schema + Zod (like coach phone-screen fields) → research for non-DSA roles still validates.
- **round_type default 'dsa'** (safe mode) everywhere it's resolved.
- **Migrations 051 (table) + 052 (round_type backfill)** apply before deploy; 052 is data-only (process_shape JSONB).
- **v1.5 (separate spec):** GitHub DSA detector (FP≤5% gate), practice-repo archetype, real-work 🟢/🟡 badges.
