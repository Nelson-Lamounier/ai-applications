# Skill-Transfer (Technical) — PR 1 (ai-applications) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Compute a grounded JD-skill ↔ project mapping in the coach pipeline and emit it as a validated `skillTransfer` section on the coach output (technical stage), so the Technical workspace can later render "JD requires X; in your project you did X" with honest gaps.

**Architecture:** A pure deterministic `joinSkillCandidates` gathers candidate project rows (case-study + repo-evidence) per JD skill with real ids/tiers; the coach LLM picks a tier and narrates citing only those ids; a pure `validateSkillTransfer` demotes any invented citation to an honest gap. `skillTransfer` rides the existing coach-output JSON into `coaching_content.topics_to_study` — **no migration**.

**Tech Stack:** TypeScript (ESM), Jest, Bedrock Converse (coach agent), Postgres (`pg`). Spec: `docs/superpowers/specs/2026-06-03-skill-transfer-technical-design.md`. Branch `feat/skill-transfer-technical` off develop. NO `Co-Authored-By` trailer. Test cmd: `cd applications/shared && yarn test <path>` (shared) / `cd applications/job-strategist && yarn test <path>` (job-strategist).

**Key confirmed facts (do not re-derive):**
- Coach output is serialized **whole** into `coaching_content.topics_to_study` by `persistCoachingContent` → `skillTransfer` persists automatically once it's on the coach result. No new column.
- Research result (`StrategistResearchResult`) has `verifiedMatches[].skill`, `partialMatches[].skill`, `gaps[].skill`.
- Join path: `project_components(project_id,id)` → `project_repositories(project_component_id, repository_id)` → `repositories(id, full_name)` → `technology_evidence(user_id, repo_full_name, raw_name, file_path, line_start)` / `dsa_evidence(user_id, repo_full_name, raw_name, signal, file_path, line_start)`.
- Case-study cols: `project_components(id,project_id,name,kind)`, `project_decisions(id,project_id,title,decision)`, `project_stack_items(id,project_id,name,category)`, `project_tags(project_id,tag)`, `projects(id,name)`.
- Coach agent: `COACH_TOOL.inputSchema` + `CoachOutputSchema` (Zod `.strict()`) + `buildCoachMessage(analysis, ctx, constraintBlock?, evidenceBlock?)` + `executeCoachAgent(ctx, analysis, constraintBlock, evidenceBlock)`.
- All new pure code lives in `applications/shared/src/stage-prep/` (mirrors `dsa-evidence.ts`, `story-mining.ts`).

---

### Task 1: Types + pure `joinSkillCandidates`

**Files:**
- Create: `applications/shared/src/stage-prep/skill-transfer-types.ts`
- Create: `applications/shared/src/stage-prep/skill-transfer.ts`
- Test: `applications/shared/src/stage-prep/skill-transfer.test.ts`

- [ ] **Step 1: Write the types**

Create `applications/shared/src/stage-prep/skill-transfer-types.ts`:
```ts
/** @format */
export type CandidateTier = 'demonstrated' | 'claimed' | 'declared';
export type SkillTier = CandidateTier | 'gap';
export type CandidateSource =
  | 'component' | 'decision' | 'stack_item' | 'tag' | 'tech_evidence' | 'dsa_evidence';

/** One grounded project row that may evidence a JD skill. `id` is the real row id
 *  (or `${projectId}:${tag}` for tags, which have no own id). */
export interface SkillCandidate {
  readonly projectId: string;
  readonly projectName: string;
  readonly source: CandidateSource;
  readonly tier: CandidateTier;
  readonly id: string;
  readonly label: string;
  readonly fileLine?: string;
}
export interface SkillCandidateSet {
  readonly jdSkill: string;
  readonly candidates: readonly SkillCandidate[];
}

/** Raw project evidence for one user (what the repository returns). */
export interface ProjectEvidenceInput {
  readonly projects:    readonly { id: string; name: string }[];
  readonly components:  readonly { id: string; projectId: string; name: string; kind: string }[];
  readonly decisions:   readonly { id: string; projectId: string; title: string; decision: string | null }[];
  readonly stackItems:  readonly { id: string; projectId: string; name: string; category: string }[];
  readonly tags:        readonly { projectId: string; tag: string }[];
  readonly repoEvidence: readonly {
    projectId: string; source: 'tech_evidence' | 'dsa_evidence';
    id: string; rawName: string; fileLine: string;
  }[];
}

/** Final per-skill mapping emitted by the coach + sanitised by validateSkillTransfer. */
export interface SkillTransferEntry {
  readonly jdSkill: string;
  readonly tier: SkillTier;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly evidenceRefs: readonly { source: string; id: string; label: string; fileLine?: string }[];
  readonly narrative: string;
}
```

