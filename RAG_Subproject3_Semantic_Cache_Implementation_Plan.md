# RAG Sub-project 3 — Semantic Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared Postgres+pgvector semantic response cache and wire it into chatbot + job-strategist so a semantically-similar prior query returns the cached answer and skips the expensive pipeline.

**Architecture:** New `semantic_cache` table (migration 022) holding `(scope, kb_tag, query_text, query_embedding vector(1024), response jsonb, created_at, hit_count)`. Shared `@bedrock/shared` `PgSemanticCache` embeds the (PII-scrubbed, normalised) query via `TitanEmbeddingProvider`, does a cosine lookup filtered by scope + kb_tag + TTL, accepts on `similarity >= threshold`. Fail-open: any cache error → miss / no-op, never breaks the host. Apps cache only GROUNDED/clean responses; a hit short-circuits the pipeline. Source spec: `RAG_Subproject3_Semantic_Cache_Design_Review.md`.

**Tech Stack:** TypeScript (NodeNext), jest+ts-jest, `pg` Pool, pgvector, `TitanEmbeddingProvider` + `PiiScrubber` + `emitEmfMetric` from `@bedrock/shared`. Migration runner: `applications/platform-rds-bootstrap/migrations/*.sql` (lexical order, idempotent).

---

## Branch

Work on the current branch `rls-secure-by-default` (carries the SP1/SP2 shared modules this depends on). Confirm: `git rev-parse --abbrev-ref HEAD` → `rls-secure-by-default`. Do NOT create/switch branches.

Per-app commands: shared tests `cd applications/shared && npx jest <path> -v`; chatbot `cd applications/chatbot && npx jest`; job-strategist `cd applications/job-strategist && npx jest`. Typecheck per app `npx tsc --noEmit` — gate is **no NEW errors** vs `git stash && npx tsc --noEmit; git stash pop` (cross-package rootDir errors pre-exist). Commits follow the **git-commit skill** (no AI authorship trailer). Avoid `$(cat <<EOF)` in commit commands.

---

## File Structure / Task Map

| Task | Concern | Files |
|---|---|---|
| 1 | DB migration | `applications/platform-rds-bootstrap/migrations/022_semantic_cache.sql` |
| 2 | Shared cache module + tests | `applications/shared/src/cache/{cache-types,pg-semantic-cache,index}.ts` + tests; `applications/shared/src/index.ts` |
| 3 | chatbot wiring | `applications/chatbot/src/index.ts`, `handler.test.ts` |
| 4 | job-strategist wiring | `applications/job-strategist/src/run-pipeline.ts`, integration test |
| 5 | Final verification + push | — |

---

## Task 1: Migration 022 — semantic_cache table

**Files:** Create `applications/platform-rds-bootstrap/migrations/022_semantic_cache.sql`.

- [ ] **Step 1: Write the migration**

Create the file with EXACTLY:

```sql
-- =============================================================================
-- Migration 022 — Semantic response cache (RAG checklist §9)
--
-- Stores PII-scrubbed query embeddings + cached responses for the query
-- apps (chatbot, job-strategist). Lookups filter by scope + kb_tag (KB
-- version + model id) and a TTL; a reindex or model change strands old
-- rows without deleting them.
--
-- Idempotent: every statement uses IF NOT EXISTS. Plain (not CONCURRENT)
-- builds, matching the runner's single-transaction model and the rest of
-- this migration set.
-- =============================================================================

CREATE TABLE IF NOT EXISTS semantic_cache (
  id              BIGSERIAL PRIMARY KEY,
  scope           TEXT NOT NULL,
  kb_tag          TEXT NOT NULL,
  query_text      TEXT NOT NULL,
  query_embedding vector(1024) NOT NULL,
  response        JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hit_count       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_semantic_cache_hnsw
  ON semantic_cache USING hnsw (query_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_semantic_cache_scope_tag
  ON semantic_cache (scope, kb_tag, created_at);
```

- [ ] **Step 2: Sanity-check it loads in lexical order and is idempotent**

Run: `ls applications/platform-rds-bootstrap/migrations/ | sort | tail -3`
Expected: `020_query_path_indexes.sql`, `021_rls_pipeline_tables.sql`, `022_semantic_cache.sql` (022 sorts last). Confirm the file contains only `IF NOT EXISTS` guarded statements (re-running is safe).

- [ ] **Step 3: Commit**

