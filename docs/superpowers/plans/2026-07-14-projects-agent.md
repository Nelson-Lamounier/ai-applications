# Phase 5 PR-A -- Projects Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dedicated Projects agent over a two-lane pool (curated case-study quotes by id + repo-current research evidence attributed by repository ID), with schema-enforced quote-only selection, provenance-capped composition, an ATS mirror lane, the restoreProjectHighlights gap fix, and Phase-4-grade observability -- writer drops projects to a skeleton.

**Architecture:** Mirror Phase 4's experience-agent stack file-for-file (schema / inputs-loader / provenance / message / agent / ats-flow / diagnostics), plus one NEW structured loader that builds the two-lane pool with fail-closed repo-id attribution. `fillResumeProjects` splices after `fillResumeExperience` and before `fillResumeSummary`. Deterministic fallback assembles curated bullets ranked by strict coverage.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), ts-jest, Zod, prom-client, Bedrock `runAgent`, pino->Loki.

## Global Constraints

- Branch `feat/projects-agent` (exists; spec commits 1306c46b/08dca131/6f183a6e). PR-A scope ONLY -- no analysis/cover-letter/skills agents, no reconciler (PR-B).
- eslint via ROOT `yarn eslint <files>` (no workspace binary); `yarn workspace @bedrock/job-strategist exec tsc --noEmit` (+ shared when touched); full suite green per task; no NEW complexity>10 (extract helpers).
- ASCII ONLY in added lines (`--`, `->`, straight quotes; reviewers grep). English (UK). No `Co-Authored-By`. NEVER `git stash`.
- Prompt edits: bump frontmatter `version` + update prompt-manifest.json sha256 (integrity test prints the hash). Persona golden fixture regen procedure is in `.superpowers/sdd/task-7-report.md` (Phase 4).
- REUSE, never reimplement: `scoreSummaryCoverage` (`ats/gate/summary-coverage.ts`, strict adjacent-phrase), `selectExperienceAtsTargets` (`ats/gate/experience-ats-targets.ts`, top-6 + requirement grouping), `repoOfFile` (`ats/grounding/evidence-lane.ts:33`), `withUserRls` (`lib/rls.ts:26`).
- Truthfulness: curated bullets quote-only BY SCHEMA (ids, system assembles text); composed bullets <=2/project, cite match ids of THAT project's repo-current lane only; unresolved repo names attribute to NO project (fail-closed) and are counted; deterministic fallback = curated-only, never empty when the DB has bullets.
- Verified shapes: `ProjectResumeBulletSet {name, bullets: string[]}` (`agents/evidence/project-evidence-block.ts:44,56`); `VerifiedMatch {skill, sourceCitation, depth, recency, evidenceFiles[]}` -- NO `evidence` field (`shared/src/strategist-types.ts:273-284`); `ProjectBaseSchema {name, description, highlights?, github?}` (`schemas/resume-sections.ts:74-79`); tables: `projects{id,user_id,name,pitch}`, `project_components{id,project_id}`, `project_repositories{project_component_id,repository_id}`, `repositories{id,full_name,github_repo_id}` (migrations 030/084).
- Metadata fold: into the EXISTING `analysis: {...}` literal (shallow jsonb `||` merge -- never a second updatePipelineRunMetadata call).
- Splice order: fillResumeExperience -> **fillResumeProjects** -> fillResumeSummary (summary body must contain real projects).

---

### Task 1: `projects-schema.ts` -- types + Zod + emit tool schema

**Files:**
- Create: `applications/job-strategist/src/agents/writer/projects-schema.ts`
- Test: `applications/job-strategist/src/agents/writer/__tests__/projects-schema.test.ts`

**Interfaces (produces):**

```typescript
export type ProjectsAgentHighlight =
  | { readonly bulletId: string }                                   // curated quote by id
  | { readonly text: string; readonly sources: string[] };          // composed, match-cited
export interface ProjectsAgentEntry {
  readonly name: string;
  readonly github: string;
  readonly description: string;
  readonly highlights: ProjectsAgentHighlight[];
}
export interface ProjectsAgentOutput { readonly entries: ProjectsAgentEntry[]; }
export const ProjectsAgentOutputSchema: z.ZodType<ProjectsAgentOutput>;
export const PROJECTS_EMIT_INPUT_SCHEMA: object;  // forced-tool JSON schema
export function isCurated(h: ProjectsAgentHighlight): h is { bulletId: string };
```

- [ ] **Step 1: Failing test**