- [ ] **Step 2: Write the failing test**

Create `applications/shared/src/stage-prep/skill-transfer.test.ts`:
```ts
/** @format */
import { describe, it, expect } from '@jest/globals';
import { joinSkillCandidates } from './skill-transfer.js';
import type { ProjectEvidenceInput } from './skill-transfer-types.js';

const EMPTY: ProjectEvidenceInput = { projects: [], components: [], decisions: [], stackItems: [], tags: [], repoEvidence: [] };
const input: ProjectEvidenceInput = {
  projects:   [{ id: 'p1', name: 'AI Apps' }],
  components: [{ id: 'c1', projectId: 'p1', name: 'EKS Kubernetes cluster', kind: 'infra' }],
  decisions:  [{ id: 'd1', projectId: 'p1', title: 'Chose Postgres over DynamoDB', decision: 'Relational fit' }],
  stackItems: [{ id: 's1', projectId: 'p1', name: 'Terraform', category: 'iac' }],
  tags:       [{ projectId: 'p1', tag: 'observability' }],
  repoEvidence: [{ projectId: 'p1', source: 'tech_evidence', id: 'e1', rawName: 'pgvector', fileLine: 'src/db.ts:12' }],
};

describe('joinSkillCandidates', () => {
  it('classifies component match as demonstrated', () => {
    const out = joinSkillCandidates(['Kubernetes'], input);
    const set = out.find(s => s.jdSkill === 'Kubernetes')!;
    expect(set.candidates).toHaveLength(1);
    expect(set.candidates[0]).toMatchObject({ source: 'component', tier: 'demonstrated', id: 'c1', projectId: 'p1', projectName: 'AI Apps' });
  });
  it('classifies stack_item match as claimed and tag match as claimed', () => {
    expect(joinSkillCandidates(['Terraform'], input)[0].candidates[0]).toMatchObject({ source: 'stack_item', tier: 'claimed', id: 's1' });
    expect(joinSkillCandidates(['observability'], input)[0].candidates[0]).toMatchObject({ source: 'tag', tier: 'claimed', id: 'p1:observability' });
  });
  it('classifies decision match as demonstrated', () => {
    expect(joinSkillCandidates(['Postgres'], input)[0].candidates[0]).toMatchObject({ source: 'decision', tier: 'demonstrated', id: 'd1' });
  });
  it('classifies repo evidence match as declared with fileLine', () => {
    expect(joinSkillCandidates(['pgvector'], input)[0].candidates[0]).toMatchObject({ source: 'tech_evidence', tier: 'declared', id: 'e1', fileLine: 'src/db.ts:12' });
  });
  it('returns an empty candidate list for an unmatched skill (gap)', () => {
    expect(joinSkillCandidates(['Kafka'], input)[0].candidates).toEqual([]);
  });
  it('does NOT spuriously match on short/stopword tokens', () => {
    // "design" is a real token but appears in no label; "the"/"a" stopwords ignored.
    expect(joinSkillCandidates(['system design'], input)[0].candidates).toEqual([]);
  });
  it('handles no projects (every skill → empty candidates)', () => {
    expect(joinSkillCandidates(['Kubernetes'], EMPTY)[0].candidates).toEqual([]);
  });
});
```

- [ ] **Step 3: Run, verify fail**

Run: `cd applications/shared && yarn test src/stage-prep/skill-transfer.test.ts`
Expected: FAIL (module `./skill-transfer.js` not found).

- [ ] **Step 4: Implement `joinSkillCandidates`**