```
git add applications/platform-rds-bootstrap/migrations/022_semantic_cache.sql
git commit -m "feat(rds): add semantic_cache table (migration 022)"
```

---

## Task 2: Shared `PgSemanticCache` module + tests

**Files:**
- Create `applications/shared/src/cache/cache-types.ts`
- Create `applications/shared/src/cache/pg-semantic-cache.ts`
- Create `applications/shared/src/cache/index.ts`
- Create `applications/shared/src/cache/pg-semantic-cache.test.ts`
- Modify `applications/shared/src/index.ts`

- [ ] **Step 1: Write the types file**

`applications/shared/src/cache/cache-types.ts`:

```typescript
/**
 * @format
 * Semantic cache — contract. Embed a (PII-scrubbed, normalised) query,
 * cosine-match it against prior cached responses scoped by app/caller and
 * a KB-version/model tag. Fail-open: errors degrade to miss / no-op.
 */

export interface SemanticCacheGetInput {
    /** App + caller scoping, e.g. "chatbot:recruiter". */
    readonly scope: string;
    /** KB-version + model id. A reindex/model change must change this. */
    readonly kbTag: string;
    /** Raw query text (scrubbed + normalised internally before embed). */
    readonly queryText: string;
}

export interface SemanticCacheGetResult {
    readonly hit: boolean;
    readonly response?: unknown;
    readonly similarity?: number;
}

export interface SemanticCachePutInput {
    readonly scope: string;
    readonly kbTag: string;
    readonly queryText: string;
    readonly response: unknown;
}

export interface ISemanticCache {
    get(input: SemanticCacheGetInput): Promise<SemanticCacheGetResult>;
    put(input: SemanticCachePutInput): Promise<void>;
}
```

- [ ] **Step 2: Write the failing test**

`applications/shared/src/cache/pg-semantic-cache.test.ts`:

```typescript
const queryMock = jest.fn();
jest.mock('pg', () => ({ Pool: jest.fn(() => ({ query: queryMock })) }));
const embedMock = jest.fn();
jest.mock('../rds/index.js', () => ({
    TitanEmbeddingProvider: { fromEnvironment: () => ({ embed: embedMock }) },
}));
const emitMock = jest.fn();
jest.mock('../emf.js', () => ({ emitEmfMetric: (...a: unknown[]) => emitMock(...a) }));
jest.mock('../security/index.js', () => ({
    PiiScrubber: jest.fn(() => ({ scrub: (t: string) => ({ redacted: t }) })),
}));

import { PgSemanticCache } from './pg-semantic-cache.js';

const cfg = { host: 'h', port: 5432, database: 'd', user: 'u', password: 'p' };

beforeEach(() => { queryMock.mockReset(); embedMock.mockReset(); emitMock.mockReset();
    embedMock.mockResolvedValue([0.1, 0.2]); });

describe('PgSemanticCache', () => {
    it('returns a hit when similarity >= threshold', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ id: 7, response: { a: 1 }, similarity: 0.97 }] });
        const c = new PgSemanticCache({ ...cfg, threshold: 0.95 });
        const r = await c.get({ scope: 's', kbTag: 'k', queryText: 'hello' });
        expect(r.hit).toBe(true);
        expect(r.response).toEqual({ a: 1 });
        expect(emitMock).toHaveBeenCalled();
    });

    it('returns a miss when similarity is below threshold', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ id: 7, response: { a: 1 }, similarity: 0.80 }] });
        const c = new PgSemanticCache({ ...cfg, threshold: 0.95 });
        const r = await c.get({ scope: 's', kbTag: 'k', queryText: 'hello' });
        expect(r.hit).toBe(false);
    });

    it('returns a miss when no row matches scope/tag/ttl', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const c = new PgSemanticCache(cfg);
        expect((await c.get({ scope: 's', kbTag: 'k', queryText: 'q' })).hit).toBe(false);
    });

    it('is fail-open: DB error on get → miss, no throw, CacheError emitted', async () => {
        queryMock.mockRejectedValueOnce(new Error('db down'));
        const c = new PgSemanticCache(cfg);
        const r = await c.get({ scope: 's', kbTag: 'k', queryText: 'q' });
        expect(r.hit).toBe(false);
        expect(emitMock.mock.calls.some(c => JSON.stringify(c).includes('CacheError'))).toBe(true);
    });

    it('is fail-open: embed error → miss, no throw', async () => {
        embedMock.mockRejectedValueOnce(new Error('bedrock down'));
        const c = new PgSemanticCache(cfg);
        expect((await c.get({ scope: 's', kbTag: 'k', queryText: 'q' })).hit).toBe(false);
    });

    it('put inserts a row and is fail-open on error', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const c = new PgSemanticCache(cfg);
        await c.put({ scope: 's', kbTag: 'k', queryText: 'q', response: { x: 1 } });
        const sql = String(queryMock.mock.calls.at(-1)?.[0]);
        expect(sql).toMatch(/INSERT INTO semantic_cache/i);
        queryMock.mockRejectedValueOnce(new Error('db down'));
        await expect(c.put({ scope: 's', kbTag: 'k', queryText: 'q', response: {} }))
            .resolves.toBeUndefined();
    });

    it('fires hit_count increment on a hit', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [{ id: 7, response: {}, similarity: 0.99 }] })
            .mockResolvedValueOnce({ rows: [] });
        const c = new PgSemanticCache({ ...cfg, threshold: 0.95 });
        await c.get({ scope: 's', kbTag: 'k', queryText: 'q' });
        await new Promise(r => setImmediate(r));
        const calls = queryMock.mock.calls.map(c => String(c[0]));
        expect(calls.some(s => /hit_count\s*=\s*hit_count\s*\+\s*1/i.test(s))).toBe(true);
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd applications/shared && npx jest src/cache/pg-semantic-cache.test.ts -v`
Expected: FAIL — cannot find module `./pg-semantic-cache.js`.

