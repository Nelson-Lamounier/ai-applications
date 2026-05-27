# Phase 2: Article Pipeline Research Agent → pgvector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Bedrock Knowledge Base (Pinecone) retrieval path in the Research Agent with a direct RDS pgvector query, gated by a `RESEARCH_RETRIEVAL_SOURCE` feature flag, without changing any downstream agent interfaces.

**Architecture:** `PgVectorRetriever` (new class in `@bedrock/shared`) embeds the query via Titan Embed Text v2, queries both `repository_profile_embeddings` (profile layer with weight multiplier) and `document_embeddings` (chunk layer) in parallel, merges by score, and returns `RetrievedPassage[]`. In `research-agent.ts`, the existing `queryKnowledgeBase` path is preserved; the new path is selected by `process.env.RESEARCH_RETRIEVAL_SOURCE === 'pgvector'`. Results from either path are mapped to `KbPassage[]` so Writer and QA agents see no change.

**Tech Stack:** TypeScript, PostgreSQL/pgvector (HNSW cosine), Titan Embed Text v2 (`amazon.titan-embed-text-v2:0`), pg Pool, Jest/ts-jest

---

## File Map

| Action | Path |
|--------|------|
| Create | `applications/shared/src/retrieval/implementations/PgVectorRetriever.ts` |
| Create | `applications/shared/src/retrieval/implementations/PgVectorRetriever.test.ts` |
| Modify | `applications/shared/src/retrieval/index.ts` |
| Modify | `applications/shared/src/index.ts` |
| Modify | `applications/shared/src/types.ts` |
| Modify | `applications/article-pipeline/src/env.ts` |
| Modify | `applications/article-pipeline/src/run-pipeline.ts` |
| Modify | `applications/article-pipeline/src/agents/research-agent.ts` |
| Create | `applications/article-pipeline/src/agents/__tests__/research-agent-retrieval.test.ts` |

---

## Task 1: PgVectorRetriever — class, types, and tests

**Files:**
- Create: `applications/shared/src/retrieval/implementations/PgVectorRetriever.ts`
- Create: `applications/shared/src/retrieval/implementations/PgVectorRetriever.test.ts`

> **RLS rule (non-negotiable):** Every transaction must begin with `SET LOCAL app.current_user_id = $1`. The `queryProfileLayer` and `queryChunkLayer` helpers each open their own client, `BEGIN`, `SET LOCAL`, query, `COMMIT`. This is the same pattern as `RepositoryProfileRepository.upsert`.

- [ ] **Step 1: Write failing tests**

Create `applications/shared/src/retrieval/implementations/PgVectorRetriever.test.ts`:

```typescript
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Pool, PoolClient } from 'pg';

// ─── Pool mock helpers ────────────────────────────────────────────────────────

type MockClient = {
    query:   jest.MockedFunction<PoolClient['query']>;
    release: jest.MockedFunction<() => void>;
};

function makeClient(dataRows: unknown[]): MockClient {
    const query = jest.fn<PoolClient['query']>()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)   // BEGIN
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)   // SET LOCAL
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce({ rows: dataRows, rowCount: dataRows.length } as any) // query
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);  // COMMIT
    return { query, release: jest.fn() };
}

// ─── Imports after mock setup ─────────────────────────────────────────────────

import { PgVectorRetriever } from './PgVectorRetriever.js';
import type { TitanEmbeddingProvider } from '../../rds/implementations/TitanEmbeddingProvider.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FAKE_EMBEDDING = new Array(1024).fill(0.1) as number[];
const USER_ID        = 'user-00000000-0000-0000-0000-000000000001';

const PROFILE_ROW = {
    content:        'Automated Kubernetes drift remediation across multi-env EKS clusters.',
    chunk_type:     'highlight',
    metadata:       {},
    repo_full_name: 'owner/k8s-operator',
    domain:         'devops',
    tech_stack:     ['Kubernetes', 'Go'],
    score:          1.2,   // 0.8 raw × 1.5 weight
};

const CHUNK_ROW = {
    content:        'This file implements the reconciliation loop.',
    repo_full_name: 'owner/k8s-operator',
    file_path:      'pkg/reconcile/loop.go',
    metadata:       {},
    score:          0.7,
};

describe('PgVectorRetriever', () => {
    let mockConnect: jest.MockedFunction<Pool['connect']>;
    let pool:        Pool;
    let embedder:    { embed: jest.MockedFunction<TitanEmbeddingProvider['embed']> };
    let retriever:   PgVectorRetriever;

    beforeEach(() => {
        mockConnect = jest.fn<Pool['connect']>();
        pool        = { connect: mockConnect } as unknown as Pool;
        embedder    = { embed: jest.fn<TitanEmbeddingProvider['embed']>().mockResolvedValue(FAKE_EMBEDDING) };
        retriever   = new PgVectorRetriever(pool, embedder as unknown as TitanEmbeddingProvider);
    });

    it('calls embedder.embed with the query text', async () => {
        mockConnect
            .mockResolvedValueOnce(makeClient([]) as unknown as PoolClient)
            .mockResolvedValueOnce(makeClient([]) as unknown as PoolClient);
        await retriever.retrieve(USER_ID, 'kubernetes operator');
        expect(embedder.embed).toHaveBeenCalledWith('kubernetes operator');
    });

    it('returns profile passages with source="profile"', async () => {
        mockConnect
            .mockResolvedValueOnce(makeClient([PROFILE_ROW]) as unknown as PoolClient)
            .mockResolvedValueOnce(makeClient([]) as unknown as PoolClient);
        const results = await retriever.retrieve(USER_ID, 'kubernetes');
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            text:      PROFILE_ROW.content,
            score:     PROFILE_ROW.score,
            source:    'profile',
            sourceUri: PROFILE_ROW.repo_full_name,
            metadata: {
                repo_full_name: PROFILE_ROW.repo_full_name,
                chunk_type:     PROFILE_ROW.chunk_type,
                domain:         PROFILE_ROW.domain,
                technologies:   PROFILE_ROW.tech_stack,
            },
        });
    });

    it('returns chunk passages with source="chunk"', async () => {
        mockConnect
            .mockResolvedValueOnce(makeClient([]) as unknown as PoolClient)
            .mockResolvedValueOnce(makeClient([CHUNK_ROW]) as unknown as PoolClient);
        const results = await retriever.retrieve(USER_ID, 'reconciliation');
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            text:      CHUNK_ROW.content,
            score:     CHUNK_ROW.score,
            source:    'chunk',
            sourceUri: CHUNK_ROW.file_path,
            metadata: {
                repo_full_name: CHUNK_ROW.repo_full_name,
                file_path:      CHUNK_ROW.file_path,
            },
        });
    });

    it('merges and sorts results by score descending', async () => {
        mockConnect
            .mockResolvedValueOnce(makeClient([PROFILE_ROW]) as unknown as PoolClient)
            .mockResolvedValueOnce(makeClient([CHUNK_ROW]) as unknown as PoolClient);
        const results = await retriever.retrieve(USER_ID, 'kubernetes');
        expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
        expect(results[0]!.source).toBe('profile');
        expect(results[1]!.source).toBe('chunk');
    });

    it('passes maxProfiles as LIMIT to profile query', async () => {
        const profileClient = makeClient([]);
        const chunkClient   = makeClient([]);
        mockConnect
            .mockResolvedValueOnce(profileClient as unknown as PoolClient)
            .mockResolvedValueOnce(chunkClient   as unknown as PoolClient);
        await retriever.retrieve(USER_ID, 'test', { maxProfiles: 3 });
        // The 4th call (index 3) is the actual query; check that $4 = 3
        const actualQueryCall = profileClient.query.mock.calls[2];
        expect(actualQueryCall![1]).toContain(3);
    });

    it('passes maxChunks as LIMIT to chunk query', async () => {
        const profileClient = makeClient([]);
        const chunkClient   = makeClient([]);
        mockConnect
            .mockResolvedValueOnce(profileClient as unknown as PoolClient)
            .mockResolvedValueOnce(chunkClient   as unknown as PoolClient);
        await retriever.retrieve(USER_ID, 'test', { maxChunks: 2 });
        // The 4th call (index 3) for chunk client is the actual query
        const actualQueryCall = chunkClient.query.mock.calls[2];
        expect(actualQueryCall![1]).toContain(2);
    });

    it('rolls back and rethrows when profile query throws', async () => {
        const failClient = {
            query:   jest.fn<PoolClient['query']>()
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                .mockResolvedValueOnce({ rows: [] } as any)  // BEGIN
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                .mockResolvedValueOnce({ rows: [] } as any)  // SET LOCAL
                .mockRejectedValueOnce(new Error('DB error')),
            release: jest.fn(),
        };
        const chunkClient = makeClient([]);
        mockConnect
            .mockResolvedValueOnce(failClient as unknown as PoolClient)
            .mockResolvedValueOnce(chunkClient as unknown as PoolClient);
        await expect(retriever.retrieve(USER_ID, 'test')).rejects.toThrow('DB error');
        expect(failClient.release).toHaveBeenCalled();
    });

    it('returns empty array when both layers return no rows', async () => {
        mockConnect
            .mockResolvedValueOnce(makeClient([]) as unknown as PoolClient)
            .mockResolvedValueOnce(makeClient([]) as unknown as PoolClient);
        const results = await retriever.retrieve(USER_ID, 'nothing');
        expect(results).toEqual([]);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd applications/shared && npx jest --testPathPattern="PgVectorRetriever" --no-coverage 2>&1 | tail -20
```