Create `applications/shared/src/stage-prep/skill-transfer.ts`:
```ts
/** @format */
import type {
  ProjectEvidenceInput, SkillCandidate, SkillCandidateSet,
} from './skill-transfer-types.js';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'using',
  'system', 'design', 'experience', 'knowledge', 'strong', 'good', 'using', 'via',
]);

/** Lowercase alphanumeric tokens of length >=3, minus stopwords. */
function tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/** True when the JD-skill tokens and the label tokens share >=1 token. */
function overlaps(skillTokens: Set<string>, label: string): boolean {
  const lt = tokens(label);
  for (const t of skillTokens) if (lt.has(t)) return true;
  return false;
}

/**
 * Pure, deterministic candidate gatherer. For each JD skill, collect project rows
 * whose label tokens overlap the skill's tokens. Tier by source: component/decision
 * = demonstrated; stack_item/tag = claimed; repo evidence = declared. No match → empty
 * (the caller treats empty as a gap). Precision over recall — a missed match is an
 * honest under-claim, never an invented one.
 */
export function joinSkillCandidates(
  jdSkills: readonly string[],
  input: ProjectEvidenceInput,
): SkillCandidateSet[] {
  const projName = new Map(input.projects.map(p => [p.id, p.name]));
  const name = (pid: string): string => projName.get(pid) ?? '';

  return jdSkills.map((jdSkill) => {
    const st = tokens(jdSkill);
    const candidates: SkillCandidate[] = [];
    if (st.size === 0) return { jdSkill, candidates };

    for (const c of input.components) {
      if (overlaps(st, c.name)) candidates.push({ projectId: c.projectId, projectName: name(c.projectId), source: 'component', tier: 'demonstrated', id: c.id, label: c.name });
    }
    for (const d of input.decisions) {
      if (overlaps(st, d.title) || (d.decision != null && overlaps(st, d.decision)))
        candidates.push({ projectId: d.projectId, projectName: name(d.projectId), source: 'decision', tier: 'demonstrated', id: d.id, label: d.title });
    }
    for (const s of input.stackItems) {
      if (overlaps(st, s.name)) candidates.push({ projectId: s.projectId, projectName: name(s.projectId), source: 'stack_item', tier: 'claimed', id: s.id, label: s.name });
    }
    for (const t of input.tags) {
      if (overlaps(st, t.tag)) candidates.push({ projectId: t.projectId, projectName: name(t.projectId), source: 'tag', tier: 'claimed', id: `${t.projectId}:${t.tag}`, label: t.tag });
    }
    for (const e of input.repoEvidence) {
      if (overlaps(st, e.rawName)) candidates.push({ projectId: e.projectId, projectName: name(e.projectId), source: e.source, tier: 'declared', id: e.id, label: e.rawName, fileLine: e.fileLine });
    }
    return { jdSkill, candidates };
  });
}
```

- [ ] **Step 5: Run, verify pass**

Run: `cd applications/shared && yarn test src/stage-prep/skill-transfer.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications
git add applications/shared/src/stage-prep/skill-transfer-types.ts applications/shared/src/stage-prep/skill-transfer.ts applications/shared/src/stage-prep/skill-transfer.test.ts
git commit -m "feat(shared): joinSkillCandidates — grounded JD-skill↔project candidate gatherer"
```

---

### Task 2: pure `validateSkillTransfer` (anti-invention)

**Files:**
- Modify: `applications/shared/src/stage-prep/skill-transfer.ts`
- Test: `applications/shared/src/stage-prep/skill-transfer.test.ts`

- [ ] **Step 1: Write the failing test** (append to the test file)

```ts
import { validateSkillTransfer } from './skill-transfer.js';
import type { SkillCandidateSet, SkillTransferEntry } from './skill-transfer-types.js';

const sets: SkillCandidateSet[] = [
  { jdSkill: 'Kubernetes', candidates: [{ projectId: 'p1', projectName: 'AI Apps', source: 'component', tier: 'demonstrated', id: 'c1', label: 'EKS Kubernetes cluster' }] },
  { jdSkill: 'Kafka',      candidates: [] },
];

describe('validateSkillTransfer', () => {
  it('keeps a matched entry that cites a real candidate id', () => {
    const entries: SkillTransferEntry[] = [
      { jdSkill: 'Kubernetes', tier: 'demonstrated', projectId: 'p1', projectName: 'AI Apps', evidenceRefs: [{ source: 'component', id: 'c1', label: 'EKS Kubernetes cluster' }], narrative: 'You ran EKS — maps to the JD.' },
    ];
    expect(validateSkillTransfer(entries, sets)[0]).toMatchObject({ tier: 'demonstrated', projectId: 'p1' });
  });
  it('demotes to gap when the cited projectId is not a candidate (invented)', () => {
    const entries: SkillTransferEntry[] = [
      { jdSkill: 'Kubernetes', tier: 'demonstrated', projectId: 'GHOST', projectName: 'X', evidenceRefs: [{ source: 'component', id: 'c1', label: 'x' }], narrative: 'invented' },
    ];
    const out = validateSkillTransfer(entries, sets)[0];
    expect(out).toMatchObject({ tier: 'gap', projectId: null, projectName: null, evidenceRefs: [] });
  });
  it('demotes to gap when an evidenceRef id is not a candidate', () => {
    const entries: SkillTransferEntry[] = [
      { jdSkill: 'Kubernetes', tier: 'demonstrated', projectId: 'p1', projectName: 'AI Apps', evidenceRefs: [{ source: 'component', id: 'GHOST', label: 'x' }], narrative: 'partly invented' },
    ];
    expect(validateSkillTransfer(entries, sets)[0]).toMatchObject({ tier: 'gap', evidenceRefs: [] });
  });
  it('keeps a genuine gap entry as-is', () => {
    const entries: SkillTransferEntry[] = [
      { jdSkill: 'Kafka', tier: 'gap', projectId: null, projectName: null, evidenceRefs: [], narrative: 'Not shown in your projects — bridge by…' },
    ];
    expect(validateSkillTransfer(entries, sets)[0]).toMatchObject({ tier: 'gap', narrative: 'Not shown in your projects — bridge by…' });
  });
  it('drops entries for skills not in the candidate sets', () => {
    const entries: SkillTransferEntry[] = [
      { jdSkill: 'Rust', tier: 'demonstrated', projectId: 'p1', projectName: 'AI Apps', evidenceRefs: [], narrative: 'x' },
    ];
    expect(validateSkillTransfer(entries, sets)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd applications/shared && yarn test src/stage-prep/skill-transfer.test.ts`