```typescript
/** @format */
import { describe, it, expect } from '@jest/globals';
import { ProjectsAgentOutputSchema, isCurated } from '../projects-schema.js';

describe('ProjectsAgentOutputSchema', () => {
  it('accepts curated-id and composed-cited highlight variants', () => {
    const out = ProjectsAgentOutputSchema.parse({
      entries: [{
        name: 'Tucaken', github: 'github.com/o/tucaken-app', description: 'A platform.',
        highlights: [{ bulletId: 'p0.b1' }, { text: 'Applied DNS hardening across the API', sources: ['p0.r1'] }],
      }],
    });
    expect(isCurated(out.entries[0]!.highlights[0]!)).toBe(true);
    expect(isCurated(out.entries[0]!.highlights[1]!)).toBe(false);
  });
  it('rejects a highlight that is neither variant, and a composed bullet without sources', () => {
    expect(() => ProjectsAgentOutputSchema.parse({
      entries: [{ name: 'X', github: '', description: '', highlights: [{ nonsense: true }] }],
    })).toThrow();
    expect(() => ProjectsAgentOutputSchema.parse({
      entries: [{ name: 'X', github: '', description: '', highlights: [{ text: 'no citation', sources: [] }] }],
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run -- FAIL** (`yarn workspace @bedrock/job-strategist test -- projects-schema`).
- [ ] **Step 3: Implement**

```typescript
/** @format */
import { z } from 'zod';

const CuratedHighlightSchema = z.object({ bulletId: z.string().min(1) }).strict();
const ComposedHighlightSchema = z.object({
  text: z.string().min(1),
  sources: z.array(z.string().min(1)).min(1),
}).strict();
export const ProjectsAgentHighlightSchema = z.union([CuratedHighlightSchema, ComposedHighlightSchema]);
export const ProjectsAgentEntrySchema = z.object({
  name: z.string(),
  github: z.string().catch(''),
  description: z.string(),
  highlights: z.array(ProjectsAgentHighlightSchema),
});
export const ProjectsAgentOutputSchema = z.object({ entries: z.array(ProjectsAgentEntrySchema) });

export type ProjectsAgentHighlight = z.infer<typeof ProjectsAgentHighlightSchema>;
export type ProjectsAgentEntry = z.infer<typeof ProjectsAgentEntrySchema>;
export type ProjectsAgentOutput = z.infer<typeof ProjectsAgentOutputSchema>;

export function isCurated(h: ProjectsAgentHighlight): h is { bulletId: string } {
  return 'bulletId' in h;
}

/** Forced-tool input schema for emit_projects (constrained decoding). */
export const PROJECTS_EMIT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' }, github: { type: 'string' }, description: { type: 'string' },
          highlights: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                bulletId: { type: 'string' },
                text: { type: 'string' },
                sources: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
        required: ['name', 'description', 'highlights'],
      },
    },
  },
  required: ['entries'],
} as const;
```

(The JSON tool schema cannot express the XOR -- the Zod union + Task 3 validator enforce it.)

- [ ] **Step 4: Run -- PASS.**
- [ ] **Step 5: Lint + tsc + commit** `feat(job-strategist): projects agent schema -- curated-id XOR composed-cited highlights`

### Task 2: `project-agent-inputs.ts` -- structured two-lane pool loader

**Files:**
- Create: `applications/job-strategist/src/agents/evidence/project-agent-inputs.ts`
- Test: `applications/job-strategist/src/agents/evidence/__tests__/project-agent-inputs.test.ts`

**Interfaces (produces):**

```typescript
export interface CuratedBullet { readonly id: string; readonly text: string; }              // id = p{i}.b{j}
export interface RepoCurrentFact {
  readonly id: string;                                                                     // p{i}.r{k}
  readonly skill: string; readonly sourceCitation: string;
  readonly repositoryId: string; readonly githubRepoId: number | null; readonly fullName: string;
}
export interface ProjectPoolEntry {
  readonly index: number; readonly name: string; readonly pitch: string;
  readonly repoUrls: string[];                     // "github.com/<full_name>" forms
  readonly curated: CuratedBullet[];
  readonly repoCurrent: RepoCurrentFact[];
}
export interface ProjectAgentInputs {
  readonly pool: ProjectPoolEntry[];
  readonly unresolvedRepos: string[];              // owner/repo names that failed id-resolution
}
export function buildProjectPool(
  bulletSets: readonly { name: string; bullets: string[] }[],
  projectMeta: readonly { projectId: string; name: string; pitch: string; repositoryIds: string[]; repoFullNames: string[] }[],
  repoLookup: ReadonlyMap<string, { id: string; githubRepoId: number | null }>,   // full_name -> row
  verifiedMatches: readonly { skill: string; sourceCitation: string; evidenceFiles: string[] }[],
): ProjectAgentInputs;
export async function loadProjectAgentInputs(pool: Pool, userId: string,
  verifiedMatches: readonly { skill: string; sourceCitation: string; evidenceFiles: string[] }[],
): Promise<ProjectAgentInputs>;
```

`buildProjectPool` is PURE (unit-tested without a DB); `loadProjectAgentInputs` runs the SQL inside `withUserRls` (the project_resume_bullets RLS footgun -- see `project-evidence-block.ts:58-73`) and delegates to it.

- [ ] **Step 1: Failing test (pure builder)**

```typescript
/** @format */
import { describe, it, expect } from '@jest/globals';
import { buildProjectPool } from '../project-agent-inputs.js';

