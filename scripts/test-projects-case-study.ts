/**
 * @format
 * E2E test for the Project Case-Study Generation service (Phase 2B).
 *
 *   just test-projects-case-study
 *
 * What it does:
 *   1. Creates an ephemeral `tucaken_test_<ts>` database.
 *   2. Runs the full bootstrap (base DDL + migrations 030–033).
 *   3. Seeds a confirmed multi-repo project (Tucaken) with two
 *      components (API/Web), two repos, profiles, and a handful of KB
 *      chunks.
 *   4. Stubs the commit loader (no real GitHub) and the case-study
 *      agent (no real Sonnet), then exercises the orchestrator end to
 *      end with NO grounding verifier and NO cache the first time.
 *   5. Asserts:
 *        - top-level projects fields populated (tagline, pitch,
 *          case_study_status='complete', case_study_input_hash,
 *          case_study_pipeline_run_id, case_study_model)
 *        - decisions / highlights / challenges / stack_items / resume
 *          bullets / depth markers / architecture all present
 *        - every per-section row carries a content_hash + pipeline_run_id
 *        - source_signals JSON validates against SourceSignalSchema
 *   6. Sticky-edit test: marks pitch + decisions sticky on the projects
 *      row, re-runs, asserts both are unchanged and the skippedSections
 *      report includes them.
 *   7. Idempotency test: clears the sticky flags, re-runs with the same
 *      agent output, asserts no new decisions/highlights/challenges are
 *      inserted (content_hash dedup).
 *   8. Cache test: injects an in-memory ISemanticCache that captures the
 *      first put then returns it as a hit on the second call. Asserts
 *      `cacheHit: true` and agent invocation count is unchanged.
 *   9. Drops the test database.
 */
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { Pool } from 'pg';

import {
    DDL,
    loadMigrations,
} from '../applications/platform-rds-bootstrap/src/bootstrap.js';
import {
    SourceSignalSchema,
    runCaseStudyOrchestration,
} from '../applications/shared/src/index.js';
import {
    runNarrativeGraders,
    judgeCombinedOverview,
    bedrockCombinedOverviewJudge,
} from '../applications/shared/src/projects/case-study-narrative-grader.js';
import type {
    BasePipelineContext,
    CaseStudy,
    CaseStudyAgent,
    CaseStudyContext,
    CommitLoader,
    PullRequestLoader,
} from '../applications/shared/src/index.js';
import type {
    ISemanticCache,
    SemanticCacheGetInput,
    SemanticCacheGetResult,
    SemanticCachePutInput,
} from '../applications/shared/src/cache/cache-types.js';

const TEST_DB_PREFIX = 'tucaken_test_';
const MIGRATIONS_DIR = path.resolve(
    __dirname,
    '../applications/platform-rds-bootstrap/migrations',
);

// ─── PG plumbing ────────────────────────────────────────────────────────────

function adminPool(): Pool {
    return new Pool({
        host:     process.env.PGHOST,
        port:     parseInt(process.env.PGPORT ?? '5432', 10),
        database: 'postgres',
        user:     process.env.PGUSER,
        password: process.env.PGPASSWORD,
        ssl:      process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
        max:      1,
        connectionTimeoutMillis: 10_000,
    });
}

function targetPool(database: string): Pool {
    return new Pool({
        host:     process.env.PGHOST,
        port:     parseInt(process.env.PGPORT ?? '5432', 10),
        database,
        user:     process.env.PGUSER,
        password: process.env.PGPASSWORD,
        ssl:      process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
        max:      3,
        connectionTimeoutMillis: 10_000,
    });
}

async function applyAll(pool: Pool): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query(DDL);
        for (const { sql } of loadMigrations(MIGRATIONS_DIR)) {
            await client.query(sql);
        }
    } finally {
        client.release();
    }
}

// ─── Seed ───────────────────────────────────────────────────────────────────

interface Seed {
    userId:        string;
    projectId:     string;
    pipelineRunId: string;
    apiRepoId:     string;
    webRepoId:     string;
    apiComponentId: string;
    webComponentId: string;
}