Expected: `FAIL` — `Cannot find module './PgVectorRetriever.js'`

- [ ] **Step 3: Create PgVectorRetriever implementation**

Create `applications/shared/src/retrieval/implementations/PgVectorRetriever.ts`:

```typescript
import type { Pool } from 'pg';
import type { TitanEmbeddingProvider } from '../../rds/implementations/TitanEmbeddingProvider.js';

export interface RetrievedPassage {
    text:      string;
    score:     number;
    source:    'profile' | 'chunk';
    sourceUri: string;
    metadata: {
        repo_full_name: string;
        chunk_type?:    string;
        file_path?:     string;
        domain?:        string;
        technologies?:  string[];
    };
}

export interface RetrieveOptions {
    maxProfiles?:       number;
    maxChunks?:         number;
    profileWeight?:     number;
    filterByDomain?:    string;
    filterByTechStack?: string[];
}

const DEFAULT_MAX_PROFILES   = 5;
const DEFAULT_MAX_CHUNKS     = 5;
const DEFAULT_PROFILE_WEIGHT = 1.5;

export class PgVectorRetriever {
    constructor(
        private readonly pool:    Pool,
        private readonly embedder: TitanEmbeddingProvider,
    ) {}

    async retrieve(
        userId:  string,
        query:   string,
        options: RetrieveOptions = {},
    ): Promise<RetrievedPassage[]> {
        const {
            maxProfiles   = DEFAULT_MAX_PROFILES,
            maxChunks     = DEFAULT_MAX_CHUNKS,
            profileWeight = DEFAULT_PROFILE_WEIGHT,
            filterByDomain,
            filterByTechStack,
        } = options;

        const embedding = await this.embedder.embed(query);
        const vectorStr = `[${embedding.join(',')}]`;

        const [profilePassages, chunkPassages] = await Promise.all([
            this.queryProfileLayer(userId, vectorStr, maxProfiles, profileWeight, filterByDomain, filterByTechStack),
            this.queryChunkLayer(userId, vectorStr, maxChunks),
        ]);

        return [...profilePassages, ...chunkPassages].sort((a, b) => b.score - a.score);
    }

    private async queryProfileLayer(
        userId:             string,
        vectorStr:          string,
        limit:              number,
        profileWeight:      number,
        filterByDomain?:    string,
        filterByTechStack?: string[],
    ): Promise<RetrievedPassage[]> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SET LOCAL app.current_user_id = $1`, [userId]);

            const params: unknown[] = [userId, vectorStr, profileWeight, limit];
            let domainFilter    = '';
            let techStackFilter = '';

            if (filterByDomain) {
                params.push(filterByDomain);
                domainFilter = `AND p.extracted->>'domain' = $${params.length}`;
            }
            if (filterByTechStack && filterByTechStack.length > 0) {
                params.push(JSON.stringify(filterByTechStack));
                techStackFilter = `AND p.extracted->'tech_stack' @> $${params.length}::jsonb`;
            }

            const result = await client.query<{
                content:        string;
                chunk_type:     string;
                metadata:       Record<string, unknown>;
                repo_full_name: string;
                domain:         string | null;
                tech_stack:     string[] | null;
                score:          number;
            }>(
                `SELECT
                    e.content,
                    e.chunk_type,
                    e.metadata,
                    p.repo_full_name,
                    p.extracted->>'domain'    AS domain,
                    p.extracted->'tech_stack' AS tech_stack,
                    (1 - (e.embedding <=> $2::vector)) * $3 AS score
                 FROM repository_profile_embeddings e
                 JOIN repository_profiles p ON p.id = e.profile_id
                WHERE e.user_id = $1::uuid
                  ${domainFilter}
                  ${techStackFilter}
                ORDER BY e.embedding <=> $2::vector
                LIMIT $4`,
                params,
            );

            await client.query('COMMIT');

            return result.rows.map((row) => ({
                text:      row.content,
                score:     row.score,
                source:    'profile' as const,
                sourceUri: row.repo_full_name,
                metadata: {
                    repo_full_name: row.repo_full_name,
                    chunk_type:     row.chunk_type,
                    domain:         row.domain ?? undefined,
                    technologies:   row.tech_stack ?? undefined,
                },
            }));
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    private async queryChunkLayer(
        userId:    string,
        vectorStr: string,
        limit:     number,
    ): Promise<RetrievedPassage[]> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SET LOCAL app.current_user_id = $1`, [userId]);

            const result = await client.query<{
                content:        string;
                repo_full_name: string;
                file_path:      string;
                metadata:       Record<string, unknown>;
                score:          number;
            }>(
                `SELECT
                    d.content,
                    d.repo_full_name,
                    d.file_path,
                    d.metadata,
                    1 - (d.embedding <=> $2::vector) AS score
                 FROM document_embeddings d
                WHERE d.user_id = $1::uuid
                ORDER BY d.embedding <=> $2::vector
                LIMIT $3`,
                [userId, vectorStr, limit],
            );

            await client.query('COMMIT');

            return result.rows.map((row) => ({
                text:      row.content,
                score:     row.score,
                source:    'chunk' as const,
                sourceUri: row.file_path,
                metadata: {
                    repo_full_name: row.repo_full_name,
                    file_path:      row.file_path,
                },
            }));
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd applications/shared && npx jest --testPathPattern="PgVectorRetriever" --no-coverage 2>&1 | tail -20
```