const bulletSets = [{ name: 'Tucaken', bullets: ['Built an event-driven API on SQS/SNS', 'Cut sync time 40%'] }];
const projectMeta = [{
  projectId: 'proj-1', name: 'Tucaken', pitch: 'A job platform for candidates.',
  repositoryIds: ['repo-uuid-1'], repoFullNames: ['o/tucaken-app'],
}];
const repoLookup = new Map([['o/tucaken-app', { id: 'repo-uuid-1', githubRepoId: 42 }]]);
const matches = [
  { skill: 'DNS', sourceCitation: 'o/tucaken-app/infra/dns.ts', evidenceFiles: ['o/tucaken-app/infra/dns.ts'] },
  { skill: 'Kafka', sourceCitation: 'o/other-repo/stream.ts', evidenceFiles: ['o/other-repo/stream.ts'] },   // repo owned by no project
  { skill: 'Go', sourceCitation: 'career history', evidenceFiles: [] },                                      // no repo provenance
  { skill: 'TLS', sourceCitation: 'o/renamed-repo/tls.ts', evidenceFiles: ['o/renamed-repo/tls.ts'] },       // unresolvable name
];

describe('buildProjectPool', () => {
  it('indexes curated bullets and attributes matches by repository id', () => {
    const r = buildProjectPool(bulletSets, projectMeta, repoLookup, matches);
    const p = r.pool[0]!;
    expect(p.curated.map((b) => b.id)).toEqual(['p0.b0', 'p0.b1']);
    expect(p.repoCurrent).toHaveLength(1);
    expect(p.repoCurrent[0]).toMatchObject({ id: 'p0.r0', skill: 'DNS', repositoryId: 'repo-uuid-1', githubRepoId: 42, fullName: 'o/tucaken-app' });
  });
  it('fails closed: no-provenance and unowned-repo matches attribute nowhere; unresolved names are reported', () => {
    const r = buildProjectPool(bulletSets, projectMeta, repoLookup, matches);
    expect(r.pool[0]!.repoCurrent.map((f) => f.skill)).not.toContain('Kafka');
    expect(r.pool[0]!.repoCurrent.map((f) => f.skill)).not.toContain('Go');
    expect(r.unresolvedRepos).toEqual(['o/renamed-repo']);   // Kafka's repo RESOLVES via lookup? no -- see below
  });
  it('a repo owned by two projects contributes its matches to both', () => {
    const meta2 = [...projectMeta, { projectId: 'proj-2', name: 'Infra', pitch: 'Infra for Tucaken.', repositoryIds: ['repo-uuid-1'], repoFullNames: ['o/tucaken-app'] }];
    const r = buildProjectPool([...bulletSets, { name: 'Infra', bullets: ['Provisioned EKS'] }], meta2, repoLookup, matches.slice(0, 1));
    expect(r.pool[0]!.repoCurrent).toHaveLength(1);
    expect(r.pool[1]!.repoCurrent).toHaveLength(1);
  });
});
```

NOTE on the second test: `o/other-repo` is NOT in `repoLookup`, so it is BOTH unresolved AND unowned -- the expectation must be `expect(r.unresolvedRepos.sort()).toEqual(['o/other-repo', 'o/renamed-repo'])`. Write the test with that corrected expectation (the inline comment above is the reasoning, not the assertion). A name that RESOLVES via the lookup but whose repository id is in no project's set attributes nowhere and is NOT in unresolvedRepos -- add a fourth case for that: put `{ id: 'repo-uuid-9', githubRepoId: 9 }` under `'o/lonely-repo'` in the lookup and a match citing it; assert it is absent from both `repoCurrent` and `unresolvedRepos`.

- [ ] **Step 2: Run -- FAIL.**
- [ ] **Step 3: Implement.** Pure part:

```typescript
/** @format */
import type { Pool } from 'pg';
import { repoOfFile } from '../../ats/grounding/evidence-lane.js';
import { withUserRls } from '../../lib/rls.js';
import { loadProjectResumeBullets } from './project-evidence-block.js';

// ... interfaces from the block above ...