async function seed(pool: Pool): Promise<Seed> {
    const client = await pool.connect();
    try {
        const user = await client.query<{ id: string }>(
            `INSERT INTO users (email, full_name) VALUES ($1, $2) RETURNING id`,
            ['alice@example.test', 'Alice'],
        );
        const userId = user.rows[0].id;

        const apiRepo = await client.query<{ id: string }>(
            `INSERT INTO repositories (user_id, provider, full_name, primary_language, topics)
             VALUES ($1, 'github', $2, $3, $4) RETURNING id`,
            [userId, 'alice/tucaken-api', 'TypeScript', ['rag', 'aws']],
        );
        const webRepo = await client.query<{ id: string }>(
            `INSERT INTO repositories (user_id, provider, full_name, primary_language, topics)
             VALUES ($1, 'github', $2, $3, $4) RETURNING id`,
            [userId, 'alice/tucaken-web', 'TypeScript', ['rag', 'tailwind']],
        );

        // Profiles (so the loader has a tech_stack to read).
        for (const [repoId, fullName, tech] of [
            [apiRepo.rows[0].id, 'alice/tucaken-api', ['typescript', 'aws-cdk', 'postgres']] as const,
            [webRepo.rows[0].id, 'alice/tucaken-web', ['typescript', 'react', 'tailwind']] as const,
        ]) {
            await client.query(
                `INSERT INTO repository_profiles (
                    user_id, repository_id, repo_full_name, extracted, classification,
                    extraction_status, extracted_at
                 ) VALUES ($1, $2, $3, $4::jsonb, 'project', 'completed', NOW())`,
                [userId, repoId, fullName, JSON.stringify({ tech_stack: tech })],
            );
        }

        // Backfill the default single-repo projects, then promote one to a
        // confirmed multi-repo project for the test.
        const backfillSql = (await import('node:fs')).readFileSync(
            path.join(MIGRATIONS_DIR, '031_projects_backfill.sql'),
            'utf8',
        );
        await client.query(backfillSql);

        const project = await client.query<{ id: string }>(
            `INSERT INTO projects (
                user_id, slug, name, shape, is_ai_suggested, is_user_confirmed,
                status, role_exhibited, visibility
             ) VALUES ($1, 'tucaken', 'Tucaken', 'multi_repo', TRUE, TRUE,
                       'active', 'sole_builder', 'private')
             RETURNING id`,
            [userId],
        );
        const projectId = project.rows[0].id;

        const apiComponent = await client.query<{ id: string }>(
            `INSERT INTO project_components (user_id, project_id, name, kind, order_index)
             VALUES ($1, $2, 'API', 'backend', 0) RETURNING id`,
            [userId, projectId],
        );
        const webComponent = await client.query<{ id: string }>(
            `INSERT INTO project_components (user_id, project_id, name, kind, order_index)
             VALUES ($1, $2, 'Frontend', 'frontend', 1) RETURNING id`,
            [userId, projectId],
        );

        await client.query(
            `INSERT INTO project_repositories (user_id, project_component_id, repository_id, subpath)
             VALUES ($1, $2, $3, '')`,
            [userId, apiComponent.rows[0].id, apiRepo.rows[0].id],
        );
        await client.query(
            `INSERT INTO project_repositories (user_id, project_component_id, repository_id, subpath)
             VALUES ($1, $2, $3, '')`,
            [userId, webComponent.rows[0].id, webRepo.rows[0].id],
        );

        // KB chunks for the loader.
        for (const [repoFullName, content] of [
            ['alice/tucaken-api', 'FastAPI router for RAG retrieval.'],
            ['alice/tucaken-web', 'Tailwind UI for chat experience.'],
        ] as const) {
            await client.query(
                `INSERT INTO document_embeddings (
                    user_id, repo_full_name, file_path, content, content_hash,
                    chunk_index, total_chunks, embedding
                 ) VALUES ($1, $2, 'README.md', $3, $4, 0, 1,
                          $5::vector)`,
                [
                    userId, repoFullName, content, `hash-${repoFullName}`,
                    `[${new Array(1024).fill(0).map(() => Math.random().toFixed(4)).join(',')}]`,
                ],
            );
        }

        const pipelineRun = await client.query<{ id: string }>(
            `INSERT INTO pipeline_runs (user_id, pipeline_type, status)
             VALUES ($1, 'case_study', 'queued') RETURNING id`,
            [userId],
        );

        return {
            userId,
            projectId,
            pipelineRunId:  pipelineRun.rows[0].id,
            apiRepoId:      apiRepo.rows[0].id,
            webRepoId:      webRepo.rows[0].id,
            apiComponentId: apiComponent.rows[0].id,
            webComponentId: webComponent.rows[0].id,
        };
    } finally {
        client.release();
    }
}