- [ ] **Step 4: Write the implementation**

`applications/shared/src/cache/pg-semantic-cache.ts`:

```typescript
/**
 * @format
 * PgSemanticCache — Postgres+pgvector semantic response cache.
 *
 * Mirrors RdsVectorStore's pool/env pattern and tavily-cache's TTL/hit
 * model, but matches semantically (cosine) not by hash. Fail-open: every
 * error path degrades to a miss / no-op and emits a CacheError metric —
 * the cache must never throw into a host request.
 */

import { Pool } from 'pg';

import { emitEmfMetric } from '../emf.js';
import { PiiScrubber } from '../security/index.js';
import { TitanEmbeddingProvider } from '../rds/index.js';
import type {
    ISemanticCache,
    SemanticCacheGetInput,
    SemanticCacheGetResult,
    SemanticCachePutInput,
} from './cache-types.js';

const NS = 'BedrockSharedSafety';

export interface SemanticCacheConfig {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password: string;
    readonly threshold?: number;
    readonly ttlDays?: number;
    readonly efSearch?: number;
}

function normalise(q: string): string {
    return q.toLowerCase().replace(/\s+/g, ' ').trim();
}

export class PgSemanticCache implements ISemanticCache {
    private readonly pool: Pool;
    private readonly embedder = TitanEmbeddingProvider.fromEnvironment();
    private readonly scrubber = new PiiScrubber();
    private readonly threshold: number;
    private readonly ttlDays: number;
    private readonly efSearch: number;

    constructor(cfg: SemanticCacheConfig) {
        this.pool = new Pool({
            host: cfg.host, port: cfg.port, database: cfg.database,
            user: cfg.user, password: cfg.password,
            max: 3, idleTimeoutMillis: 30_000, ssl: false,
        });
        this.threshold = cfg.threshold
            ?? Number(process.env.SEMANTIC_CACHE_THRESHOLD ?? '0.95');
        this.ttlDays = cfg.ttlDays
            ?? Number(process.env.SEMANTIC_CACHE_TTL_DAYS ?? '7');
        this.efSearch = cfg.efSearch ?? 40;
    }

    static fromEnvironment(extra?: Partial<SemanticCacheConfig>): PgSemanticCache {
        return new PgSemanticCache({
            host: process.env.RDS_HOST ?? '',
            port: Number(process.env.RDS_PORT ?? '5432'),
            database: process.env.RDS_DB_NAME ?? '',
            user: process.env.RDS_USER ?? '',
            password: process.env.RDS_PASSWORD ?? '',
            ...extra,
        });
    }

    private async embed(text: string): Promise<number[]> {
        const clean = this.scrubber.scrub(normalise(text)).redacted;
        return this.embedder.embed(clean);
    }

    async get(input: SemanticCacheGetInput): Promise<SemanticCacheGetResult> {
        try {
            const vec = await this.embed(input.queryText);
            const res = await this.pool.query<{ id: number; response: unknown; similarity: number }>(
                `WITH _ AS (SELECT set_config('hnsw.ef_search', $1, true))
                 SELECT id, response,
                        1 - (query_embedding <=> $4::vector) AS similarity
                 FROM semantic_cache, _
                 WHERE scope = $2 AND kb_tag = $3
                   AND created_at > NOW() - ($5 || ' days')::interval
                 ORDER BY query_embedding <=> $4::vector
                 LIMIT 1`,
                [String(this.efSearch), input.scope, input.kbTag,
                 `[${vec.join(',')}]`, String(this.ttlDays)],
            );
            const row = res.rows[0];
            if (row && Number(row.similarity) >= this.threshold) {
                this.pool.query(
                    'UPDATE semantic_cache SET hit_count = hit_count + 1 WHERE id = $1',
                    [row.id],
                ).catch(() => {});
                emitEmfMetric(NS, { Module: 'cache' },
                    [{ name: 'CacheHit', value: 1, unit: 'Count' }]);
                return { hit: true, response: row.response, similarity: Number(row.similarity) };
            }
            emitEmfMetric(NS, { Module: 'cache' },
                [{ name: 'CacheMiss', value: 1, unit: 'Count' }]);
            return { hit: false };
        } catch (e) {
            emitEmfMetric(NS, { Module: 'cache' },
                [{ name: 'CacheError', value: 1, unit: 'Count' }]);
            console.warn('[semantic-cache] get failed — treating as miss:',
                (e as Error).message);
            return { hit: false };
        }
    }

    async put(input: SemanticCachePutInput): Promise<void> {
        try {
            const vec = await this.embed(input.queryText);
            await this.pool.query(
                `INSERT INTO semantic_cache
                   (scope, kb_tag, query_text, query_embedding, response)
                 VALUES ($1, $2, $3, $4::vector, $5::jsonb)`,
                [input.scope, input.kbTag, normalise(input.queryText),
                 `[${vec.join(',')}]`, JSON.stringify(input.response)],
            );
        } catch (e) {
            emitEmfMetric(NS, { Module: 'cache' },
                [{ name: 'CacheError', value: 1, unit: 'Count' }]);
            console.warn('[semantic-cache] put failed — skipping store:',
                (e as Error).message);
        }
    }
}
```