Expected: `PASS — 8 tests passed`

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/retrieval/implementations/PgVectorRetriever.ts \
        applications/shared/src/retrieval/implementations/PgVectorRetriever.test.ts
git commit -m "feat(shared): add PgVectorRetriever for pgvector-backed passage retrieval"
```

---

## Task 2: Wire PgVectorRetriever exports in @bedrock/shared

**Files:**
- Modify: `applications/shared/src/retrieval/index.ts`
- Modify: `applications/shared/src/index.ts`

- [ ] **Step 1: Update `applications/shared/src/retrieval/index.ts`**

Add after the existing exports (current file ends at line 18):

```typescript
export type {
    RetrievedPassage,
    RetrieveOptions,
} from './implementations/PgVectorRetriever.js';

export { PgVectorRetriever } from './implementations/PgVectorRetriever.js';
```

Full file after edit:

```typescript
/**
 * @format
 * Retrieval — Public API
 *
 * Reranking and other retrieval-time components. Keeps these out of the
 * `rds/` namespace because they are storage-agnostic — the same reranker
 * works for Bedrock KB (Pinecone) candidates and RDS pgvector candidates.
 */

export type {
    IReranker,
    RerankCandidate,
    RerankResult,
    RerankOptions,
} from './interfaces/IReranker.js';

export { BedrockReranker } from './implementations/BedrockReranker.js';
export type { BedrockRerankerConfig } from './implementations/BedrockReranker.js';

export type {
    RetrievedPassage,
    RetrieveOptions,
} from './implementations/PgVectorRetriever.js';

export { PgVectorRetriever } from './implementations/PgVectorRetriever.js';
```

- [ ] **Step 2: Add exports to `applications/shared/src/index.ts`**

In `index.ts`, find the `// ─── Retrieval (Reranking) ──` section (around line 259) and replace it:

```typescript
// ─── Retrieval (Reranking + pgvector) ────────────────────────────────────────
export type {
    IReranker,
    RerankCandidate,
    RerankResult,
    RerankOptions,
    BedrockRerankerConfig,
    RetrievedPassage,
    RetrieveOptions,
} from './retrieval/index.js';

export { BedrockReranker, PgVectorRetriever } from './retrieval/index.js';
```

- [ ] **Step 3: Build shared to verify types compile**

```bash
cd applications/shared && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add applications/shared/src/retrieval/index.ts \
        applications/shared/src/index.ts
git commit -m "feat(shared): export PgVectorRetriever and retrieval types from @bedrock/shared"
```

---

## Task 3: Thread userId through PipelineContext and article-pipeline env

**Files:**
- Modify: `applications/shared/src/types.ts` (line ~70, `PipelineContext` interface)
- Modify: `applications/article-pipeline/src/env.ts`
- Modify: `applications/article-pipeline/src/run-pipeline.ts` (lines 58–75)

> No tests for this task — it's pure plumbing, TypeScript will enforce correctness at compile time. Run `npx tsc --noEmit` after each file change.

- [ ] **Step 1: Add `userId` to `PipelineContext` in `applications/shared/src/types.ts`**

Find the `PipelineContext` interface (line 70). Add `userId` after `readonly startedAt`:

```typescript
/** ISO timestamp of pipeline start */
readonly startedAt: string;

/**
 * User ID sourced from USER_ID env var dispatched by admin-api.
 * Required for pgvector RLS queries. Optional for backwards compatibility
 * with existing Step Functions state payloads.
 */
readonly userId?: string;
```

- [ ] **Step 2: Add `userId` to `PipelineEnv` in `applications/article-pipeline/src/env.ts`**

Replace the file content:

```typescript
/**
 * @format
 * Environment variable parsing for the article pipeline K8s Job.
 *
 * The Job is dispatched by admin-api with a per-run set of env vars.
 * Required: PIPELINE_RUN_ID, SLUG, S3_BUCKET, S3_SOURCE_KEY, PG_*, USER_ID.
 * Optional with defaults: MODE, PIPELINE_ID.
 */
export interface PipelineEnv {
    readonly userId:       string;
    readonly pipelineRunId: string;
    readonly slug:          string;
    readonly s3Bucket:      string;
    readonly s3SourceKey:   string;
    readonly mode:          string;
    readonly pipelineId:    string;
    readonly environment:   string;
    readonly pg: {
        readonly host:     string;
        readonly port:     number;
        readonly database: string;
        readonly user:     string;
        readonly password: string;
    };
}

function required(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

export function parseEnv(): PipelineEnv {
    const pipelineRunId = required('PIPELINE_RUN_ID');
    return {
        userId:       required('USER_ID'),
        pipelineRunId,
        slug:        required('SLUG'),
        s3Bucket:    required('S3_BUCKET'),
        s3SourceKey: required('S3_SOURCE_KEY'),
        mode:        process.env['MODE']        ?? 'standard',
        pipelineId:  process.env['PIPELINE_ID'] ?? pipelineRunId,
        environment: process.env['ENVIRONMENT'] ?? 'production',
        pg: {
            host:     required('PG_HOST'),
            port:     Number.parseInt(process.env['PG_PORT'] ?? '5432', 10),
            database: required('PG_DATABASE'),
            user:     required('PG_USER'),
            password: required('PG_PASSWORD'),
        },
    };
}
```

- [ ] **Step 3: Thread userId into PipelineContext and pass pool to executeResearchAgent in `applications/article-pipeline/src/run-pipeline.ts`**

Change line 64 (`const ctx: PipelineContext = {`) — add `userId: env.userId` after `pipelineId`:

```typescript
const ctx: PipelineContext = {
    pipelineId:        env.pipelineId,
    userId:            env.userId,
    slug:              env.slug,
    sourceKey:         env.s3SourceKey,
    bucket:            env.s3Bucket,
    environment:       env.environment,
    version:           Number.parseInt(process.env['PIPELINE_VERSION'] ?? '1', 10),
    cumulativeTokens:  { input: 0, output: 0, thinking: 0 },
    cumulativeCostUsd: 0,
    retryAttempt:      0,
    startedAt:         new Date().toISOString(),
};
```