// ─── Mocks ──────────────────────────────────────────────────────────────────

function mockCommitLoader(): CommitLoader {
    return {
        async list(repoFullName, options) {
            void options;
            return [
                { sha: 'a'.repeat(40), authorName: 'Alice', authoredAt: '2025-06-01T10:00:00Z',
                    message: `chore(${repoFullName}): initial scaffold` },
                { sha: 'b'.repeat(40), authorName: 'Alice', authoredAt: '2025-06-15T10:00:00Z',
                    message: `feat(${repoFullName}): grounding verifier` },
                { sha: 'c'.repeat(40), authorName: 'Alice', authoredAt: '2025-07-01T10:00:00Z',
                    message: `fix(${repoFullName}): pgvector dim mismatch` },
            ];
        },
    };
}

function mockPullRequestLoader(): PullRequestLoader {
    return {
        async list(repoFullName, options) {
            void options;
            return [
                {
                    number:    42,
                    title:     `Add grounding verifier (${repoFullName})`,
                    body:      'Block ungrounded chatbot answers.',
                    state:     'merged',
                    mergedAt:  '2025-06-15T11:00:00Z',
                    createdAt: '2025-06-14T10:00:00Z',
                    htmlUrl:   `https://github.com/${repoFullName}/pull/42`,
                },
                {
                    number:    51,
                    title:     `Fix pgvector dim mismatch (${repoFullName})`,
                    body:      'Pin every embedding column to vector(1024).',
                    state:     'merged',
                    mergedAt:  '2025-07-01T11:00:00Z',
                    createdAt: '2025-06-30T10:00:00Z',
                    htmlUrl:   `https://github.com/${repoFullName}/pull/51`,
                },
            ];
        },
    };
}

function failingPullRequestLoader(): PullRequestLoader {
    return {
        async list() {
            throw new Error('insufficient scope: pull_requests:read missing');
        },
    };
}