- [ ] **Step 5: Write the barrel**

`applications/shared/src/cache/index.ts`:

```typescript
/**
 * @format
 * Cache — Public API. Semantic response cache (RAG checklist §9).
 */

export { PgSemanticCache } from './pg-semantic-cache.js';
export type { SemanticCacheConfig } from './pg-semantic-cache.js';
export type {
    ISemanticCache,
    SemanticCacheGetInput,
    SemanticCacheGetResult,
    SemanticCachePutInput,
} from './cache-types.js';
```

- [ ] **Step 6: Add to the top-level shared barrel**

In `applications/shared/src/index.ts`, find the grounding section (the `export { BedrockGroundingVerifier ... } from './grounding/index.js';` block) and add an analogous cache section immediately after it:

```typescript
// ─── Cache (Semantic Response Cache) ─────────────────────────────────────────
export { PgSemanticCache } from './cache/index.js';
export type {
    ISemanticCache,
    SemanticCacheConfig,
    SemanticCacheGetInput,
    SemanticCacheGetResult,
    SemanticCachePutInput,
} from './cache/index.js';
```

- [ ] **Step 7: Run tests + typecheck**

Run: `cd applications/shared && npx jest src/cache/pg-semantic-cache.test.ts -v && npx tsc --noEmit`
Expected: 7 tests PASS; tsc clean (or no NEW errors vs `git stash` baseline). Also run the full shared suite `npx jest` — still green (177+).

- [ ] **Step 8: Commit**

```
git add applications/shared/src/cache applications/shared/src/index.ts
git commit -m "feat(shared-cache): add PgSemanticCache with fail-open TDD coverage"
```

---

## Task 3: chatbot wiring

**Files:** Modify `applications/chatbot/src/index.ts`; Test `applications/chatbot/src/handler.test.ts` (append).