export function buildProjectPool(bulletSets, projectMeta, repoLookup, verifiedMatches): ProjectAgentInputs {
  const unresolved = new Set<string>();
  // Resolve each match to a repository row once.
  const matchRepo = verifiedMatches.map((m) => {
    const names = new Set([...m.evidenceFiles, m.sourceCitation].map(repoOfFile).filter((x): x is string => x !== null));
    for (const n of names) if (!repoLookup.has(n)) unresolved.add(n);
    const resolved = [...names].map((n) => ({ fullName: n, row: repoLookup.get(n) })).filter((x) => x.row);
    return { match: m, resolved };
  });
  const pool = projectMeta.map((meta, i) => {
    const bullets = bulletSets.find((s) => s.name === meta.name)?.bullets ?? [];
    const idSet = new Set(meta.repositoryIds);
    const repoCurrent: RepoCurrentFact[] = [];
    for (const { match, resolved } of matchRepo) {
      const hit = resolved.find((r) => idSet.has(r.row!.id));
      if (hit) repoCurrent.push({
        id: `p${i}.r${repoCurrent.length}`, skill: match.skill, sourceCitation: match.sourceCitation,
        repositoryId: hit.row!.id, githubRepoId: hit.row!.githubRepoId, fullName: hit.fullName,
      });
    }
    return {
      index: i, name: meta.name, pitch: meta.pitch,
      repoUrls: meta.repoFullNames.map((f) => `github.com/${f}`),
      curated: bullets.map((text, j) => ({ id: `p${i}.b${j}`, text })),
      repoCurrent,
    };
  });
  return { pool, unresolvedRepos: [...unresolved].sort() };
}
```

`loadProjectAgentInputs`: inside `withUserRls(pool, userId, async (client) => ...)` run three queries -- (1) `SELECT p.id, p.name, COALESCE(p.pitch,'') AS pitch FROM projects p WHERE p.user_id=$1 AND p.status <> 'archived'`; (2) `SELECT pc.project_id, pr.repository_id, r.full_name, r.github_repo_id FROM project_repositories pr JOIN project_components pc ON pc.id = pr.project_component_id JOIN repositories r ON r.id = pr.repository_id WHERE pr.user_id = $1`; (3) reuse `loadProjectResumeBullets(pool, userId)` (it manages its own RLS). Build `projectMeta` + `repoLookup` from (1)+(2), delegate to `buildProjectPool`. Mock-pool test: a `{ query: async (sql) => ... }` stub returning canned rows keyed on a table-name substring; assert the assembled `ProjectAgentInputs` and that queries filter by `$1 = userId`.

- [ ] **Step 4: Run -- PASS (all 4 pure cases + the loader test).**
- [ ] **Step 5: Lint + tsc + commit** `feat(job-strategist): project agent inputs -- two-lane pool with fail-closed repo-id attribution`

### Task 3: `projects-provenance.ts` -- validator + assembler + error

**Files:**
- Create: `applications/job-strategist/src/agents/writer/projects-provenance.ts`
- Test: `applications/job-strategist/src/agents/writer/__tests__/projects-provenance.test.ts`

**Interfaces (produces):**

```typescript
export class ProjectsProvenanceError extends Error { readonly violations: string[]; }
export function validateProjectsProvenance(out: ProjectsAgentOutput, pool: readonly ProjectPoolEntry[]): string[];
export function assembleProjects(out: ProjectsAgentOutput, pool: readonly ProjectPoolEntry[]):
  Array<{ name: string; description: string; github?: string; highlights: string[] }>;   // conforms to ProjectBaseSchema