function deterministicCaseStudy(context: CaseStudyContext): CaseStudy {
    const apiRepo = context.repositories.find((r) => r.fullName.endsWith('tucaken-api'))!;
    return {
        tagline: 'A grounded multi-repo RAG portfolio platform.',
        pitch:   'Tucaken pairs an evidence-cited LLM pipeline with a Tailwind UI to surface depth from real code history.',
        stack: [
            {
                category:      'language',
                name:          'TypeScript',
                justification: 'Both API and web compile from TypeScript per repository_profiles.tech_stack.',
                componentName: 'API',
                sourceSignals: {
                    commits: [{ repoFullName: apiRepo.fullName, sha: 'a'.repeat(40), authoredAt: '2025-06-01T10:00:00Z', message: 'chore(alice/tucaken-api): initial scaffold' }],
                    pulls: [], files: [], ungroundedClaims: [], grounding: 'NOT_VERIFIED',
                },
            },
        ],
        decisions: [
            {
                title:        'Bedrock Converse with forced tool_use',
                context:      'The model occasionally returned free-form text instead of JSON.',
                decision:     'Constrain output via Anthropic tool_use with toolChoice forced.',
                consequences: 'No extended thinking, but guaranteed schema-compliant payloads.',
                confidence:   'high',
                sourceSignals: {
                    commits: [{ repoFullName: apiRepo.fullName, sha: 'b'.repeat(40), authoredAt: '2025-06-15T10:00:00Z', message: 'feat(alice/tucaken-api): grounding verifier' }],
                    pulls: [], files: [], ungroundedClaims: [], grounding: 'NOT_VERIFIED',
                },
            },
        ],
        highlights: [
            {
                title:        'Grounded answers in production',
                description: 'BedrockGroundingVerifier in mode=block on chatbot; mode=flag in case-study so evidence is recorded but not blocked.',
                sourceSignals: {
                    commits: [{ repoFullName: apiRepo.fullName, sha: 'b'.repeat(40), authoredAt: '2025-06-15T10:00:00Z', message: 'feat(alice/tucaken-api): grounding verifier' }],
                    pulls: [], files: [], ungroundedClaims: [], grounding: 'NOT_VERIFIED',
                },
            },
        ],
        challenges: [
            {
                problem:       'pgvector dim mismatch broke ingestion overnight.',
                solution:      'Pinned vector(1024) across every embedding column and added a dim-asserting migration check.',
                sourceSignals: {
                    commits: [{ repoFullName: apiRepo.fullName, sha: 'c'.repeat(40), authoredAt: '2025-07-01T10:00:00Z', message: 'fix(alice/tucaken-api): pgvector dim mismatch' }],
                    pulls: [], files: [], ungroundedClaims: [], grounding: 'NOT_VERIFIED',
                },
            },
        ],
        depthMarkers: {
            hasTests: true, testCoverageSignal: 'moderate', hasCi: true,
            ciMaturity: 'deploys_to_prod', documentationDensity: 'docs_dir',
            hasDeploymentEvidence: true, deploymentUrl: 'https://example.test',
            refactorCount: 3,
        },
        architecture: {
            diagramFormat: 'mermaid',
            diagramSource: `graph LR\n  Web["Tucaken Web"] --> API["Tucaken API"]\n  API --> DB[("Postgres+pgvector")]`,
            nodes: [
                { id: 'web', label: 'Tucaken Web', kind: 'frontend' },
                { id: 'api', label: 'Tucaken API', kind: 'backend' },
            ],
            edges: [{ from: 'web', to: 'api', label: 'https' }],
        },
        resumeBullets: [
            { angle: 'backend',  bullets: ['Shipped grounded RAG pipeline on Bedrock + pgvector.'] },
            { angle: 'frontend', bullets: ['Built Tailwind UI for the chat experience.'] },
        ],
    };
}

function makeMockAgent(): { agent: CaseStudyAgent; invocations: () => number } {
    let count = 0;
    return {
        invocations: () => count,
        agent: {
            async invoke(context, ctx) {
                count++;
                const data = deterministicCaseStudy(context);
                return {
                    data,
                    ctx,
                    tokens: { input: 0, output: 0, thinking: 0 },
                    costUsd: 0,
                    durationMs: 0,
                } as unknown as Awaited<ReturnType<CaseStudyAgent['invoke']>>;
            },
        },
    };
}

class InMemoryCache implements ISemanticCache {
    private store = new Map<string, unknown>();

    async get(input: SemanticCacheGetInput): Promise<SemanticCacheGetResult> {
        const k = `${input.scope}::${input.kbTag}::${input.queryText}`;
        if (this.store.has(k)) {
            return { hit: true, response: this.store.get(k), similarity: 1 };
        }
        return { hit: false };
    }
    async put(input: SemanticCachePutInput): Promise<void> {
        const k = `${input.scope}::${input.kbTag}::${input.queryText}`;
        this.store.set(k, input.response);
    }
    async invalidate(): Promise<number> {
        const n = this.store.size;
        this.store.clear();
        return n;
    }
}

