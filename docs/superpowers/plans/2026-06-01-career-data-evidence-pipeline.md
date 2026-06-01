# Career-Data Evidence Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make résumé Career Data a first-class, citeable evidence source in the job-analysis → coach pipeline, and stop the grounding verifier from silently dropping valid analyses.

**Architecture:** Three independent PRs. **A** wires career data into the Research agent (baseline-embed at import + a read-only `experience_embeddings` vector adapter + hybrid structured-injection & vector-retrieval). **B** flips the strategist grounding verifier from `block` to `flag` (serve, don't replace). **C** feeds `research` evidence into the coach prompt.

**Tech Stack:** TypeScript (ESM/NodeNext, `.js` imports), Jest, AWS Bedrock (Titan v2 embeddings, Haiku), `pg`/pgvector.

**Spec:** `docs/superpowers/specs/2026-06-01-career-data-evidence-pipeline-design.md`

**Branch:** `feat/career-data-evidence-pipeline` (off `develop`). Each PR can be its own branch off `develop`; or stack A→B→C. Recommend three separate branches/PRs into `develop`.

---

## Three PRs

- **PR-A** — Career data into analysis (Tasks A1–A6). The core.
- **PR-B** — Grounding `block→flag` (Task B1). Small, independent.
- **PR-C** — Coach consumes research (Task C1). Small, independent.

B and C are valuable even before A. Implement in any order; A is largest.

**Test runners (verify before writing tests):** `applications/shared` → `npx jest`; `applications/job-strategist` → `npx jest`; `applications/resume-import-processor` → check its `package.json` `"test"` (Task A1 Step 0). Conventions: files start `/** @format */`, ESM `.js` imports, `import { describe, it, expect, jest } from '@jest/globals'`.

---

# PR-A — Career data into the Research/analysis pipeline

## PR-A File Structure

| File | Responsibility | Action |
|---|---|---|
| `applications/resume-import-processor/src/run-import.ts` | call existing `embedAndPersistEntry(... enriched=null ...)` per experience entry at import | Modify |
| `applications/shared/src/rds/implementations/RdsExperienceVectorStore.ts` | read-only `querySimilar` over `experience_embeddings` → `SimilarityResult[]` | Create |
| `applications/shared/src/rds/implementations/RdsExperienceVectorStore.test.ts` | `fakePool` unit tests | Create |
| `applications/shared/src/index.ts` | export `RdsExperienceVectorStore` | Modify |
| `applications/job-strategist/src/agents/career-history.ts` | `loadCareerHistory(pool,userId)` + `formatCareerHistory(rows)` | Create |
| `applications/job-strategist/src/agents/career-history.test.ts` | unit tests (format + empty) | Create |
| `applications/job-strategist/src/agents/research-agent.ts` | widen `querySingleRds` store type; add career vector query + structured injection | Modify |

---

## Task A1: Baseline-embed career entries at import

**Files:**
- Modify: `applications/resume-import-processor/src/run-import.ts` (after `persistCareerEntries`, ~line 311)

`embedAndPersistEntry(pool, region, userId, careerEntryId, experience, null, importId)` already builds baseline chunks (`role_description` + one `achievement` per highlight) when `enriched=null`, and is idempotent (skips existing `content_hash`). So baseline embedding = call it per experience entry at import. Enrichment later adds enriched chunks (same hashes skipped — no dupes).

- [ ] **Step 0: Confirm runner.** `cat applications/resume-import-processor/package.json` → note `"test"` script. If no jest, the A1 test becomes a manual verification (note it); do not invent a runner.

- [ ] **Step 1: Read the current Step 4 block.** In `run-import.ts`, find where `persistCareerEntries(...)` is called and returns `experienceIds`, followed by `updateImportStatus(..., 'ready_for_review', ...)`. Confirm `data.experience[i]` aligns with `experienceIds[i]` (both are the `'experience'` entries, in order — verified: `persistCareerEntries` pushes to `createdIds` only for `entry_type='experience'`, in `data.experience` order).

- [ ] **Step 2: Add the baseline-embed loop** immediately AFTER `persistCareerEntries(...)` returns and BEFORE the `ready_for_review` status update. Insert:

```typescript
      // Baseline embeddings at import — career data is retrievable immediately,
      // not only after the user confirms enrichment. Reuses the enrichment embed
      // path with enriched=null (role_description + achievement chunks). Idempotent
      // by content_hash, so run-enrichment later adds enriched chunks without dupes.
      // Non-fatal: a failed embed must not block the import reaching review.
      {
        const { embedAndPersistEntry } = await import('./embed.js');
        const region = process.env['AWS_REGION'] ?? process.env['BEDROCK_REGION'] ?? 'eu-west-1';
        let baseEmbeds = 0;
        for (let i = 0; i < experienceIds.length; i++) {
          try {
            baseEmbeds += await embedAndPersistEntry(
              pool, region, env.userId, experienceIds[i]!,
              extracted.experience[i]!, null, env.importId,
            );
          } catch (err) {
            log.warn({ event: 'import.baseline_embed_failed', careerEntryId: experienceIds[i], err: (err as Error).message },
              'baseline embed failed (non-fatal)');
          }
        }
        log.info({ event: 'import.baseline_embeds', count: baseEmbeds, entries: experienceIds.length }, 'baseline career embeddings written');
      }
```

> Use the same variable names already in scope: `experienceIds` (from `persistCareerEntries`), `extracted` (the `ExtractedCareerData`), `env.userId`, `env.importId`, `pool`, `log`. If the persisted-ids variable is named differently in the file, match it.

- [ ] **Step 3: Verify.** If resume-import has jest: add `applications/resume-import-processor/src/__tests__/baseline-embed.test.ts` mocking `embedAndPersistEntry` (via `jest.unstable_mockModule('../embed.js', ...)`) and asserting it's called once per `extracted.experience` entry with `enriched=null`. Otherwise, manual verification: re-run an import in dev and confirm `SELECT count(*) FROM experience_embeddings WHERE user_id=<u>` > 0 right after `ready_for_review` (before any enrichment).

Run (if jest): `cd applications/resume-import-processor && npx jest src/__tests__/baseline-embed.test.ts` → PASS.

- [ ] **Step 4: Typecheck + commit**

Run: `cd applications/resume-import-processor && npx tsc --noEmit` (clean)
```bash
git add applications/resume-import-processor/src/run-import.ts applications/resume-import-processor/src/__tests__/baseline-embed.test.ts
git commit -m "feat(resume-import): baseline-embed career entries at import (pre-enrichment)"
```

---

## Task A2: `RdsExperienceVectorStore` (read-only career retriever)

**Files:**
- Create: `applications/shared/src/rds/implementations/RdsExperienceVectorStore.ts`
- Test: `applications/shared/src/rds/implementations/RdsExperienceVectorStore.test.ts`

Returns `SimilarityResult[]` (same type `RdsVectorStore` returns) so it's drop-in for `querySingleRds`. `experience_embeddings` has no `content_tsv`, so this is vector-only (ignores `useHybrid`). Maps rows to `SimilarityResult` with `repoFullName='career'`, `filePath=<chunk_type>` (so the research source label reads `career/role_description`).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, jest } from '@jest/globals';
import { RdsExperienceVectorStore } from './RdsExperienceVectorStore.js';

function fakePool(rows: unknown[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query = jest.fn(async () => ({ rows }));
    return { pool: { query } as any, query };
}

describe('RdsExperienceVectorStore.querySimilar', () => {
    it('maps experience_embeddings rows to SimilarityResult (career source)', async () => {
        const { pool, query } = fakePool([
            { id: 'e1', chunk_type: 'role_description', content: 'Senior SWE at Acme (2020-2024)', similarity: 0.91 },
            { id: 'e2', chunk_type: 'achievement', content: 'Cut deploy time 40%', similarity: 0.82 },
        ]);
        const store = new RdsExperienceVectorStore({ host: 'h', port: 5432, database: 'd', user: 'u', password: 'p' }, pool);
        const out = await store.querySimilar({ userId: 'u1', queryEmbedding: [0.1, 0.2], limit: 10 });
        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({ repoFullName: 'career', filePath: 'role_description', content: 'Senior SWE at Acme (2020-2024)', similarity: 0.91 });
        // user-scoped query issued
        const sql = (query.mock.calls[0]![0]) as string;
        expect(sql).toMatch(/FROM experience_embeddings/);
        expect(sql).toMatch(/user_id = \$1/);
    });
    it('returns [] when no rows', async () => {
        const { pool } = fakePool([]);
        const store = new RdsExperienceVectorStore({ host: 'h', port: 5432, database: 'd', user: 'u', password: 'p' }, pool);
        expect(await store.querySimilar({ userId: 'u1', queryEmbedding: [0.1], limit: 5 })).toEqual([]);
    });
});
```

- [ ] **Step 2: Run → FAIL** (module missing). `cd applications/shared && npx jest src/rds/implementations/RdsExperienceVectorStore.test.ts`

- [ ] **Step 3: Implement**

```typescript
/** @format */
import { Pool } from 'pg';
import type { QueryParams, SimilarityResult } from '../types.js';
import type { RdsClientConfig } from './RdsVectorStore.js';

interface ExperienceRow {
    id: string;
    chunk_type: string;
    content: string;
    similarity: number;
}

/**
 * Read-only vector retriever over `experience_embeddings` (résumé Career Data).
 * Mirrors RdsVectorStore.querySimilar's return type so the Research agent can
 * treat repo-KB and career evidence uniformly. Vector-only: experience_embeddings
 * has no content_tsv, so `useHybrid` is ignored.
 */
export class RdsExperienceVectorStore {
    private readonly pool: Pool;

    constructor(config: RdsClientConfig, pool?: Pool) {
        this.pool = pool ?? new Pool({
            host: config.host, port: config.port, database: config.database,
            user: config.user, password: config.password,
            max: 5, idleTimeoutMillis: 30_000, ssl: false,
        });
    }

    static fromEnvironment(): RdsExperienceVectorStore {
        const host = process.env.RDS_HOST, port = process.env.RDS_PORT,
            database = process.env.RDS_DB_NAME, user = process.env.RDS_USER,
            password = process.env.RDS_PASSWORD;
        if (!host || !port || !database || !user || !password) {
            throw new Error('RdsExperienceVectorStore: missing env. Required: RDS_HOST, RDS_PORT, RDS_DB_NAME, RDS_USER, RDS_PASSWORD');
        }
        return new RdsExperienceVectorStore({ host, port: parseInt(port, 10), database, user, password });
    }

    async querySimilar(params: QueryParams): Promise<SimilarityResult[]> {
        const limit = params.limit ?? 40;
        const r = await this.pool.query<ExperienceRow>(
            `SELECT id, chunk_type, content,
                    1 - (embedding <=> $2::vector) AS similarity
               FROM experience_embeddings
              WHERE user_id = $1
              ORDER BY embedding <=> $2::vector
              LIMIT $3`,
            [params.userId, JSON.stringify(params.queryEmbedding), limit],
        );
        return r.rows.map(row => ({
            id: row.id,
            repoFullName: 'career',
            filePath: row.chunk_type,
            heading: null,
            content: row.content,
            chunkIndex: 0,
            tags: [],
            similarity: Number(row.similarity),
        }));
    }
}
```

- [ ] **Step 4: Run → PASS.** `cd applications/shared && npx jest src/rds/implementations/RdsExperienceVectorStore.test.ts`

- [ ] **Step 5: Export.** In `applications/shared/src/rds/index.ts` add `export { RdsExperienceVectorStore } from './implementations/RdsExperienceVectorStore.js';` (match the file's existing export style). Confirm it re-exports from `applications/shared/src/index.ts` (the rds barrel is already re-exported there — verify `RdsVectorStore` is exported the same way and mirror it).

- [ ] **Step 6: tsc + commit**

Run: `cd applications/shared && npx tsc --noEmit && npx jest src/rds/implementations/RdsExperienceVectorStore.test.ts`
```bash
git add applications/shared/src/rds/implementations/RdsExperienceVectorStore.ts applications/shared/src/rds/implementations/RdsExperienceVectorStore.test.ts applications/shared/src/rds/index.ts
git commit -m "feat(shared): RdsExperienceVectorStore — read-only career vector retriever (TDD)"
```

---

## Task A3: Career-history loader + formatter (structured injection)

**Files:**
- Create: `applications/job-strategist/src/agents/career-history.ts`
- Test: `applications/job-strategist/src/agents/career-history.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from '@jest/globals';
import { formatCareerHistory } from './career-history.js';
import type { CareerEntry } from './career-history.js';

const ENTRIES: CareerEntry[] = [
    { title: 'Senior Platform Engineer', company: 'Acme', period: '2021–2024', highlights: ['Led migration to EKS', 'Cut MTTR 40%'] },
    { title: 'Backend Engineer', company: 'Beta', period: '2018–2021', highlights: [] },
];

describe('formatCareerHistory', () => {
    it('renders a citeable career-history section', () => {
        const out = formatCareerHistory(ENTRIES);
        expect(out).toContain('Career History');
        expect(out).toContain('Senior Platform Engineer');
        expect(out).toContain('Acme');
        expect(out).toContain('Led migration to EKS');
    });
    it('returns empty string for no entries', () => {
        expect(formatCareerHistory([])).toBe('');
    });
});
```

- [ ] **Step 2: Run → FAIL.** `cd applications/job-strategist && npx jest src/agents/career-history.test.ts`

- [ ] **Step 3: Implement** `career-history.ts`:

```typescript
/** @format */
import type { Pool } from 'pg';

export interface CareerEntry {
    readonly title: string;
    readonly company: string;
    readonly period: string;
    readonly highlights: string[];
}

interface CareerRow { raw_data: { title?: string; company?: string; period?: string; highlights?: string[] } | null }

/**
 * Load the user's experience entries from user_career_history (résumé Career Data).
 * Any enrichment_status — this is structured evidence, available pre-confirmation.
 */
export async function loadCareerHistory(pool: Pool, userId: string, limit = 8): Promise<CareerEntry[]> {
    const r = await pool.query<CareerRow>(
        `SELECT raw_data FROM user_career_history
          WHERE user_id = $1::uuid AND entry_type = 'experience'
          ORDER BY display_order ASC
          LIMIT $2`,
        [userId, limit],
    );
    return r.rows.map(row => ({
        title:      row.raw_data?.title ?? '',
        company:    row.raw_data?.company ?? '',
        period:     row.raw_data?.period ?? '',
        highlights: row.raw_data?.highlights ?? [],
    })).filter(e => e.title || e.company);
}

/**
 * Render career entries as a citeable evidence section for the Research prompt.
 * Distinct from the résumé "formatting reference only" path — this IS evidence
 * the model may cite. Empty string when there are no entries.
 */
export function formatCareerHistory(entries: CareerEntry[]): string {
    if (entries.length === 0) return '';
    const lines = ['## Career History (verified from your résumé — citeable evidence)'];
    for (const e of entries) {
        lines.push(`- **${e.title}** at ${e.company} (${e.period})`);
        for (const h of e.highlights) lines.push(`    - ${h}`);
    }
    return lines.join('\n');
}
```

- [ ] **Step 4: Run → PASS.** `cd applications/job-strategist && npx jest src/agents/career-history.test.ts`

- [ ] **Step 5: Commit**
```bash
git add applications/job-strategist/src/agents/career-history.ts applications/job-strategist/src/agents/career-history.test.ts
git commit -m "feat(strategist): career-history loader + citeable formatter (TDD)"
```

---

## Task A4: Widen `querySingleRds` to accept any vector store

**Files:**
- Modify: `applications/job-strategist/src/agents/research-agent.ts`

`querySingleRds` is typed `store: RdsVectorStore`. Widen it to the query port so the career store works too.

- [ ] **Step 1:** Change the signature (around line 126) from `store: RdsVectorStore` to a structural port:

```typescript
async function querySingleRds(
    query: string,
    userId: string,
    store: { querySimilar(p: import('@bedrock/shared').QueryParams): Promise<import('@bedrock/shared').SimilarityResult[]> },
): Promise<string[]> {
```

> If `QueryParams`/`SimilarityResult` aren't exported from `@bedrock/shared` root, add them to its barrel (they're in `applications/shared/src/rds/types.ts`); or import via the existing rds types path the file already uses. Verify the import resolves.

- [ ] **Step 2: tsc** `cd applications/job-strategist && npx tsc --noEmit` → clean (existing 4 calls still pass `RdsVectorStore`, which satisfies the port).

- [ ] **Step 3: Commit**
```bash
git add applications/job-strategist/src/agents/research-agent.ts
git commit -m "refactor(strategist): widen querySingleRds to the vector-store query port"
```

---

## Task A5: Wire career vector query + structured injection into Research

**Files:**
- Modify: `applications/job-strategist/src/agents/research-agent.ts`

- [ ] **Step 1: Imports.** Add near the existing `RdsVectorStore` import:
```typescript
import { RdsExperienceVectorStore } from '@bedrock/shared';
import { loadCareerHistory, formatCareerHistory } from './career-history.js';
import { getPool } from '../lib/pg.js';
```
> Confirm the pool accessor: `run-pipeline.ts`/`run-coach.ts` use `getPool` from `../lib/pg.js`. Use the same. If research-agent already has a pool handle in `ctx`, prefer that.

- [ ] **Step 2: Add the career vector query** in `executeResearchAgent`, alongside the existing 4 `querySingleRds` calls (around lines 585–594). Add a 5th, using a career store, then merge:

```typescript
        const careerStore = RdsExperienceVectorStore.fromEnvironment();
        const [factual1, factual2, factual3, factual4, career] = await Promise.all([
            querySingleRds(jd.substring(0, full), userId, store),
            querySingleRds(`professional experience skills qualifications ${jd.substring(half)}`, userId, store),
            querySingleRds(`portfolio project implementation achievements ${jd.substring(0, half)}`, userId, store),
            querySingleRds('DORA metrics lead time MTTR change failure rate deployment frequency outcome measurement pipeline performance', userId, store),
            querySingleRds(`work history roles responsibilities ${jd.substring(0, half)}`, userId, careerStore),
        ]);
        const allFactualPassages = [...factual1, ...factual2, ...factual3, ...factual4, ...career];
        kbContext = deduplicatePassages(allFactualPassages);
```
> This replaces the existing 4-way `Promise.all` + `allFactualPassages`/`kbContext` lines. Career retrieval is fail-open: wrap the `careerStore` creation + 5th query in try/catch if `fromEnvironment()` could throw in an env without RDS_* (it won't in the pipeline pod, which has them) — but to be safe, default `career = []` on error.

- [ ] **Step 3: Structured injection.** Load career history rows and pass to the message builder. Before `const userMessage = buildResearchMessage(jd, kbContext, resumeData);` (~line 615), add:

```typescript
        let careerHistorySection = '';
        try {
            const careerEntries = await loadCareerHistory(getPool(), userId);
            careerHistorySection = formatCareerHistory(careerEntries);
        } catch (e) {
            log('WARN', 'career history load failed (non-fatal)', { error: (e as Error).message });
        }
```
And change the call to:
```typescript
        const userMessage = buildResearchMessage(jd, kbContext, resumeData, careerHistorySection);
```

- [ ] **Step 4: Extend `buildResearchMessage`** (around line 268) to accept + render the career section. Add a 4th param and push the section when present (it is citeable evidence, valid in BOTH PATH A and PATH B):

```typescript
function buildResearchMessage(
    jobDescription: string,
    kbContext: string,
    resumeData: StructuredResumeData | null,
    careerHistorySection = '',
): string {
```
Then, after the PATH A/B block and before/with the `kbContext` section, add:
```typescript
    if (careerHistorySection) {
        sections.push(careerHistorySection);
    }
```
> Place it adjacent to the `## Knowledge Base — Portfolio & Project Evidence` push so both evidence sources sit together. Keep the existing résumé "formatting reference only" prohibition intact — the career section is separate and explicitly citeable.

- [ ] **Step 5: tsc + full job-strategist suite**

Run: `cd applications/job-strategist && npx tsc --noEmit && npx jest`
Expected: clean; existing research-agent tests still pass. If a research-agent test asserts `buildResearchMessage` arity/output, update it to pass `''` for the new param and add one asserting the career section renders when supplied.

- [ ] **Step 6: Commit**
```bash
git add applications/job-strategist/src/agents/research-agent.ts
git commit -m "feat(strategist): career evidence in Research (vector + citeable injection)"
```

---

## Task A6: PR-A build gate + PR

- [ ] **Step 1: Build/test both packages**

Run: `cd applications/shared && npx tsc --noEmit && npx jest` (green)
Run: `cd applications/job-strategist && npx tsc --noEmit && npx jest` (green)
Run: `cd applications/resume-import-processor && npx tsc --noEmit` (clean)

- [ ] **Step 2: Build shared dist** if job-strategist consumes built `@bedrock/shared` (worktree/CI parity): `cd applications/shared && npm run build`. Confirm `RdsExperienceVectorStore` resolves from `@bedrock/shared`.

- [ ] **Step 3: Open PR-A**
```bash
git push -u origin <pr-a-branch>
gh pr create --base develop --title "feat: career data into job analysis (baseline embed + retrieval)" --body "PR-A of the career-data evidence pipeline. Baseline-embeds career entries at import; adds RdsExperienceVectorStore; Research agent now uses career evidence (vector + citeable structured injection). Spec: docs/superpowers/specs/2026-06-01-career-data-evidence-pipeline-design.md"
```

---

# PR-B — Grounding verifier: block → flag

## Task B1: Default the strategist grounding to `flag`

**Files:**
- Modify: `applications/job-strategist/src/run-pipeline.ts` (line 35)
- Test: `applications/job-strategist/src/__tests__/run-pipeline.integration.test.ts` (existing grounding describe block, ~line 490)

- [ ] **Step 1: Change the verifier construction** (line 35) from:
```typescript
const groundingVerifier = new BedrockGroundingVerifier({ mode: 'block' });
```
to:
```typescript
// Default 'flag' — serve the real analysis and surface ungrounded claims via
// telemetry, rather than 'block' replacing a cited analysis with a one-line stub.
// Set GROUNDING_MODE=block to restore strict replacement for a stricter tier.
const groundingVerifier = new BedrockGroundingVerifier({
    mode: (process.env['GROUNDING_MODE'] as 'block' | 'flag') ?? 'flag',
});
```
> Confirm `GroundingMode`/the accepted literals from `bedrock-grounding-verifier.ts`; if a `GroundingMode` type is exported, use `process.env['GROUNDING_MODE'] as GroundingMode`.

- [ ] **Step 2: Update/extend the grounding integration test.** In `run-pipeline.integration.test.ts`'s grounding describe block (~line 490), add a test asserting that with default mode (`GROUNDING_MODE` unset) and a verifier returning `NOT_GROUNDED`, the persisted `finalAnalysis` equals the **original** `analysisXml` (NOT the fallback). The verifier mock is at ~line 60 (`BedrockGroundingVerifier: jest.fn()...`) — make its `verify` return `{ status: 'NOT_GROUNDED', answer: <original>, ... }` in flag mode (flag never substitutes), and assert the stored analysis is the original. Mirror the existing test's structure.

- [ ] **Step 3: Run** `cd applications/job-strategist && npx jest src/__tests__/run-pipeline.integration.test.ts` → PASS.

- [ ] **Step 4: tsc + commit**
Run: `cd applications/job-strategist && npx tsc --noEmit`
```bash
git add applications/job-strategist/src/run-pipeline.ts applications/job-strategist/src/__tests__/run-pipeline.integration.test.ts
git commit -m "fix(strategist): grounding defaults to flag (serve analysis, don't replace with stub)"
```

- [ ] **Step 5: PR-B**
```bash
git push -u origin <pr-b-branch>
gh pr create --base develop --title "fix(strategist): grounding block→flag (stop dropping valid analyses)" --body "PR-B of the career-data evidence pipeline. The block-mode grounding verifier was replacing cited analyses with a one-line fallback. Default to flag (serve + telemetry); GROUNDING_MODE=block restores strict mode."
```

---

# PR-C — Coach consumes research evidence

## Task C1: Feed `research` into the coach prompt

**Files:**
- Modify: `applications/job-strategist/src/agents/coach-agent.ts`
- Modify: `applications/job-strategist/src/run-coach.ts`
- Test: `applications/job-strategist/src/agents/coach-agent.test.ts` (extend)

- [ ] **Step 1: Extend `CoachAgentInput`** (coach-agent.ts) — add an optional research-evidence string:
```typescript
export interface CoachAgentInput {
    readonly analysis: StrategistAnalysisResult;
    readonly constraintBlock?: string;
    /** Verified-evidence digest from the Research result (phone-screen grounding). */
    readonly evidenceBlock?: string;
}
```

- [ ] **Step 2: Inject into `buildCoachMessage`.** Add a param + push the block after the analysis section:
```typescript
function buildCoachMessage(
    analysis: StrategistAnalysisResult,
    ctx: StrategistPipelineContext,
    constraintBlock?: string,
    evidenceBlock?: string,
): string {
```
After the `--- END ANALYSIS ---` push (and before the constraintBlock push), add:
```typescript
    if (evidenceBlock) {
        sections.push('## Verified Evidence (from Research)', evidenceBlock, '');
    }
```
Update `buildUserMessage` to pass it:
```typescript
    protected buildUserMessage(input: CoachAgentInput, ctx: StrategistPipelineContext): string {
        return buildCoachMessage(input.analysis, ctx, input.constraintBlock, input.evidenceBlock);
    }
```
And widen `executeCoachAgent`:
```typescript
export async function executeCoachAgent(
    ctx: StrategistPipelineContext,
    analysis: StrategistAnalysisResult,
    constraintBlock?: string,
    evidenceBlock?: string,
): Promise<AgentResult<InterviewCoachResult>> {
    return coachAgent.execute({ analysis, constraintBlock, evidenceBlock }, ctx);
}
```

- [ ] **Step 3: Build the evidence block in `run-coach.ts`.** `main()` already has `research` from `loadAnalysisAndResearch`. Add a formatter + pass it. After the constraint block is built, add:
```typescript
        const evidenceBlock = research ? [
            `Overall fit: ${research.overallFitRating ?? ''} — ${research.fitSummary ?? ''}`,
            `Experience signals: ${JSON.stringify(research.experienceSignals ?? {})}`,
            'Verified matches:',
            ...(research.verifiedMatches ?? []).map(m => `- ${m.skill} (${m.depth}) — ${m.sourceCitation}`),
        ].join('\n') : undefined;
```
Change the coach call:
```typescript
        const coaching = await executeCoachAgent(ctx, analysis, constraintBlock, evidenceBlock);
```
> Confirm `research` field names against `StrategistResearchResult` (`overallFitRating`, `fitSummary`, `experienceSignals`, `verifiedMatches[].skill/.depth/.sourceCitation`) — verified in `applications/shared/src/strategist-types.ts`.

- [ ] **Step 4: Test.** Extend `coach-agent.test.ts` with a `parseResponse`-independent check on the message builder OR assert `executeCoachAgent` threads `evidenceBlock`. Minimal: a unit that constructs the agent input and asserts the built user message contains the evidence text. If `buildCoachMessage` isn't exported, add a small exported `buildCoachUserMessage` wrapper or test via a subclass exposing `buildUserMessage`. Assert: when `evidenceBlock` provided → message contains "Verified Evidence"; when absent → it doesn't.

- [ ] **Step 5: Run + tsc**
Run: `cd applications/job-strategist && npx tsc --noEmit && npx jest src/agents/coach-agent.test.ts` → PASS

- [ ] **Step 6: Commit + PR**
```bash
git add applications/job-strategist/src/agents/coach-agent.ts applications/job-strategist/src/run-coach.ts applications/job-strategist/src/agents/coach-agent.test.ts
git commit -m "feat(coach): consume Research verified-evidence in the coach prompt"
git push -u origin <pr-c-branch>
gh pr create --base develop --title "feat(coach): ground phone-screen fields on Research evidence" --body "PR-C of the career-data evidence pipeline. run-coach already loads research; feed verifiedMatches/fitSummary/experienceSignals into the coach prompt so careerArc/jdTalkingPoints ground even when analysisXml is thin."
```

---

## Final E2E verification (after A+B+C merged + deployed)
- [ ] Re-run the Stripe analysis (so the new Research includes career evidence + grounding serves it), then dispatch the coach for `phone-screen`.
- [ ] Confirm `coaching_content.topics_to_study` for `(c2156165, 'phone-screen')` has a real `careerArcSummary` + populated `jdTalkingPoints` (no "INFORMATION GAP").

## Notes for the executor
- **Order:** B and C are independent and small — land them first if you want quick wins. A is the substantive change.
- **No new tables/migrations** — `experience_embeddings`, `user_career_history` already exist (049-era schema present in dev). A1 only populates `experience_embeddings` earlier.
- **Fail-open everywhere:** career retrieval/load failures must never break an analysis (wrap in try/catch, default empty).
- **Honesty preserved:** career history is real user evidence (citeable); grounding `flag` still surfaces ungrounded claims; no fabrication introduced.