```

Violation tokens (pinned, machine-readable): `unknown_project:<name>`, `duplicate_project:<name>`, `missing_project:<name>` (a documented project with a non-empty curated pool absent from the output), `unknown_bullet:<name>:<id>`, `duplicate_bullet:<name>:<id>`, `cross_project_citation:<name>:<id>` (curated id or composed source id belonging to another project's pool), `composed_cap:<name>:<n>` (>2 composed), `uncited_composed:<name>:<idx>` (handled by schema but re-checked), `bullet_count:<name>:<n>` (outside [min(3,poolSize),6] where poolSize = curated+composed available; roles with pool <3 use poolSize as min), `github_mismatch:<name>` (github non-empty and not in that project's repoUrls set), `description_words:<name>:<n>` (>40), `pitch_overlap:<name>` (<30% distinctive-token overlap between description and pitch -- same bar as checkProjectPitchAlignment; reuse its token approach: lowercase alnum tokens len>3, overlap = |desc  AND  pitch| / |pitch tokens| when pitch has tokens).

Rules for `assembleProjects`: curated `{bulletId}` -> the pool bullet's text VERBATIM; composed -> its `text`; order preserved; `github` = the emitted github when valid else the project's first repoUrl; only projects present in the output are emitted (validator's `missing_project` gate runs first).

- [ ] **Step 1: Failing test** -- cover: clean output passes; one case per violation token (12 cases -- terse fixtures, mutate a `structuredClone` of the good output per case, assert `toContain(token)`); assembler produces verbatim curated text + composed text in order and conforms shape-wise (has `name/description/highlights` string arrays).
- [ ] **Step 2: Run -- FAIL.**
- [ ] **Step 3: Implement** -- single pass over `out.entries` with a `Map(pool.map(p => [p.name, p]))`; curated/composed id membership via per-project `Set`s; a global id->project index for `cross_project_citation`; word count = `split(/\s+/)`; overlap helper `distinctiveTokens(s) = s.toLowerCase().replace(/[^a-z0-9]+/g,' ').split(/\s+/).filter(t => t.length > 3)`. Keep the validator under complexity 10 by extracting `validateEntry(entry, poolEntry, globalIndex): string[]`.
- [ ] **Step 4: Run -- PASS.**
- [ ] **Step 5: Lint + tsc + commit** `feat(job-strategist): projects provenance -- quote-only ids, strict cross-project citation, pitch-overlap gate`

### Task 4: `projects-message.ts`

**Files:**
- Create: `applications/job-strategist/src/agents/writer/projects-message.ts`
- Test: `applications/job-strategist/src/agents/writer/__tests__/projects-message.test.ts`

**Interfaces (produces):**

```typescript
export interface ProjectsMessageInput {
  readonly pool: readonly ProjectPoolEntry[];
  readonly atsTargets: readonly ExperienceAtsTarget[];   // reuse Phase 4 type
  readonly targetRole: string;
  readonly rewriteDraft?: string;
  readonly rewriteMissing?: readonly string[];
}
export function buildProjectsMessage(m: ProjectsMessageInput): string;
```

Sections: `## Documented Projects (two-lane pool)` -- per project `### <name> -- <pitch>` + `Repos: <urls>` + `Curated bullets (quote-only, select by id):` `[p0.b0] ...` + `Repo-current evidence (compose at most 2 bullets per project, cite ids):` `[p0.r0] DNS -- o/tucaken-app/infra/dns.ts`; `## ATS Targets` grouped by requirement (only when non-empty; same shape as experience-message); `## Composition rules` (curated first; compose ONLY for a JD target the curated pool does not answer; max 2; description <=40 words grounded in the pitch; one entry per project; github from the repo list); `## Re-write pass` only when rewriteDraft + non-empty rewriteMissing.

- [ ] **Step 1: Failing test** -- asserts: `[p0.b0]` and `[p0.r0]` lines present; ATS section grouped under the requirement text and omitted when `atsTargets: []`; rewrite section only on the rewrite pass; composition-rules section always present.
- [ ] **Step 2: FAIL.** **Step 3: Implement** (helper per section, mirroring `experience-message.ts` structure). **Step 4: PASS.** **Step 5: Lint + tsc + commit** `feat(job-strategist): projects agent message -- two-lane pool, grouped targets, composition rules`

### Task 5: persona + prompt module + `executeProjectsAgent`

**Files:**
- Create: `applications/job-strategist/src/prompts/content/strategist/projects-agent.md` (frontmatter `id: strategist-projects`, `version: 1`, `cachePoint: default`)
- Modify: `applications/job-strategist/src/prompts/prompt-manifest.json` (+1 entry via integrity test)
- Create: `applications/job-strategist/src/prompts/strategist-projects.ts` (mirror `strategist-experience.ts`: `loadPersona('strategist/projects-agent')`, exports `STRATEGIST_PROJECTS_META` + `STRATEGIST_PROJECTS_SYSTEM_PROMPT`)
- Create: `applications/job-strategist/src/agents/writer/projects-agent.ts`
- Test: `applications/job-strategist/src/agents/writer/__tests__/projects-agent.test.ts`, `applications/job-strategist/src/prompts/__tests__/strategist-projects-persona.test.ts`

Persona body (ASCII, verbatim base -- adjust only if integrity/goldens demand):

```text
ROLE: you are the dedicated Projects composer. You receive the candidate's
documented projects as a TWO-LANE pool: curated case-study bullets (verbatim
quotes, selectable by id only) and repo-current evidence facts (fresh from the
synced repositories, citable by id). You SELECT and ORDER curated bullets
against the JD and may COMPOSE at most 2 bullets per project from repo-current
facts -- ONLY for a JD target the curated pool cannot answer.

QUOTE-ONLY CONTRACT (hard): curated bullets are emitted as {bulletId} -- never
retype or edit their text; the system assembles the words. Composed bullets are
emitted as {text, sources: [factId]} citing repo-current ids of THAT project
only. Never cite across projects; never write a bullet no fact supports.

STRUCTURE: ONE entry per documented project, name verbatim, github from the
project's own repo list. 3-6 bullets per project (fewer only when the pool is
smaller), ordered by JD relevance -- the lead bullet answers this JD's most
important requirement that this project can honestly answer.

DESCRIPTION: 1-2 sentences, 40 words max, grounded in the documented pitch --
what it is, who it serves, ONE JD-relevant differentiator. Never a stack dump;
never contradict the pitch.

Emit ONLY via the emit_projects tool.
```