Expected: FAIL (`validateSkillTransfer` not exported).

- [ ] **Step 3: Implement** (append to `skill-transfer.ts`)

```ts
import type { SkillTransferEntry } from './skill-transfer-types.js';

const GAP_NARRATIVE_FALLBACK =
  'Not demonstrated in your projects yet — be honest about this and bridge from an adjacent strength.';

/**
 * Sanitise coach-emitted skillTransfer against the deterministic candidate sets.
 * Any non-gap entry whose projectId or evidenceRef id is not a real candidate for
 * that skill is demoted to an honest gap (anti-invention). Entries for skills not
 * in the sets are dropped. Gap entries pass through.
 */
export function validateSkillTransfer(
  entries: readonly SkillTransferEntry[],
  sets: readonly SkillCandidateSet[],
): SkillTransferEntry[] {
  const bySkill = new Map(sets.map(s => [s.jdSkill, new Set(s.candidates.map(c => c.id))]));
  const projectsBySkill = new Map(sets.map(s => [s.jdSkill, new Set(s.candidates.map(c => c.projectId))]));
  const out: SkillTransferEntry[] = [];
  for (const e of entries) {
    const ids = bySkill.get(e.jdSkill);
    if (!ids) continue; // unknown skill → drop
    if (e.tier === 'gap') { out.push(e); continue; }
    const projectOk = e.projectId != null && projectsBySkill.get(e.jdSkill)!.has(e.projectId);
    const refsOk = e.evidenceRefs.every(r => ids.has(r.id));
    if (projectOk && refsOk && e.evidenceRefs.length > 0) {
      out.push(e);
    } else {
      out.push({ jdSkill: e.jdSkill, tier: 'gap', projectId: null, projectName: null, evidenceRefs: [], narrative: GAP_NARRATIVE_FALLBACK });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run, verify pass** → `cd applications/shared && yarn test src/stage-prep/skill-transfer.test.ts` (12 tests pass).

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/stage-prep/skill-transfer.ts applications/shared/src/stage-prep/skill-transfer.test.ts
git commit -m "feat(shared): validateSkillTransfer — demote invented citations to honest gaps"
```

---

### Task 3: `RdsProjectEvidenceRepository` (reads project + case-study + repo evidence)

**Files:**
- Create: `applications/shared/src/stage-prep/project-evidence.ts`
- Test: `applications/shared/src/stage-prep/project-evidence.test.ts`

- [ ] **Step 1: Write the failing test** (fakePool round-trip — assert the SQL shape + mapping)