Change line 79 (the `executeResearchAgent` call) to pass `pool`:

```typescript
const research = await timed('research', () => executeResearchAgent(ctx, pool));
```

- [ ] **Step 4: Build to verify no type errors**

```bash
cd applications/shared         && npx tsc --noEmit 2>&1 | head -20
cd applications/article-pipeline && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add applications/shared/src/types.ts \
        applications/article-pipeline/src/env.ts \
        applications/article-pipeline/src/run-pipeline.ts
git commit -m "feat(article-pipeline): thread userId into PipelineContext and wire pool to research agent"
```

---

## Task 4: Feature flag and pgvector path in research-agent

**Files:**
- Modify: `applications/article-pipeline/src/agents/research-agent.ts`
- Create: `applications/article-pipeline/src/agents/__tests__/research-agent-retrieval.test.ts`

> This task extends `executeResearchAgent` with a second parameter `pool: Pool` and adds the pgvector retrieval path gated by `process.env['RESEARCH_RETRIEVAL_SOURCE']`. The existing Bedrock KB path is the default so no test regression from existing behaviour.

- [ ] **Step 1: Write failing tests**

Create `applications/article-pipeline/src/agents/__tests__/research-agent-retrieval.test.ts`:

```typescript
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { Pool } from 'pg';

// ─── Mock @bedrock/shared PgVectorRetriever ───────────────────────────────────

const mockRetrieve = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
const MockPgVectorRetriever = jest.fn().mockImplementation(() => ({ retrieve: mockRetrieve }));
const MockTitanEmbeddingProvider = jest.fn().mockImplementation(() => ({}));

jest.mock('@bedrock/shared', () => {
    const actual = jest.requireActual<Record<string, unknown>>('@bedrock/shared');
    return {
        ...actual,
        PgVectorRetriever:       MockPgVectorRetriever,
        TitanEmbeddingProvider:  MockTitanEmbeddingProvider,
        // runAgent must return a minimal ResearchResult shape
        runAgent: jest.fn<() => Promise<unknown>>().mockResolvedValue({
            data: {
                mode:                 'kb-augmented',
                draftContent:         '# Draft\nTest content.',
                complexity:           { tier: 'LOW', budgetTokens: 2048, reason: 'Light', signals: { charCount: 20, codeBlockCount: 0, codeRatio: 0, yamlFrontmatterBlocks: 0, uniqueHeadingCount: 0 } },
                kbPassages:           [],
                outline:              [],
                technicalFacts:       [],
                suggestedTitle:       'Test Title',
                suggestedTags:        [],
                authorDirection:      '',
                previousVersionContent: undefined,
                seoResearch:          undefined,
            },
        }),
    };
});

// ─── Mock AWS SDK clients (needed for module-level init in research-agent) ────

jest.mock('@aws-sdk/client-bedrock-agent-runtime', () => ({
    BedrockAgentRuntimeClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
    RetrieveCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
    S3Client:        jest.fn().mockImplementation(() => ({ send: jest.fn() })),
    GetObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: { from: jest.fn().mockReturnValue({ send: jest.fn() }) },
    GetCommand: jest.fn(),
}));

// ─── Set required env before importing ────────────────────────────────────────

const REQUIRED_ENV: Record<string, string> = {
    RESEARCH_MODEL: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
};
Object.assign(process.env, REQUIRED_ENV);

import { executeResearchAgent } from '../research-agent.js';
import type { PipelineContext } from '@bedrock/shared';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
    return {
        pipelineId:        'run-001',
        userId:            'user-00000000-0000-0000-0000-000000000001',
        slug:              'test-article',
        sourceKey:         'drafts/test-article.md',
        bucket:            'my-bucket',
        environment:       'test',
        version:           1,
        cumulativeTokens:  { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
        retryAttempt:      0,
        startedAt:         new Date().toISOString(),
        ...overrides,
    };
}

const fakePool = {} as Pool;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('executeResearchAgent — retrieval source', () => {
    const originalEnv = process.env['RESEARCH_RETRIEVAL_SOURCE'];

    afterEach(() => {
        if (originalEnv === undefined) {
            delete process.env['RESEARCH_RETRIEVAL_SOURCE'];
        } else {
            process.env['RESEARCH_RETRIEVAL_SOURCE'] = originalEnv;
        }
        mockRetrieve.mockClear();
        MockPgVectorRetriever.mockClear();
        MockTitanEmbeddingProvider.mockClear();
    });

    // Mock S3 read so executeResearchAgent can progress past the draft read
    beforeEach(() => {
        // The S3Client.send mock is already set up; we just need GetObjectCommand
        // to return an object with a Body that has transformToString.
        const { S3Client } = jest.requireMock<{ S3Client: jest.MockedClass<typeof import('@aws-sdk/client-s3').S3Client> }>('@aws-sdk/client-s3');
        S3Client.prototype.send = jest.fn<() => Promise<unknown>>().mockResolvedValue({
            Body: { transformToString: jest.fn<() => Promise<string>>().mockResolvedValue('# Test Draft') },
        });
    });

    it('uses PgVectorRetriever when RESEARCH_RETRIEVAL_SOURCE=pgvector', async () => {
        process.env['RESEARCH_RETRIEVAL_SOURCE'] = 'pgvector';
        await executeResearchAgent(makeCtx(), fakePool);
        expect(MockPgVectorRetriever).toHaveBeenCalledTimes(1);
        expect(mockRetrieve).toHaveBeenCalledTimes(1);
        expect(mockRetrieve).toHaveBeenCalledWith(
            'user-00000000-0000-0000-0000-000000000001',
            expect.any(String),
            expect.objectContaining({ maxProfiles: 5, maxChunks: 5 }),
        );
    });

    it('does NOT use PgVectorRetriever when RESEARCH_RETRIEVAL_SOURCE=bedrock-kb (default)', async () => {
        process.env['RESEARCH_RETRIEVAL_SOURCE'] = 'bedrock-kb';
        await executeResearchAgent(makeCtx(), fakePool);
        expect(MockPgVectorRetriever).not.toHaveBeenCalled();
        expect(mockRetrieve).not.toHaveBeenCalled();
    });

    it('maps RetrievedPassage[] to KbPassage[] shape for downstream agents', async () => {
        process.env['RESEARCH_RETRIEVAL_SOURCE'] = 'pgvector';
        const retrievedPassage = {
            text:      'Automated K8s drift remediation across multi-env EKS clusters.',
            score:     1.2,
            source:    'profile' as const,
            sourceUri: 'owner/k8s-operator',
            metadata:  { repo_full_name: 'owner/k8s-operator' },
        };
        mockRetrieve.mockResolvedValueOnce([retrievedPassage]);

        const { runAgent } = jest.requireMock<{ runAgent: jest.MockedFunction<typeof import('@bedrock/shared').runAgent> }>('@bedrock/shared');

        let capturedPassages: unknown[] = [];
        runAgent.mockImplementationOnce(async (opts: { userMessage?: string; [key: string]: unknown }) => {
            // The userMessage should contain the passage text if mapping is correct
            capturedPassages = [opts.userMessage?.includes(retrievedPassage.text)];
            return {
                data: {
                    mode: 'kb-augmented',
                    draftContent: '',
                    complexity: { tier: 'LOW', budgetTokens: 2048, reason: '', signals: {} },
                    kbPassages: [],
                    outline: [],
                    technicalFacts: [],
                    suggestedTitle: 'T',
                    suggestedTags: [],
                    authorDirection: '',
                },
            };
        });

        await executeResearchAgent(makeCtx(), fakePool);
        expect(capturedPassages[0]).toBe(true);
    });

    it('throws if RESEARCH_RETRIEVAL_SOURCE=pgvector but ctx.userId is absent', async () => {
        process.env['RESEARCH_RETRIEVAL_SOURCE'] = 'pgvector';
        const ctxWithoutUserId = makeCtx({ userId: undefined });
        await expect(executeResearchAgent(ctxWithoutUserId, fakePool))
            .rejects.toThrow('userId');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd applications/article-pipeline && \
  npx jest --testPathPattern="research-agent-retrieval" --no-coverage 2>&1 | tail -30
```