`projects-agent.ts` mirrors `experience-agent.ts`: `PROJECTS_CONFIG` (agentName `'strategist-projects'` -- cast `as AgentName` with `// Task 6 adds these to the union` comment; modelId from `STRATEGIST_MODEL`/`INFERENCE_PROFILE_ARN`; maxTokens 3000; thinkingBudget 0; tool `emit_projects` with `PROJECTS_EMIT_INPUT_SCHEMA`; promptId/promptVersion from META); `executeProjectsAgent(ctx, input: ProjectsMessageInput, opts?: { agentName?: AgentName })`; `parseResponse` = `ProjectsAgentOutputSchema.parse(parseJsonResponse(text, 'strategist-projects'))`.

- [ ] **Step 1:** persona file; integrity test prints hash -> manifest entry `strategist/projects-agent` -> PASS.
- [ ] **Step 2:** prompt module (mirror file).
- [ ] **Step 3:** failing agent test -- copy `__tests__/experience-agent.test.ts`'s runAgent mock pattern; assert config agentName/tool/thinkingBudget 0, opts.agentName override to `'strategist-projects-rewrite'`, Zod-throw on malformed.
- [ ] **Step 4:** implement; tests PASS. Persona pin test: loaded persona contains `QUOTE-ONLY CONTRACT`, `TWO-LANE`, `40 words`, `emit_projects`.
- [ ] **Step 5:** full targeted suites + lint + tsc + commit `feat(job-strategist): dedicated projects agent -- persona, forced tool, two-lane contract`

### Task 6: AgentName additions + cast cleanup

**Files:** Modify `applications/shared/src/types.ts` (append `| 'strategist-projects' | 'strategist-projects-rewrite'` after `'strategist-experience-rewrite'`); remove the Task-5 casts + comments in `projects-agent.ts` and its test.

- [ ] Steps: edit union -> `yarn workspace @bedrock/shared exec tsc --noEmit` + `yarn workspace @bedrock/shared build` (dist gitignored, never commit) -> job-strategist tsc clean -> remove casts -> targeted test PASS -> ROOT eslint on 3 files -> commit ONLY the 3 files: `feat(shared): projects agent names for isolated cost`

### Task 7: `projects-ats-flow.ts` -- resolveProjectsAts + deterministic fallback

**Files:**
- Create: `applications/job-strategist/src/agents/writer/projects-ats-flow.ts`
- Test: `applications/job-strategist/src/agents/writer/__tests__/projects-ats-flow.test.ts`

**Interfaces (produces):**

```typescript
export interface ProjectsAgentDiagnostics {
  readonly targets: ExperienceAtsTarget[];
  readonly coverageBefore: SummaryCoverage;
  readonly rewrite: { fired: boolean; reason: string | null; coverageAfter: SummaryCoverage | null;
                      kept: 'first' | 'rewrite' | null; keptReason: string | null };
  readonly fallback: { fired: boolean; reason: string | null };
  readonly provenance: { firstViolations: string[]; rewriteViolations: string[]; composedCount: number };
  readonly unresolvedRepos: string[];
}
export function joinProjectsText(out: ProjectsAgentOutput, pool: readonly ProjectPoolEntry[]): string; // descriptions + assembled bullets
export function deterministicProjects(pool: readonly ProjectPoolEntry[], targets: readonly ExperienceAtsTarget[]):
  Array<{ name: string; description: string; github?: string; highlights: string[] }>;
export async function resolveProjectsAts(params: {
  first: ProjectsAgentOutput; pool: readonly ProjectPoolEntry[]; targets: readonly ExperienceAtsTarget[];
  rewrite: (draftText: string, missing: string[]) => Promise<ProjectsAgentOutput>;
}): Promise<{ output: ProjectsAgentOutput; diag: ProjectsAgentDiagnostics }>;
```

Mirror `experience-ats-flow.ts` exactly: PRECONDITION first pass pre-validated; fire when `targets.length > 0 && covered < targets.length` over `scoreSummaryCoverage(joinProjectsText(first, pool), targets)`; rewrite guard = `validateProjectsProvenance` clean (no namesGap for projects); `decideKeepProjects(firstCovered, rewriteCovered, rewriteValid)` -- valid + strictly-more wins, else first (`no-coverage-gain` / `rewrite-provenance-invalid` / `rewrite-threw`); draft text = per-project `name` + `- bullet` lines. `deterministicProjects`: per pool entry with non-empty curated lane -- rank curated bullets by `scoreSummaryCoverage(bullet, targets).covered` desc (stable on ties), take top 6 (min 3 when pool >= 3), description = pitch words 0..40 joined, github = first repoUrl; skip projects with an empty curated pool.