FIRST read `applications/chatbot/src/index.ts`: the `scrubbedPrompt` line (~404), `invokeChatbotAgent(...)` call, `resolvedRole`, the grounding block + `answerForOutput`/`sanitisedResponse`, the final `buildResponse(200, { response: sanitisedResponse, sessionId }, origin)`, and the env access (`AGENT_ALIAS_ID`; the chatbot model env — confirm the real name, the audit noted `CHATBOT_MODEL`; if absent use `config.agentAliasId` + a `CHATBOT_MODEL` env read with a safe fallback string). Read `handler.test.ts` mock style (it already mocks `@bedrock/shared` via requireActual + the agent + grounding).

- [ ] **Step 1: Write the failing tests**

Append to `handler.test.ts` a `describe('semantic cache')` block. Extend the existing `@bedrock/shared` mock to also expose a controllable `PgSemanticCache` (class whose `get`/`put` are shared mocks `cacheGetMock`/`cachePutMock`), keeping existing mocks intact:

```typescript
it('returns the cached answer and skips the agent on a cache hit', async () => {
    cacheGetMock.mockResolvedValueOnce({ hit: true, response: 'CACHED ANSWER' });
    const event = makeEvent({ prompt: 'tell me about the portfolio' });
    const res = await handler(event as never, {} as never);
    expect(JSON.parse(res.body).response).toBe('CACHED ANSWER');
    expect(invokeChatbotAgentMock).not.toHaveBeenCalled();
});

it('on a miss runs the agent and stores a GROUNDED answer', async () => {
    cacheGetMock.mockResolvedValueOnce({ hit: false });
    groundingVerifyMock.mockResolvedValueOnce({
        status: 'GROUNDED', reason: 'ok', ungroundedClaims: [], answer: 'This is the agent answer.',
    });
    const event = makeEvent({ prompt: 'tell me about the portfolio' });
    await handler(event as never, {} as never);
    expect(invokeChatbotAgentMock).toHaveBeenCalled();
    expect(cachePutMock).toHaveBeenCalled();
});

it('does NOT store when grounding blocked the answer', async () => {
    cacheGetMock.mockResolvedValueOnce({ hit: false });
    groundingVerifyMock.mockResolvedValueOnce({
        status: 'NOT_GROUNDED', reason: 'x', ungroundedClaims: ['c'], answer: 'I do not have grounded info.',
    });
    const event = makeEvent({ prompt: 'q' });
    await handler(event as never, {} as never);
    expect(cachePutMock).not.toHaveBeenCalled();
});

it('cache get throwing does not break the request (fail-open)', async () => {
    cacheGetMock.mockRejectedValueOnce(new Error('db down'));
    const event = makeEvent({ prompt: 'q' });
    const res = await handler(event as never, {} as never);
    expect(res.statusCode).toBe(200);
});
```

Wire `cacheGetMock`/`cachePutMock` into the `@bedrock/shared` mock the same way `groundingVerifyMock` is wired (a `PgSemanticCache` mock class returning `{ get: cacheGetMock, put: cachePutMock }`). Adapt `makeEvent`/`invokeChatbotAgentMock`/`groundingVerifyMock` to the real names already in the file. Note: the last test requires the handler to wrap `cache.get` defensively even though the module is itself fail-open (defence at the call site).

- [ ] **Step 2: Run to verify they fail**

Run: `cd applications/chatbot && npx jest src/handler.test.ts -t "cache" -v`
Expected: FAIL (no cache wired).

- [ ] **Step 3: Implement**

In `applications/chatbot/src/index.ts`:
1. Add `PgSemanticCache` to the `@bedrock/shared` import (contiguous). Module-scoped singleton with the other singletons:

```typescript
const semanticCache = PgSemanticCache.fromEnvironment();
```

2. Compute the scope + tag and do the cache check right after `const scrubbedPrompt = piiScrubber.scrub(inputCheck.sanitised).redacted;` and before `invokeChatbotAgent`:

```typescript
const cacheScope = `chatbot:${resolvedRole}`;
const cacheTag = `${config.agentAliasId}:${process.env.CHATBOT_MODEL ?? 'default'}`;
let cached: { hit: boolean; response?: unknown } = { hit: false };
try {
    cached = await semanticCache.get({
        scope: cacheScope, kbTag: cacheTag, queryText: scrubbedPrompt,
    });
} catch { cached = { hit: false }; }
if (cached.hit && typeof cached.response === 'string') {
    return buildResponse(200, { response: cached.response, sessionId }, origin);
}
```