Expected: `FAIL` — `PgVectorRetriever is not a constructor` or similar

- [ ] **Step 3: Modify research-agent.ts**

In `applications/article-pipeline/src/agents/research-agent.ts`, make the following changes:

**a) Add imports** after the existing imports block (after line 36, before the `// === CONFIGURATION ===` comment):

```typescript
import type { Pool }                                                  from 'pg';
import { PgVectorRetriever, TitanEmbeddingProvider }                 from '@bedrock/shared';
import type { RetrievedPassage }                                      from '@bedrock/shared';
```

**b) Add constant** after `const MAX_KB_PASSAGES = 10;` (around line 77):

```typescript
/** Retrieval source: 'bedrock-kb' uses Bedrock Knowledge Base (Pinecone), 'pgvector' uses RDS pgvector */
const RESEARCH_RETRIEVAL_SOURCE = () => process.env['RESEARCH_RETRIEVAL_SOURCE'] ?? 'bedrock-kb';
```

Note: defined as a function so it reads the env var at call time, not module-load time. This enables per-test overrides via `process.env`.

**c) Add `queryPgVector` function** immediately after the `queryKnowledgeBase` function (after line ~220):

```typescript
/**
 * Query RDS pgvector for relevant passages from repository_profile_embeddings
 * and document_embeddings. Used when RESEARCH_RETRIEVAL_SOURCE=pgvector.
 *
 * @param userId - User ID for RLS SET LOCAL
 * @param query  - The search query text
 * @param pool   - Postgres connection pool
 * @returns Array of KB passages mapped from RetrievedPassage shape
 */
async function queryPgVector(userId: string, query: string, pool: Pool): Promise<KbPassage[]> {
    log('INFO', 'Querying pgvector', { agent: 'research', userId, queryLength: query.length });

    const embedder  = new TitanEmbeddingProvider(process.env['AWS_REGION'] ?? 'eu-west-1');
    const retriever = new PgVectorRetriever(pool, embedder);

    const passages: RetrievedPassage[] = await retriever.retrieve(userId, query, {
        maxProfiles: MAX_KB_PASSAGES / 2,
        maxChunks:   MAX_KB_PASSAGES / 2,
    });

    log('INFO', 'pgvector retrieval complete', { agent: 'research', passageCount: passages.length });

    return passages.map((p) => ({
        text:      p.text,
        score:     p.score,
        sourceUri: p.sourceUri,
    }));
}
```