- [ ] **Step 1: Failing test** -- 6 cases: coverage-met no-fire; fires + valid rewrite covering more kept; no-gain keeps first; throw keeps first; invalid rewrite (cross-project citation fixture) keeps first with violations recorded; `deterministicProjects` ranks a DNS-target bullet to the lead position and trims a >40-word pitch to 40 words.
- [ ] **Step 2: FAIL.** **Step 3: Implement.** **Step 4: PASS.** **Step 5: Lint + tsc + commit** `feat(job-strategist): projects ATS lane -- strict coverage, bounded re-write, curated-only deterministic fallback`

### Task 8: writer skeleton migration + `fillResumeProjects` splice

**Files:**
- Modify: `applications/job-strategist/src/prompts/content/strategist/projects.md` (replace body with skeleton rule; bump version)
- Modify: `applications/job-strategist/src/prompts/prompt-manifest.json`
- Modify: `applications/job-strategist/src/agents/writer/strategist-message.ts` (drop `buildProjectEvidence` + `buildProjectResumeBullets` sections from the writer message -- READ first; the blocks move to the agent payload. `projectEvidenceBlock` stays for RESEARCH grounding at run-pipeline ~:960, untouched)
- Modify: `applications/job-strategist/src/run-pipeline.ts` (splice + loader call)
- Possibly regen: persona golden fixture + `strategist-persona.test.ts` assertions (positive pins of the new skeleton rule)

projects.md skeleton rule:

```text
PROJECTS -- SKELETON ONLY: emit "projects": [] (empty array). Do NOT compose
project entries -- a dedicated projects pass authors them from the documented
case-study bullets and repo-current evidence after this body is generated.
```

run-pipeline wiring (READ the real code first; `fillResumeExperience` ~:1249 is the structural template):

```typescript
// after fillResumeExperience + its observability block, BEFORE fillResumeSummary:
const projectAgentInputs = await loadProjectAgentInputs(pool, env.userId, researchData.verifiedMatches);
const projectsAgentDiag = await fillResumeProjects(
  ctx, tailoredResumeData, projectAgentInputs, experienceAtsTargets /* reuse the same top-6 targets */,
  researchData.targetRole, projectsOutcomeMetric,
  (err) => log.warn({ pipelineRunId: env.pipelineRunId, agent: 'strategist-projects',
    err: err instanceof Error ? err.message : String(err) }, 'projects_agent_failed_deterministic_fallback_used'),
);
```

`fillResumeProjects` (module-level, mirrors `fillResumeExperience`): empty pool (no projects or no curated bullets anywhere) -> return null leaving `projects: []`; first pass -> `validateProjectsProvenance` -> invalid throws `ProjectsProvenanceError` -> catch: `tailoredResumeData.projects = deterministicProjects(pool, targets)` + outcome fallback + onFallback; valid -> `resolveProjectsAts` -> `tailoredResumeData.projects = assembleProjects(output, pool)` + outcome agent; returns diagnostics. Counter this task: `job_strategist_projects_agent_outcome_total{outcome}` (Task 10 enriches). NOTE: `relocateProjectExperience`/`fillEmptyHighlights`/`restoreProjectHighlights` remain downstream unchanged (net).

- [ ] Steps: persona edit + manifest + goldens -> failing wiring concerns are covered by the FULL suite (adapt any fixture asserting writer-authored projects to the skeleton contract, document each) -> implement -> full suite green -> lint/tsc -> commit `feat(job-strategist): projects agent splice -- writer emits projects skeleton, agent authors entries`

### Task 9: restoreProjectHighlights post-ATS-loop gap fix

**Files:**
- Modify: `applications/job-strategist/src/run-pipeline.ts` (ATS attainable loop, after the surfaceKeywords -> length -> revalidate -> integrity sequence ~:1505-1530, BEFORE the re-persist)
- Test: `applications/job-strategist/src/agents/quality/__tests__/restore-project-highlights-loop.test.ts` (pure regression on the helper semantics: given a pre-loop snapshot with highlights and a post-loop resume with fewer/blanked highlights, `restoreProjectHighlights(after, before)` restores them; given MORE highlights after, it does not clobber)

- [ ] **Step 1:** failing pure test against the EXISTING `restoreProjectHighlights` export (read `relocate-project-experience.ts:140-161` for the real signature/order of args).
- [ ] **Step 2:** confirm it passes against the existing implementation (it should -- this pins semantics), then add the run-pipeline call: `surfaced = restoreProjectHighlights(surfaced, projectHighlightsSnapshot)` (match real variable names) immediately before the loop's re-persist, with a one-line comment naming the gap. Full suite green.
- [ ] **Step 3:** lint/tsc; commit `fix(job-strategist): restore project highlights after the ATS keyword loop re-emit -- closes the silent blanking path`

### Task 10: observability

**Files:**
- Create: `applications/job-strategist/src/agents/writer/projects-agent-diagnostics.ts` + `__tests__/projects-agent-diagnostics.test.ts` (mirror `experience-agent-diagnostics.ts`)
- Modify: `applications/job-strategist/src/run-pipeline.ts`