Create `applications/shared/src/stage-prep/project-evidence.test.ts`:
```ts
/** @format */
import { describe, it, expect } from '@jest/globals';
import { RdsProjectEvidenceRepository } from './project-evidence.js';

/** Minimal fake pg Pool returning canned rows keyed by a substring of the SQL. */
function fakePool(routes: Array<{ match: RegExp; rows: unknown[] }>) {
  return {
    query: async (sql: string) => {
      const r = routes.find(x => x.match.test(sql));
      return { rows: r ? r.rows : [] };
    },
  } as unknown as import('pg').Pool;
}

describe('RdsProjectEvidenceRepository.load', () => {
  it('reads projects + case-study + repo evidence for a user into ProjectEvidenceInput', async () => {
    const pool = fakePool([
      { match: /FROM projects/i,            rows: [{ id: 'p1', name: 'AI Apps' }] },
      { match: /FROM project_components/i,  rows: [{ id: 'c1', project_id: 'p1', name: 'EKS', kind: 'infra' }] },
      { match: /FROM project_decisions/i,   rows: [{ id: 'd1', project_id: 'p1', title: 'Chose PG', decision: 'fit' }] },
      { match: /FROM project_stack_items/i, rows: [{ id: 's1', project_id: 'p1', name: 'Terraform', category: 'iac' }] },
      { match: /FROM project_tags/i,        rows: [{ project_id: 'p1', tag: 'observability' }] },
      { match: /technology_evidence/i,      rows: [{ project_id: 'p1', source: 'tech_evidence', id: 'e1', raw_name: 'pgvector', file_line: 'src/db.ts:12' }] },
    ]);
    const input = await new RdsProjectEvidenceRepository(pool).load('u1');
    expect(input.projects).toEqual([{ id: 'p1', name: 'AI Apps' }]);
    expect(input.components[0]).toEqual({ id: 'c1', projectId: 'p1', name: 'EKS', kind: 'infra' });
    expect(input.repoEvidence[0]).toEqual({ projectId: 'p1', source: 'tech_evidence', id: 'e1', rawName: 'pgvector', fileLine: 'src/db.ts:12' });
  });

  it('returns all-empty arrays when the user has no projects', async () => {
    const input = await new RdsProjectEvidenceRepository(fakePool([])).load('u1');
    expect(input).toEqual({ projects: [], components: [], decisions: [], stackItems: [], tags: [], repoEvidence: [] });
  });
});
```

- [ ] **Step 2: Run, verify fail** → `cd applications/shared && yarn test src/stage-prep/project-evidence.test.ts` (module missing).

- [ ] **Step 3: Implement**

Create `applications/shared/src/stage-prep/project-evidence.ts`:
```ts
/** @format */
import type { Pool } from 'pg';
import type { ProjectEvidenceInput } from './skill-transfer-types.js';

/**
 * Reads a user's projects, curated case-study rows, and repo-derived evidence
 * (joined to projects via project_components → project_repositories → repositories →
 * {technology,dsa}_evidence.repo_full_name). RLS-scoped by user_id (queries also
 * filter user_id explicitly so an admin connection is safe).
 */
export class RdsProjectEvidenceRepository {
  constructor(private readonly pool: Pool) {}

  async load(userId: string): Promise<ProjectEvidenceInput> {
    const [projects, components, decisions, stackItems, tags, repoEvidence] = await Promise.all([
      this.pool.query(`SELECT id, name FROM projects WHERE user_id = $1`, [userId]),
      this.pool.query(`SELECT id, project_id, name, kind FROM project_components WHERE user_id = $1`, [userId]),
      this.pool.query(`SELECT id, project_id, title, decision FROM project_decisions WHERE user_id = $1`, [userId]),
      this.pool.query(`SELECT id, project_id, name, category FROM project_stack_items WHERE user_id = $1`, [userId]),
      this.pool.query(`SELECT project_id, tag FROM project_tags WHERE user_id = $1`, [userId]),
      this.pool.query(
        `WITH proj_repo AS (
           SELECT DISTINCT pc.project_id, r.full_name
             FROM project_components pc
             JOIN project_repositories pr ON pr.project_component_id = pc.id
             JOIN repositories r          ON r.id = pr.repository_id
            WHERE pc.user_id = $1
         )
         SELECT te.id::text AS id, pr.project_id, 'tech_evidence' AS source,
                te.raw_name, te.file_path || ':' || te.line_start AS file_line
           FROM technology_evidence te
           JOIN proj_repo pr ON pr.full_name = te.repo_full_name
          WHERE te.user_id = $1
         UNION ALL
         SELECT de.id::text AS id, pr.project_id, 'dsa_evidence' AS source,
                de.raw_name, de.file_path || ':' || de.line_start AS file_line
           FROM dsa_evidence de
           JOIN proj_repo pr ON pr.full_name = de.repo_full_name
          WHERE de.user_id = $1`,
        [userId],
      ),
    ]);
    return {
      projects:   projects.rows.map(r => ({ id: r.id, name: r.name })),
      components: components.rows.map(r => ({ id: r.id, projectId: r.project_id, name: r.name, kind: r.kind })),
      decisions:  decisions.rows.map(r => ({ id: r.id, projectId: r.project_id, title: r.title, decision: r.decision ?? null })),
      stackItems: stackItems.rows.map(r => ({ id: r.id, projectId: r.project_id, name: r.name, category: r.category })),
      tags:       tags.rows.map(r => ({ projectId: r.project_id, tag: r.tag })),
      repoEvidence: repoEvidence.rows.map(r => ({ projectId: r.project_id, source: r.source, id: r.id, rawName: r.raw_name, fileLine: r.file_line })),
    };
  }
}
```