**d) Modify `executeResearchAgent` signature** to accept `pool`:

Change:
```typescript
export async function executeResearchAgent(
    ctx: PipelineContext,
): Promise<AgentResult<ResearchResult>> {
```

To:
```typescript
export async function executeResearchAgent(
    ctx:  PipelineContext,
    pool: Pool,
): Promise<AgentResult<ResearchResult>> {
```

**e) Replace the KB retrieval call** inside `executeResearchAgent` (step 3 currently reads `const kbPassages = await queryKnowledgeBase(draftContent);`):

```typescript
// 3. Retrieve context — either pgvector or Bedrock KB
let kbPassages: KbPassage[];
if (RESEARCH_RETRIEVAL_SOURCE() === 'pgvector') {
    if (!ctx.userId) {
        throw new Error(
            'executeResearchAgent: ctx.userId is required when RESEARCH_RETRIEVAL_SOURCE=pgvector',
        );
    }
    kbPassages = await queryPgVector(ctx.userId, draftContent.substring(0, 1000), pool);
} else {
    kbPassages = await queryKnowledgeBase(draftContent);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd applications/article-pipeline && \
  npx jest --testPathPattern="research-agent-retrieval" --no-coverage 2>&1 | tail -30
```

Expected: `PASS — 4 tests passed`

- [ ] **Step 5: Build both apps to verify no type errors**

```bash
cd applications/shared            && npx tsc --noEmit 2>&1 | head -20
cd applications/article-pipeline  && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 6: Run full test suite for both apps**

```bash
cd applications/shared            && npx jest --no-coverage 2>&1 | tail -20
cd applications/article-pipeline  && npx jest --no-coverage 2>&1 | tail -20
```

Expected: all tests pass

- [ ] **Step 7: Commit**

```bash
git add applications/article-pipeline/src/agents/research-agent.ts \
        applications/article-pipeline/src/agents/__tests__/research-agent-retrieval.test.ts
git commit -m "feat(article-pipeline): add pgvector retrieval path to research agent behind feature flag"
```