Deliverables: `logProjectsAgentEvents(log, keys, diag)` -- events `projects_agent_targets/_scored/_rewrite/_provenance_reject/_fallback` + `projects_repo_unresolved` (emitted once with the name list when `diag.unresolvedRepos.length > 0`), all keyed pipeline_run_id/application_id/trace_id(null). `projectsAgentOutcome(diag)` bounded: fallback+firstViolations -> `'provenance-invalid'`, fallback -> `'agent-error'`, rewrite fired -> keptReason, else reason ?? `'coverage-met'`. run-pipeline: relabel Counter to `{outcome,reason}`; coverage Histogram `job_strategist_projects_agent_coverage` buckets [0..6] observed when targets>0 && !fallback; NEW generalised `job_strategist_section_net_fired_total{section,pass}` -- emit for BOTH experience and projects at the existing net sites (guard/length/surface_keywords, projects snapshot via `JSON.stringify(resume.projects ?? null)`) while the old `job_strategist_experience_net_fired_total` KEEPS emitting (PR-B removes it); Counter `job_strategist_projects_repo_unresolved_total` inc by `unresolvedRepos.length`; fold `projectsAgent: projectsAgentDiag` into the EXISTING analysis metadata literal. Tests: event shapes incl. unresolved event; bounded outcome mapping; no-rewrite-event-when-not-fired.

- [ ] Steps: failing tests -> implement -> full suite -> lint/tsc (extract helpers; no new complexity errors -- use `trackNetFired`-style helper with a `section` param) -> commit `feat(job-strategist): projects agent observability -- events, metadata fold, bounded metrics, generalised net counter`

### Task 11: evals + runbook

**Files:**
- Create: `applications/job-strategist/src/evals/projects/projects-graders.ts` + `fixtures.ts` + `projects-graders.test.ts`
- Create: `docs/runbooks/projects-agent-observability.md` (mirror the experience one)

Graders (mkResult pattern, vacuous-pass discipline): `provenanceGrader` (delegates to `validateProjectsProvenance`); `quoteFidelityGrader` (every curated-id bullet's ASSEMBLED text is byte-identical to the pool bullet -- guards the assembler); `compositionGrader` (composed bullets <=2/project, each cites in-project fact ids, and each composed bullet's target skill is NOT answerable by any curated bullet -- strict-coverage check of the cited fact's skill against each curated bullet); `atsCoverageGrader` (reuse `scoreSummaryCoverage` over joined text, covered >= min(2, targets), vacuous on none); `descriptionGrader` (<=40 words + >=30% pitch overlap). Fixtures: `GOLDEN_TWO_LANE` -- curated pool answering 2 targets + a repo-current DNS fact composing the third (the STALENESS scenario: JD target only answerable from the repo-current lane); adversarials: cross-project citation, retyped curated text (quoteFidelityGrader catches), 3 composed bullets. Runbook: metrics/events/SQL (metadata->'analysis'->'projectsAgent'), the unresolved-repos triage query, cost via `agent LIKE 'strategist-projects%'`.

- [ ] Steps: failing tests -> implement -> PASS -> full suite -> ASCII check on the runbook -> commit `test(job-strategist): projects eval -- quote fidelity, staleness golden, composition caps + runbook`

---

## Self-Review

**Spec coverage (PR-A section):** two-lane pool + id attribution + fail-closed -> T2; quote-only-by-schema -> T1+T3 (+quoteFidelityGrader T11); composed cap + cross-project violation -> T3; message + composition rules -> T4; agent + persona -> T5; names -> T6; ATS lane + deterministic fallback -> T7; writer skeleton + splice order (experience -> projects -> summary) -> T8; restore gap -> T9; observability incl. generalised net counter + unresolved counter + metadata fold -> T10; evals incl. staleness golden + runbook -> T11. PR-B items (analysis/cover-letter/skills/reconciler/parallelisation/old-counter removal) intentionally absent.

**Placeholder scan:** T5 persona is verbatim; T2/T3/T7 carry either full code or exact rule/token lists; wiring tasks (T8/T9/T10) reference the real files to read with exact insertion points and code sketches whose variable names must be adapted -- consistent with the Phase-4 plan style that executed cleanly. No TBDs.

**Type consistency:** `ProjectPoolEntry`/`CuratedBullet`/`RepoCurrentFact` (T2) consumed by T3/T4/T7/T8; `ProjectsAgentOutput` (T1) by T3/T5/T7; `validateProjectsProvenance`/`assembleProjects`/`ProjectsProvenanceError` (T3) by T7/T8; `ExperienceAtsTarget`+`scoreSummaryCoverage` reused (Phase 4); `resolveProjectsAts` return `{output, diag}` consumed in T8; diagnostics fields (T7) consumed by T10's emitter/outcome mapper.