function ctxFor(pipelineRunId: string): BasePipelineContext {
    return {
        pipelineId:        pipelineRunId,
        environment:       'test',
        cumulativeTokens:  { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
    };
}

// ─── Assertions ─────────────────────────────────────────────────────────────

async function rowCount(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
    const r = await pool.query<{ count: string }>(sql, params);
    return parseInt(r.rows[0].count, 10);
}

async function assertPersistedShape(pool: Pool, seed: Seed): Promise<void> {
    const project = await pool.query<{
        tagline:                    string | null;
        pitch:                      string | null;
        case_study_status:          string | null;
        case_study_generated_at:    Date   | null;
        case_study_pipeline_run_id: string | null;
        case_study_model:           string | null;
        case_study_input_hash:      string | null;
    }>(`SELECT tagline, pitch, case_study_status, case_study_generated_at,
               case_study_pipeline_run_id, case_study_model, case_study_input_hash
        FROM projects WHERE id = $1`, [seed.projectId]);
    const row = project.rows[0];
    assert.ok(row.tagline, 'tagline populated');
    assert.ok(row.pitch, 'pitch populated');
    assert.equal(row.case_study_status, 'complete');
    assert.ok(row.case_study_generated_at);
    assert.equal(row.case_study_pipeline_run_id, seed.pipelineRunId);
    assert.ok(row.case_study_model);
    assert.ok(row.case_study_input_hash);

    assert.equal(
        await rowCount(pool, `SELECT COUNT(*)::text AS count FROM project_decisions  WHERE project_id = $1`, [seed.projectId]),
        1, 'one decision inserted');
    assert.equal(
        await rowCount(pool, `SELECT COUNT(*)::text AS count FROM project_highlights WHERE project_id = $1`, [seed.projectId]),
        1, 'one highlight inserted');
    assert.equal(
        await rowCount(pool, `SELECT COUNT(*)::text AS count FROM project_challenges WHERE project_id = $1`, [seed.projectId]),
        1, 'one challenge inserted');
    assert.equal(
        await rowCount(pool, `SELECT COUNT(*)::text AS count FROM project_stack_items WHERE project_id = $1`, [seed.projectId]),
        1, 'one stack item inserted');
    assert.equal(
        await rowCount(pool, `SELECT COUNT(*)::text AS count FROM project_resume_bullets WHERE project_id = $1`, [seed.projectId]),
        2, 'two resume-bullet angles inserted');
    assert.equal(
        await rowCount(pool, `SELECT COUNT(*)::text AS count FROM project_depth_markers WHERE project_id = $1`, [seed.projectId]),
        1, 'depth markers row');
    assert.equal(
        await rowCount(pool, `SELECT COUNT(*)::text AS count FROM project_architecture WHERE project_id = $1`, [seed.projectId]),
        1, 'architecture row');

    const sample = await pool.query<{
        content_hash:    string | null;
        pipeline_run_id: string | null;
        source_signals:  unknown;
    }>(`SELECT content_hash, pipeline_run_id, source_signals
        FROM project_decisions WHERE project_id = $1 LIMIT 1`, [seed.projectId]);
    assert.ok(sample.rows[0].content_hash, 'decision content_hash populated');
    assert.equal(sample.rows[0].pipeline_run_id, seed.pipelineRunId);
    const ss = SourceSignalSchema.safeParse(sample.rows[0].source_signals);
    assert.ok(ss.success, `source_signals validates: ${ss.success ? '' : ss.error.message}`);
}

async function assertSticky(pool: Pool, seed: Seed): Promise<void> {
    // Capture current pitch + decision title.
    const before = await pool.query<{ pitch: string; decision: string }>(
        `SELECT p.pitch, pd.title AS decision
         FROM projects p
         JOIN project_decisions pd ON pd.project_id = p.id
         WHERE p.id = $1 LIMIT 1`,
        [seed.projectId],
    );

    // Mark sticky.
    await pool.query(
        `UPDATE projects SET user_overrides = '{"pitch": true, "decisions": true}'::jsonb
         WHERE id = $1`,
        [seed.projectId],
    );

    return Promise.resolve().then(async () => {
        // Re-run with a *different* agent so the mock would normally rewrite
        // pitch + decisions; sticky must protect them.
        const overridingAgent: CaseStudyAgent = {
            async invoke(context, ctx) {
                const base = deterministicCaseStudy(context);
                const data: CaseStudy = {
                    ...base,
                    pitch:     'OVERRIDDEN PITCH that should never land.',
                    decisions: [{
                        title:        'OVERRIDDEN decision',
                        context:      'x', decision: 'y', consequences: 'z',
                        confidence:   'low',
                        sourceSignals: {
                            commits: [], pulls: [], files: [],
                            ungroundedClaims: [], grounding: 'NOT_VERIFIED',
                        },
                    }],
                };
                return {
                    data, ctx,
                    tokens: { input: 0, output: 0, thinking: 0 },
                    costUsd: 0, durationMs: 0,
                } as unknown as Awaited<ReturnType<CaseStudyAgent['invoke']>>;
            },
        };

        const out = await runCaseStudyOrchestration(pool, {
            projectId:     seed.projectId,
            pipelineRunId: seed.pipelineRunId,
            model:         'mock',
            kbTag:         'mock-kb',
            agent:         overridingAgent,
            commitLoader:  mockCommitLoader(),
            ctx:           ctxFor(seed.pipelineRunId),
        });

        assert.ok(out.persisted.skippedSections.includes('pitch'), 'pitch skipped');
        assert.ok(out.persisted.skippedSections.includes('decisions'), 'decisions skipped');
        assert.equal(out.persisted.decisionsInserted, 0, 'no decisions inserted under sticky');

        const after = await pool.query<{ pitch: string; decision: string }>(
            `SELECT p.pitch, pd.title AS decision
             FROM projects p
             JOIN project_decisions pd ON pd.project_id = p.id
             WHERE p.id = $1 LIMIT 1`,
            [seed.projectId],
        );
        assert.equal(after.rows[0].pitch,    before.rows[0].pitch,    'pitch unchanged under sticky');
        assert.equal(after.rows[0].decision, before.rows[0].decision, 'decision unchanged under sticky');

        // Clear overrides for the next test.
        await pool.query(
            `UPDATE projects SET user_overrides = '{}'::jsonb WHERE id = $1`,
            [seed.projectId],
        );
    });
}

async function assertIdempotency(pool: Pool, seed: Seed): Promise<void> {
    const { agent } = makeMockAgent();
    const before = await rowCount(
        pool, `SELECT COUNT(*)::text AS count FROM project_decisions WHERE project_id = $1`,
        [seed.projectId],
    );
    await runCaseStudyOrchestration(pool, {
        projectId:     seed.projectId,
        pipelineRunId: seed.pipelineRunId,
        model:         'mock',
        kbTag:         'mock-kb',
        agent,
        commitLoader:  mockCommitLoader(),
        ctx:           ctxFor(seed.pipelineRunId),
    });
    const after = await rowCount(
        pool, `SELECT COUNT(*)::text AS count FROM project_decisions WHERE project_id = $1`,
        [seed.projectId],
    );
    assert.equal(after, before, 're-run does not duplicate decisions (content_hash dedup)');
}

async function assertCacheHit(pool: Pool, seed: Seed): Promise<void> {
    const cache = new InMemoryCache();
    const { agent, invocations } = makeMockAgent();

    const out1 = await runCaseStudyOrchestration(pool, {
        projectId:     seed.projectId,
        pipelineRunId: seed.pipelineRunId,
        model:         'mock',
        kbTag:         'mock-kb',
        agent,
        cache,
        commitLoader:  mockCommitLoader(),
        ctx:           ctxFor(seed.pipelineRunId),
    });
    assert.equal(out1.cacheHit, false, 'first run is a miss');
    const invocationsAfterFirst = invocations();

    const out2 = await runCaseStudyOrchestration(pool, {
        projectId:     seed.projectId,
        pipelineRunId: seed.pipelineRunId,
        model:         'mock',
        kbTag:         'mock-kb',
        agent,
        cache,
        commitLoader:  mockCommitLoader(),
        ctx:           ctxFor(seed.pipelineRunId),
    });
    assert.equal(out2.cacheHit, true, 'second run is a hit');
    assert.equal(invocations(), invocationsAfterFirst, 'agent not invoked on cache hit');
}

// ─── Phase 3c — PR evidence ────────────────────────────────────────────────

async function assertPullRequestEvidence(pool: Pool, seed: Seed): Promise<void> {
    // Clear any sticky flags + drop the existing case-study children so we
    // can observe a fresh insertion that includes PR signals.
    await pool.query(
        `UPDATE projects SET user_overrides = '{}'::jsonb WHERE id = $1`,
        [seed.projectId],
    );
    await pool.query(`DELETE FROM project_decisions  WHERE project_id = $1`, [seed.projectId]);
    await pool.query(`DELETE FROM project_highlights WHERE project_id = $1`, [seed.projectId]);
    await pool.query(`DELETE FROM project_challenges WHERE project_id = $1`, [seed.projectId]);

    // Agent emits a decision that cites a PR by number — mirrors the real
    // Sonnet output once PR evidence reaches the prompt.
    const agentWithPullEvidence: CaseStudyAgent = {
        async invoke(_context, ctx) {
            const data: CaseStudy = {
                tagline: 'A grounded multi-repo RAG portfolio platform.',
                pitch:   'Tucaken pairs an evidence-cited LLM pipeline with a Tailwind UI to surface depth from real code history.',
                stack: [],
                decisions: [{
                    title:        'Grounded answers in chatbot',
                    context:      'Free-form Bedrock output occasionally invented citations.',
                    decision:     'Block ungrounded replies via BedrockGroundingVerifier in mode=block.',
                    consequences: 'Higher latency on the chat path; trustworthy answers.',
                    confidence:   'high',
                    sourceSignals: {
                        commits: [],
                        pulls: [{
                            repoFullName: 'alice/tucaken-api',
                            number:       42,
                            title:        'Add grounding verifier (alice/tucaken-api)',
                            htmlUrl:      'https://github.com/alice/tucaken-api/pull/42',
                            mergedAt:     '2025-06-15T11:00:00Z',
                        }],
                        files: [],
                        ungroundedClaims: [],
                        grounding: 'NOT_VERIFIED',
                    },
                }],
                highlights: [],
                challenges: [],
                depthMarkers: {
                    hasTests: true, testCoverageSignal: 'moderate', hasCi: true,
                    ciMaturity: 'deploys_to_prod', documentationDensity: 'docs_dir',
                    hasDeploymentEvidence: true, deploymentUrl: 'https://example.test',
                    refactorCount: 3,
                },
                architecture: {
                    diagramFormat: 'mermaid',
                    diagramSource: 'graph LR\n  A --> B',
                    nodes: [], edges: [],
                },
                resumeBullets: [
                    { angle: 'backend', bullets: ['Shipped grounded RAG pipeline.'] },
                ],
            };
            return {
                data, ctx,
                tokens: { input: 0, output: 0, thinking: 0 },
                costUsd: 0, durationMs: 0,
            } as unknown as Awaited<ReturnType<CaseStudyAgent['invoke']>>;
        },
    };

    const out = await runCaseStudyOrchestration(pool, {
        projectId:         seed.projectId,
        pipelineRunId:     seed.pipelineRunId,
        model:             'mock',
        kbTag:             'mock-kb-prs',
        agent:             agentWithPullEvidence,
        commitLoader:      mockCommitLoader(),
        pullRequestLoader: mockPullRequestLoader(),
        ctx:               ctxFor(seed.pipelineRunId),
    });
    assert.equal(out.cacheHit, false);
    // The orchestrator should have loaded PR rows into the context.
    assert.ok(out.contextLoaded.context.pulls.length > 0, 'loader populated PR list');
    const persistedPR = await pool.query<{ source_signals: { pulls: { number: number; htmlUrl: string }[] } }>(
        `SELECT source_signals FROM project_decisions WHERE project_id = $1`,
        [seed.projectId],
    );
    const decision = persistedPR.rows[0];
    assert.ok(decision, 'decision row persisted');
    assert.equal(decision.source_signals.pulls.length, 1, 'PR persisted in source_signals');
    assert.equal(decision.source_signals.pulls[0].number, 42);
    assert.match(decision.source_signals.pulls[0].htmlUrl, /\/pull\/42$/);
}

async function assertPullRequestLoaderFailure(pool: Pool, seed: Seed): Promise<void> {
    // A failing PR loader (e.g. insufficient OAuth scope) must NOT crash
    // the run; the case-study should still ship with an empty pulls list.
    const { agent } = makeMockAgent();
    const out = await runCaseStudyOrchestration(pool, {
        projectId:         seed.projectId,
        pipelineRunId:     seed.pipelineRunId,
        model:             'mock',
        kbTag:             'mock-kb-fail',
        agent,
        commitLoader:      mockCommitLoader(),
        pullRequestLoader: failingPullRequestLoader(),
        ctx:               ctxFor(seed.pipelineRunId),
    });
    assert.equal(out.contextLoaded.context.pulls.length, 0, 'failure resulted in empty pulls');
    assert.ok(out.inputHash, 'orchestration still produced an input hash');
}

// ─── Narrative grader report ─────────────────────────────────────────────────

async function reportNarrativeGraders(caseStudy: CaseStudy): Promise<void> {
    const narrative = runNarrativeGraders({ caseStudy });
    for (const r of narrative.results) {
        const suffix = r.failures.length ? ` — ${r.failures.join('; ')}` : '';
        console.log(`  ${r.pass ? 'PASS' : 'FAIL'} ${r.grader}${suffix}`);
    }
    assert.equal(narrative.results.length, 3);
    if (process.env.CASE_STUDY_EVAL_JUDGE !== '1') return;
    try {
        const judged = await judgeCombinedOverview(caseStudy, bedrockCombinedOverviewJudge);
        const suffix = judged.failures.length ? ` — ${judged.failures.join('; ')}` : '';
        console.log(`  ${judged.pass ? 'PASS' : 'FAIL'} ${judged.grader} (score ${judged.score.toFixed(2)})${suffix}`);
    } catch (err) {
        console.log(`  SKIP combinedOverview judge — ${(err as Error).message}`);
    }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    if (!process.env.PGHOST || !process.env.PGUSER) {
        console.error('PGHOST and PGUSER must be set');
        process.exit(2);
    }
    const dbName = `${TEST_DB_PREFIX}${Date.now()}`;
    const admin  = adminPool();

    try {
        console.log(`Creating test database ${dbName}...`);
        const adminClient = await admin.connect();
        try { await adminClient.query(`CREATE DATABASE "${dbName}"`); }
        finally { adminClient.release(); }

        const pool = targetPool(dbName);
        try {
            console.log('Applying base DDL + every numbered migration...');
            await applyAll(pool);

            console.log('Seeding confirmed multi-repo project + repos + profiles + KB...');
            const seedResult = await seed(pool);

            const { agent } = makeMockAgent();
            console.log('Running case-study orchestrator (no verifier, no cache)...');
            const out = await runCaseStudyOrchestration(pool, {
                projectId:     seedResult.projectId,
                pipelineRunId: seedResult.pipelineRunId,
                model:         'mock-sonnet-4-6',
                kbTag:         'mock-kb',
                agent,
                commitLoader:  mockCommitLoader(),
                ctx:           ctxFor(seedResult.pipelineRunId),
            });
            assert.equal(out.cacheHit, false);
            assert.ok(out.inputHash);

            console.log('Asserting persisted shape...');
            await assertPersistedShape(pool, seedResult);

            console.log('Asserting sticky-edit protection...');
            await assertSticky(pool, seedResult);

            console.log('Asserting content_hash idempotency...');
            await assertIdempotency(pool, seedResult);

            console.log('Asserting semantic-cache hit on second run...');
            await assertCacheHit(pool, seedResult);

            console.log('Asserting PR-evidence wiring (Phase 3c)...');
            await assertPullRequestEvidence(pool, seedResult);

            console.log('Asserting PR-loader failure is non-fatal...');
            await assertPullRequestLoaderFailure(pool, seedResult);

            console.log('Running narrative graders...');
            // Assert plumbing only (3 deterministic graders); mock fixture is not a regression gate.
            await reportNarrativeGraders(out.caseStudy);

            console.log('OK — all assertions passed.');
        } finally {
            await pool.end();
        }
    } finally {
        const adminClient = await admin.connect();
        try {
            await adminClient.query(
                `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                 WHERE datname = $1 AND pid <> pg_backend_pid()`,
                [dbName],
            );
            await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}"`);
            console.log(`Dropped test database ${dbName}.`);
        } catch (err) {
            console.warn(`Failed to drop test database ${dbName}:`, err);
        } finally {
            adminClient.release();
        }
        await admin.end();
    }
}

main().catch((err) => {
    console.error('Case-study E2E failed:', err);
    process.exit(1);
});