(Use the real variable names: `resolvedRole`, `config.agentAliasId`, `sessionId`, `origin`, `buildResponse` as they appear in the file. If `resolvedRole` is computed later than `scrubbedPrompt`, move the cache block to just after `resolvedRole` is available but still before `invokeChatbotAgent`.)

3. After `sanitisedResponse` is produced, store only when grounding did not block. The grounding block already computes a `GroundingResult`-like value (`g`) or leaves `answerForOutput = normalised` on skip; cache only when the answer is the genuine grounded answer, not the fallback. Add right after the `outputSanitiser.sanitiseWithReport(...)` line:

```typescript
const groundingBlocked =
    groundingStatus === 'NOT_GROUNDED'; // use the real status var from the grounding block
if (!groundingBlocked && sanitisedResponse && !wasRedacted) {
    void semanticCache.put({
        scope: cacheScope, kbTag: cacheTag,
        queryText: scrubbedPrompt, response: sanitisedResponse,
    }).catch(() => {});
}
```

Read the grounding block to get the real variable holding the status (the T2/SP2 code set something like `g.status`; if the status isn't retained in a variable at the store point, retain it: when grounding runs, capture `const groundingStatus = g.status;` defaulting to `'GROUNDED'` when grounding was skipped/no-context — a skipped-grounding answer is the raw agent answer and is cacheable). Do NOT cache when the verifier threw (treat as not cacheable: initialise `groundingStatus` such that an error path leaves it non-'GROUNDED' OR guard with the same try/catch flag). Keep it simple and correct: only `put` when the answer returned to the user is the real generated answer.

- [ ] **Step 4: Run to verify they pass**

Run: `cd applications/chatbot && npx jest src/handler.test.ts -v`
Expected: all PASS (cache tests + existing PII/grounding tests).

- [ ] **Step 5: Typecheck + commit**

Run: `cd applications/chatbot && npx tsc --noEmit` then `git stash && npx tsc --noEmit; git stash pop` — no new error count.

```
git add applications/chatbot/src/index.ts applications/chatbot/src/handler.test.ts
git commit -m "feat(chatbot): semantic cache check/store, fail-open, skip agent on hit"
```

---

## Task 4: job-strategist wiring

**Files:** Modify `applications/job-strategist/src/run-pipeline.ts`; Test `applications/job-strategist/src/__tests__/run-pipeline.integration.test.ts` (append, reuse the in-process grounding harness).

FIRST read `run-pipeline.ts`: the `ctx` build (~L86–104), `executeResearchAgent(ctx)` / `executeStrategistAgent`, the grounding block + `finalAnalysis`, `updatePipelineRunMetadata(pool, env.pipelineRunId, { analysis: { ...analysis.data, analysisXml: finalAnalysis }, research: research.data })`, the run-status update calls, `env.userId/targetRole/targetCompany/jobDescription`, `STRATEGIST_MODEL` usage (in `strategist-agent.ts` ~L60), and how the existing grounding tests drive `main()` in-process. The shared `PiiScrubber` and `PgSemanticCache` are in `@bedrock/shared`.

- [ ] **Step 1: Write the failing tests**

Append to the integration test. Mock `PgSemanticCache` from `@bedrock/shared` (same requireActual pattern used for `BedrockGroundingVerifier`), shared mocks `cacheGetMock`/`cachePutMock`:

```typescript
it('on cache hit skips research+strategist and persists the cached analysis', async () => {
    cacheGetMock.mockResolvedValueOnce({
        hit: true,
        response: { analysisXml: 'CACHED_XML', research: { r: 1 }, fitSummary: 'fs' },
    });
    await runPipelineForTest(/* existing happy path */);
    expect(executeResearchAgentMock).not.toHaveBeenCalled();
    expect(executeStrategistAgentMock).not.toHaveBeenCalled();
    const meta = updatePipelineRunMetadataMock.mock.calls.at(-1)?.[2];
    expect(JSON.stringify(meta)).toContain('CACHED_XML');
});

it('on miss runs the pipeline and stores the grounded analysis', async () => {
    cacheGetMock.mockResolvedValueOnce({ hit: false });
    groundingVerifyMock.mockResolvedValueOnce({
        status: 'GROUNDED', reason: 'ok', ungroundedClaims: [], answer: 'A',
    });
    await runPipelineForTest(/* existing happy path */);
    expect(executeResearchAgentMock).toHaveBeenCalled();
    expect(cachePutMock).toHaveBeenCalled();
});

it('does NOT store when grounding substituted the fallback', async () => {
    cacheGetMock.mockResolvedValueOnce({ hit: false });
    groundingVerifyMock.mockResolvedValueOnce({
        status: 'NOT_GROUNDED', reason: 'x', ungroundedClaims: [], answer: 'FALLBACK',
    });
    await runPipelineForTest(/* existing happy path */);
    expect(cachePutMock).not.toHaveBeenCalled();
});

it('cache get throwing does not fail the run (fail-open)', async () => {
    cacheGetMock.mockRejectedValueOnce(new Error('db down'));
    await expect(runPipelineForTest(/* happy path */)).resolves.toBeDefined();
});
```

`runPipelineForTest`, `executeResearchAgentMock`, `executeStrategistAgentMock`, `updatePipelineRunMetadataMock`, `groundingVerifyMock` = reuse the file's existing harness/mock names (adapt to reality). The agent-skip mocks already exist in that file's grounding tests; reuse them.

- [ ] **Step 2: Run to verify they fail**

Run: `cd applications/job-strategist && npx jest src/__tests__/run-pipeline.integration.test.ts -t "cache" -v`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `applications/job-strategist/src/run-pipeline.ts`:
1. Import `PgSemanticCache` (+ `PiiScrubber` if not already imported) from `@bedrock/shared` (contiguous). Module-scoped `const semanticCache = PgSemanticCache.fromEnvironment();` and (if not present) `const piiScrubber = new PiiScrubber();`.
2. Build a kb_tag helper. Before the cache check, derive the tag from `repo_sync_state`, fail-open to model-only:

```typescript
async function cacheTagFor(userId: string): Promise<string> {
    const model = process.env.STRATEGIST_MODEL ?? 'default';
    try {
        const r = await pool.query<{ t: string }>(
            `SELECT COALESCE(MAX(last_synced_at)::text, '') ||
                    COALESCE((MAX(kb_quality_breakdown->>'version')), '') AS t
             FROM repo_sync_state WHERE user_id = $1`,
            [userId],
        );
        return `${r.rows[0]?.t ?? ''}:${model}`;
    } catch {
        return `:${model}`;
    }
}
```

3. Cache check after `ctx` is built and the initial run-status updates, before `executeResearchAgent(ctx)`:

```typescript
const cacheScope =
    `jobstrat:${env.userId}:${env.targetRole}:${env.targetCompany}`;
const cacheTag = await cacheTagFor(env.userId);
const jdForCache = piiScrubber.scrub(env.jobDescription).redacted;
let cached: { hit: boolean; response?: unknown } = { hit: false };
try {
    cached = await semanticCache.get({
        scope: cacheScope, kbTag: cacheTag, queryText: jdForCache,
    });
} catch { cached = { hit: false }; }
if (cached.hit && cached.response
    && typeof (cached.response as { analysisXml?: unknown }).analysisXml === 'string') {
    const cr = cached.response as { analysisXml: string; research: unknown; fitSummary: unknown };
    await updatePipelineRunMetadata(pool, env.pipelineRunId, {
        analysis: { analysisXml: cr.analysisXml, fitSummary: cr.fitSummary },
        research: cr.research,
    });
    await updatePipelineRun(pool, env.pipelineRunId, 'complete');
    await updateJobApplicationStatus(pool, env.applicationId, 'analysed');
    return;
}
```

(Use the REAL status-update function names + the REAL terminal status string the pipeline uses on success — read the end of `main()` for the exact `updatePipelineRun(...)`/`updateJobApplicationStatus(...)` calls and final status values; mirror them exactly so a cache-hit path produces the same terminal state as a normal run. Do NOT invent status strings.)

4. Store after `finalAnalysis` is produced, only when grounding did not substitute the fallback. The SP2 grounding block sets `finalAnalysis = g.answer` on a successful verify; capture the status. Cache only the non-substituted case:

```typescript
if (groundingStatus !== 'NOT_GROUNDED') {
    void semanticCache.put({
        scope: cacheScope, kbTag: cacheTag, queryText: jdForCache,
        response: {
            analysisXml: finalAnalysis,
            research: research.data,
            fitSummary: analysis.data.fitSummary,
        },
    }).catch(() => {});
}
```

Read the grounding block to capture the real status variable (`g.status`); when grounding was skipped (empty contextChunks → no verify), the analysis is the original strategist output and IS cacheable (treat skipped as cacheable, i.e. `groundingStatus` defaults to a non-`'NOT_GROUNDED'` value). When the verifier threw (fail-open kept original), it is also cacheable. Only the explicit `NOT_GROUNDED` substitution must NOT be cached. Use the real field name for `fitSummary` (confirm on `analysis.data`).

- [ ] **Step 4: Run to verify they pass**

Run: `cd applications/job-strategist && npx jest src/__tests__/run-pipeline.integration.test.ts -v`
Expected: cache tests + the 3 existing grounding tests PASS (pre-existing live-DB subprocess suites still fail identically — confirm via `git stash` they are unchanged, do not fix).

- [ ] **Step 5: Typecheck + commit**

Run: `cd applications/job-strategist && npx tsc --noEmit` then `git stash && npx tsc --noEmit; git stash pop` — no new error count.

```
git add applications/job-strategist/src/run-pipeline.ts applications/job-strategist/src/__tests__/run-pipeline.integration.test.ts
git commit -m "feat(job-strategist): semantic cache short-circuits pipeline on hit, fail-open"
```

---

## Task 5: Final verification + push

- [ ] **Step 1: Per-app suites + typecheck**

Run, expecting green / no-new-errors:
```
cd applications/shared && npx jest && npx tsc --noEmit
cd applications/chatbot && npx jest && npx tsc --noEmit
cd applications/job-strategist && npx jest src/__tests__/run-pipeline.integration.test.ts
```
Expected: shared all green incl. cache; chatbot all green incl. cache; job-strategist cache+grounding tests green (pre-existing live-DB failures unchanged vs baseline — confirm with one `git stash` round-trip).

- [ ] **Step 2: Scope guard**

Run: `git diff --name-only develop...HEAD | grep -i semantic` and a broad `git diff --name-only HEAD~5..HEAD`
Expected: this sub-project touched only `migrations/022_semantic_cache.sql`, `applications/shared/src/cache/*`, `applications/shared/src/index.ts`, `applications/chatbot/src/index.ts`, `applications/chatbot/src/handler.test.ts`, `applications/job-strategist/src/run-pipeline.ts`, the job-strategist integration test, and the two SP3 root docs. Flag anything else.

- [ ] **Step 3: Push**

```
git push origin rls-secure-by-default
```

- [ ] **Step 4: Report**

Summarise: migration added; shared cache module + tests green; chatbot + job-strategist wired (hit short-circuits, only clean responses stored, fail-open); per-app suites green; scope guard result; pushed. Offer to update PR #5 / open a follow-up PR.

---

## Self-Review

**Spec coverage:** §A store → Task 1. §B shared module (types, PgSemanticCache, fail-open, threshold/TTL env, PII scrub, EMF, barrel) → Task 2. §C chatbot wiring (scope/tag, hit short-circuit, cache-only-GROUNDED, fail-open) → Task 3. §C job-strategist wiring (scope/tag from repo_sync_state, hit skips research+strategist, cache-only-non-substituted, fail-open) → Task 4. §D flow → Tasks 3/4 control flow. Testing → per-task tests + Task 5. Scope/sequencing/success criteria → Task 5. All spec sections covered.

**Placeholder scan:** No TBD/TODO. Every code step shows full code; every command has expected output. The per-app steps quote the exact transformation and instruct confirming real variable/status/status-string names against the live file (integration guidance, not placeholders) — necessary because chatbot/job-strategist were modified by SP2 and exact line numbers shift.

**Type consistency:** `ISemanticCache.get → {hit,response?,similarity?}`, `.put → void`, `SemanticCacheConfig`, `PgSemanticCache.fromEnvironment()` used identically across Tasks 2/3/4. `scope`/`kbTag`/`queryText`/`response` field names consistent. `emitEmfMetric(ns, dims, metrics[])` matches the shared signature used in SP1/SP2. Grounding status gating (`NOT_GROUNDED` ⇒ don't cache; skipped/error ⇒ cacheable) consistent between Task 3 and Task 4.

**Note for executor:** chatbot/job-strategist grounding blocks came from SP2 — confirm the real status variable and the real terminal run-status strings in `run-pipeline.ts` before finalising the cache-hit short-circuit (it must reproduce the exact same terminal state as a normal successful run). Do not invent status strings.