- [ ] **Step 4: Run, verify pass** → `cd applications/shared && yarn test src/stage-prep/project-evidence.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/stage-prep/project-evidence.ts applications/shared/src/stage-prep/project-evidence.test.ts
git commit -m "feat(shared): RdsProjectEvidenceRepository — load project+case-study+repo evidence"
```

---

### Task 4: Export new symbols + add `skillTransfer` to the shared coach type

**Files:**
- Modify: `applications/shared/src/stage-prep/index.ts`
- Modify: `applications/shared/src/strategist-types.ts` (the `InterviewCoachResult` / coach-output interface — the one with `technicalPrepChecklist`)

- [ ] **Step 1: Export from the stage-prep barrel**

In `applications/shared/src/stage-prep/index.ts`, add (match existing export style):
```ts
export * from './skill-transfer-types.js';
export { joinSkillCandidates, validateSkillTransfer } from './skill-transfer.js';
export { RdsProjectEvidenceRepository } from './project-evidence.js';
```

- [ ] **Step 2: Add `skillTransfer` to the coach output type**

In `applications/shared/src/strategist-types.ts`, find the interface containing `readonly technicalPrepChecklist: TechnicalPrepItem[];` (the coach result) and add, near `compScript`:
```ts
    /** Optional grounded JD-skill ↔ project mapping (technical stage). */
    readonly skillTransfer?: readonly SkillTransferEntry[];
```
And add the import at the top of the file:
```ts
import type { SkillTransferEntry } from './stage-prep/skill-transfer-types.js';
```
(If `strategist-types.ts` cannot import from `stage-prep/` due to layering, instead inline the `SkillTransferEntry` shape here and have `skill-transfer-types.ts` import it back — pick whichever direction the existing files use; `stage-prep` already imports from `strategist-types`, so define `SkillTransferEntry` in `strategist-types.ts` and re-export it from `skill-transfer-types.ts`.)

- [ ] **Step 3: Build shared**

Run: `cd applications/shared && yarn build`
Expected: tsc clean.

- [ ] **Step 4: Commit**

```bash
git add applications/shared/src/stage-prep/index.ts applications/shared/src/strategist-types.ts applications/shared/src/stage-prep/skill-transfer-types.ts
git commit -m "feat(shared): export skill-transfer symbols + skillTransfer on coach result"
```

---

### Task 5: Coach agent — schema + candidate block + post-validation

**Files:**
- Modify: `applications/job-strategist/src/agents/coach-agent.ts`
- Test: `applications/job-strategist/src/agents/coach-agent.test.ts` (create if absent)

- [ ] **Step 1: Add `skillTransfer` to the tool + Zod schema (OPTIONAL — never required)**

In `COACH_TOOL.inputSchema.properties` add (do NOT add to `required`):
```ts
            skillTransfer: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        jdSkill:     { type: 'string' },
                        tier:        { type: 'string', enum: ['demonstrated', 'claimed', 'declared', 'gap'] },
                        projectId:   { type: ['string', 'null'] },
                        projectName: { type: ['string', 'null'] },
                        evidenceRefs: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: { source: { type: 'string' }, id: { type: 'string' }, label: { type: 'string' }, fileLine: { type: 'string' } },
                                required: ['source', 'id', 'label'],
                                additionalProperties: false,
                            },
                        },
                        narrative:   { type: 'string' },
                    },
                    required: ['jdSkill', 'tier', 'projectId', 'projectName', 'evidenceRefs', 'narrative'],
                    additionalProperties: false,
                },
            },
```
In `CoachOutputSchema` add (after `compScript`, `.optional()`):
```ts
    skillTransfer: z.array(z.object({
        jdSkill:     z.string(),
        tier:        z.enum(['demonstrated', 'claimed', 'declared', 'gap']),
        projectId:   z.string().nullable(),
        projectName: z.string().nullable(),
        evidenceRefs: z.array(z.object({
            source: z.string(), id: z.string(), label: z.string(), fileLine: z.string().optional(),
        }).strict()),
        narrative:   z.string(),
    }).strict()).optional(),
```

- [ ] **Step 2: Inject a candidate block + thread it through `buildCoachMessage` / `executeCoachAgent`**

Add a serialiser near `buildCoachMessage`:
```ts
import type { SkillCandidateSet } from '@bedrock/shared';

/** Render candidate sets as a compact, id-bearing block the model must cite from. */
export function buildSkillCandidateBlock(sets: readonly SkillCandidateSet[]): string {
    if (sets.length === 0) return '';
    const lines = ['## Candidate project evidence per JD skill (cite ONLY these ids)'];
    for (const s of sets) {
        if (s.candidates.length === 0) { lines.push(`- ${s.jdSkill}: (no project evidence → tier=gap)`); continue; }
        lines.push(`- ${s.jdSkill}:`);
        for (const c of s.candidates) {
            lines.push(`    [${c.tier}] project=${c.projectId} (${c.projectName}) source=${c.source} id=${c.id} :: ${c.label}${c.fileLine ? ` @${c.fileLine}` : ''}`);
        }
    }
    lines.push(
        'For EACH JD skill above, emit one skillTransfer entry. Pick the single best candidate ' +
        '(prefer demonstrated > declared > claimed); set projectId/projectName/evidenceRefs to that ' +
        'candidate\'s exact ids; narrate how the project work transfers to the JD skill. If a skill ' +
        'has no candidates, emit tier="gap", projectId=null, evidenceRefs=[], and honest bridge guidance. ' +
        'NEVER cite an id not listed above. Also reference the matched project in any related ' +
        'technicalPrepChecklist rationale.',
    );
    return lines.join('\n');
}
```
Change `buildCoachMessage(...)` to accept `skillCandidateBlock?: string` and push it (when non-empty) right after the constraint block. Change `executeCoachAgent(ctx, analysis, constraintBlock, evidenceBlock, skillCandidateSets?)` to: build the block, pass to `buildCoachMessage`, and **after** schema parse, run:
```ts
        if (skillCandidateSets && skillCandidateSets.length > 0) {
            const raw = (parsed.skillTransfer ?? []) as SkillTransferEntry[];
            (parsed as { skillTransfer?: unknown }).skillTransfer = validateSkillTransfer(raw, skillCandidateSets);
        }
```
(import `validateSkillTransfer`, `SkillTransferEntry`, `SkillCandidateSet` from `@bedrock/shared`.)

- [ ] **Step 3: Write a focused test**

Create/extend `applications/job-strategist/src/agents/coach-agent.test.ts`:
```ts
/** @format */
import { describe, it, expect } from '@jest/globals';
import { buildSkillCandidateBlock } from './coach-agent.js';

describe('buildSkillCandidateBlock', () => {
  it('lists candidate ids per skill and a gap note for empties', () => {
    const block = buildSkillCandidateBlock([
      { jdSkill: 'Kubernetes', candidates: [{ projectId: 'p1', projectName: 'AI Apps', source: 'component', tier: 'demonstrated', id: 'c1', label: 'EKS' }] },
      { jdSkill: 'Kafka', candidates: [] },
    ]);
    expect(block).toContain('id=c1');
    expect(block).toContain('Kafka: (no project evidence → tier=gap)');
    expect(block).toContain('cite ONLY these ids');
  });
  it('returns empty string for no sets', () => {
    expect(buildSkillCandidateBlock([])).toBe('');
  });
});
```

- [ ] **Step 4: Run + build** → `cd applications/job-strategist && yarn test src/agents/coach-agent.test.ts` then `yarn build`. Expected: pass + clean.

- [ ] **Step 5: Commit**

```bash
git add applications/job-strategist/src/agents/coach-agent.ts applications/job-strategist/src/agents/coach-agent.test.ts
git commit -m "feat(coach): skillTransfer tool schema + candidate block + post-validation"
```

---

### Task 6: Coach persona — skillTransfer + project-aware checklist instruction

**Files:**
- Modify: `applications/job-strategist/src/prompts/coach-persona.ts`

- [ ] **Step 1: Add a persona section** (near the technical-stage block) — append to the system prompt array:
```ts
            `── SKILL TRANSFER (technical stage) ───────────────────────────────`,
            `When a "Candidate project evidence per JD skill" block is present:`,
            `• Emit one skillTransfer entry per listed JD skill.`,
            `• Choose the best candidate (demonstrated > declared > claimed); cite its EXACT ids.`,
            `• narrative: "The JD needs <skill>; in <project> you <did X from the candidate row> — `,
            `  here is how that transfers." Ground every claim in the cited row; invent nothing.`,
            `• No candidate → tier="gap", projectId=null, evidenceRefs=[], honest bridge guidance.`,
            `• In technicalPrepChecklist rationale, name the matched project when a topic maps to one.`,
```

- [ ] **Step 2: Build** → `cd applications/job-strategist && yarn build` (tsc clean).

- [ ] **Step 3: Commit**

```bash
git add applications/job-strategist/src/prompts/coach-persona.ts
git commit -m "feat(coach): persona instruction for skillTransfer + project-aware checklist"
```

---

### Task 7: `run-coach` wiring — load, join, inject, fail-open, no-projects omit

**Files:**
- Modify: `applications/job-strategist/src/run-coach.ts`

- [ ] **Step 1: Build the candidate sets before the agent call**

In `run-coach.ts`, after `research`/`constraintBlock`/`evidenceBlock` are built and BEFORE `executeCoachAgent`, add:
```ts
        // Skill-transfer candidate sets (technical stage only, fail-open).
        let skillCandidateSets: import('@bedrock/shared').SkillCandidateSet[] = [];
        if (env.interviewStage.startsWith('technical')) {
            try {
                const evidence = await new RdsProjectEvidenceRepository(pool).load(env.userId);
                if (evidence.projects.length > 0) {
                    const jdSkills = [
                        ...(research?.verifiedMatches ?? []),
                        ...(research?.partialMatches ?? []),
                        ...(research?.gaps ?? []),
                    ].map(m => m.skill).filter((s): s is string => !!s);
                    const uniqueSkills = [...new Set(jdSkills)];
                    skillCandidateSets = joinSkillCandidates(uniqueSkills, evidence);
                }
            } catch (err) {
                log.warn({ err: String(err) }, 'skill-transfer.candidates.failed (non-fatal)');
            }
        }
```
Add imports: `import { RdsProjectEvidenceRepository, joinSkillCandidates } from '@bedrock/shared';`

- [ ] **Step 2: Pass the sets to the agent**

Change the call to:
```ts
        const coaching = await executeCoachAgent(ctx, analysis, constraintBlock, evidenceBlock, skillCandidateSets);
```
(`skillTransfer` is already inside `coaching.data` → persisted by the existing `persistCoachingContent` with no change.)

- [ ] **Step 3: Build + run job-strategist suite**

Run: `cd applications/job-strategist && yarn build && yarn test`
Expected: tsc clean; existing suite + new tests pass.

- [ ] **Step 4: Commit**

```bash
git add applications/job-strategist/src/run-coach.ts
git commit -m "feat(coach): wire skill-transfer candidate sets into run-coach (technical, fail-open)"
```

---

## Self-review
- **Spec coverage:** joinSkillCandidates (T1) ✓; validateSkillTransfer/anti-invention (T2) ✓; case-study + repo-evidence sources via the confirmed join (T3) ✓; skillTransfer on coach output, persisted via topics_to_study, no migration (T4/T5) ✓; coach narrates + project-aware checklist (T5/T6) ✓; run-coach load+join+inject, fail-open, no-projects omit, technical-only (T7) ✓; honesty tiers demonstrated>declared>claimed>gap ✓.
- **Deferred to later PRs (per spec decomposition):** admin-api serve of `skillTransfer` + tucaken `applications.types.ts` (PR 2); UI section + project reference sheet ranking + EvidenceCard (PR 3). Plan those after PR 1's contract is verified end-to-end on dev.
- **Placeholders:** none — full code per step.
- **Type consistency:** `SkillCandidate`/`SkillCandidateSet`/`SkillTransferEntry`/`ProjectEvidenceInput` used identically across T1–T7; `joinSkillCandidates(jdSkills, input)` and `validateSkillTransfer(entries, sets)` signatures stable.

## Verification (after T7, on dev — needs PR #66 coach-on-Sonnet deployed)
Re-dispatch a technical coach run for an app whose user has a project with a case study; confirm `coaching_content.topics_to_study->'skillTransfer'` is present, entries cite only real project/row ids (spot-check against the project's rows), gaps are honest, and the checklist rationale names matched projects.
