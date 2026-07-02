import { describe, it, expect, jest, beforeAll } from '@jest/globals';
import type { Pool } from 'pg';

// ─── All mocks MUST be declared before the module under test is imported ──────
// run-pipeline.ts calls main() at the bottom as main().catch(() => process.exit(1)).
// Every dependency must be mocked before the dynamic import in beforeAll.

// Use a latch promise so we can await main() completing via persistArticle.
let resolvePersistLatch: (args: unknown[]) => void;
const persistLatch = new Promise<unknown[]>((resolve) => {
    resolvePersistLatch = resolve;
});

const mockPersistArticle = jest.fn<() => Promise<void>>().mockImplementation((...args) => {
    resolvePersistLatch(args);
    return Promise.resolve();
});
const mockUpdatePipelineRun = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

// Latch on the metadata write — it fires a few awaits after persistArticle, so
// capturing it off the persist latch races. Resolve when the payload lands.
let resolveMetaLatch: (args: unknown[]) => void;
const metaLatch = new Promise<unknown[]>((resolve) => {
    resolveMetaLatch = resolve;
});
const mockUpdatePipelineRunMetadata = jest.fn<() => Promise<void>>().mockImplementation((...args) => {
    resolveMetaLatch(args);
    return Promise.resolve();
});

jest.mock('../lib/pipeline-runs.js', () => ({
    persistArticle:            mockPersistArticle,
    updatePipelineRun:         mockUpdatePipelineRun,
    updatePipelineRunMetadata: mockUpdatePipelineRunMetadata,
}));

// Mock the pg pool so no real DB connection is attempted.
const mockPool = { query: jest.fn() };
jest.mock('../lib/pg.js', () => ({
    getPool:   jest.fn().mockReturnValue(mockPool),
    closePool: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

// Writer agent returns MDX containing a raw PII address — simulates an article
// body the writer produced before the pipeline's MDX-persist scrub step.
const RAW_PII_EMAIL = 'contact@company.io';
// Real WriterResult shape: { content, metadata: {...}, shotList }. The persist
// step reads metadata.title/description/tags, so the mock must nest them.
const mockWriterData = {
    content:  `# My Article\n\nContact ${RAW_PII_EMAIL} for more info.\n`,
    metadata: {
        title:               'From Failure to Certification: the SPIDER Method',
        description:         'A concise, specific SEO meta description for the test article.',
        tags:                ['aws', 'devops', 'certification'],
        slug:                'my-article',
        publishDate:         '2026-07-01',
        readingTime:         1,
        category:            'DevOps',
        aiSummary:           'A short teaser.',
        technicalConfidence: 90,
        skillsDemonstrated:  [],
        processingNote:      '',
        primaryKeyword:      'aws devops certification',
        secondaryKeywords:   [],
    },
    shotList:            [],
    suggestedReferences: [],
};

const mockResearchData = {
    mode:                   'kb-augmented',
    draftContent:           '# Draft',
    complexity:             { tier: 'LOW', budgetTokens: 2048, reason: '', signals: {} },
    kbPassages:             [],
    outline:                [],
    technicalFacts:         [],
    suggestedTitle:         'My Article',
    suggestedTags:          [],
    authorDirection:        '',
    previousVersionContent: undefined,
    seoResearch:            undefined,
};

// Full QaValidationResult shape — buildRunMetadata iterates `dimensions`, so a
// legacy `{ overallScore, issues }` mock throws and aborts main() before the
// metadata write. Mirror the real per-dimension breakdown.
const cleanDim = { score: 88, issues: [] };
const mockQaData = {
    overallScore:   85,
    recommendation: 'publish',
    dimensions: {
        technicalAccuracy:    cleanDim,
        seoCompliance:        cleanDim,
        mdxStructure:         cleanDim,
        metadataQuality:      cleanDim,
        contentQuality:       cleanDim,
        specificityAndResult: cleanDim,
    },
    summary:            'Solid draft, ready for review.',
    confidenceOverride: 88,
};

const fakeAgentResult = <T>(data: T) => ({
    data,
    tokenUsage: { input: 0, output: 0, thinking: 0 },
    durationMs: 0,
    agentName:  'mock',
    modelId:    'mock',
    costUsd:    0,
});

jest.mock('../agents/research-agent.js', () => ({
    executeResearchAgent: jest.fn<() => Promise<unknown>>()
        .mockResolvedValue(fakeAgentResult(mockResearchData)),
}));

jest.mock('../agents/writer-agent.js', () => ({
    executeWriterAgent: jest.fn<() => Promise<unknown>>()
        .mockResolvedValue(fakeAgentResult(mockWriterData)),
}));

jest.mock('../agents/qa-agent.js', () => ({
    executeQaAgent: jest.fn<() => Promise<unknown>>()
        .mockResolvedValue(fakeAgentResult(mockQaData)),
}));

// ─── Grounding mock handles ──────────────────────────────────────────────────
// groundingVerifyMock is the spy injected as the `verify` method on every
// BedrockGroundingVerifier instance created by the module under test.
// emitEmfMetricMock lets tests assert what metrics were emitted.
const groundingVerifyMock = jest.fn<() => Promise<unknown>>().mockResolvedValue({
    status: 'GROUNDED', reason: '', ungroundedClaims: [], answer: 'ok',
});
const emitEmfMetricMock = jest.fn<() => void>();

// Observability stubs — avoid real Prometheus setup in tests.
jest.mock('@bedrock/shared', () => {
    const actual = jest.requireActual<Record<string, unknown>>('@bedrock/shared');
    return {
        ...actual,
        PiiScrubber: jest.fn().mockImplementation(() => ({
            scrub: (text: string) => ({
                // Minimal scrub: replace any whitespace token containing '@'
                redacted: text.replace(/\S+/g, (w) => (w.includes('@') ? '[EMAIL]' : w)),
                findings: [],
            }),
        })),
        BedrockGroundingVerifier: jest.fn().mockImplementation(() => ({
            verify: groundingVerifyMock,
        })),
        emitEmfMetric: emitEmfMetricMock,
        bootstrapK8sObservability: jest.fn().mockReturnValue({
            logger:   { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
            registry: {},
            shutdown: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        }),
        pushFinalMetrics: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
});

// prom-client: stub Counter and Histogram to avoid metric registration errors.
jest.mock('prom-client', () => ({
    Counter:   jest.fn().mockImplementation(() => ({ inc: jest.fn() })),
    Histogram: jest.fn().mockImplementation(() => ({ observe: jest.fn() })),
}));

// Set all required env vars that parseEnv() demands BEFORE the module loads.
Object.assign(process.env, {
    PIPELINE_RUN_ID: 'run-test-001',
    USER_ID:         'user-00000000-0000-0000-0000-000000000001',
    SLUG:            'test-article',
    S3_BUCKET:       'my-test-bucket',
    S3_SOURCE_KEY:   'drafts/test-article.md',
    PG_HOST:         'localhost',
    PG_DATABASE:     'testdb',
    PG_USER:         'testuser',
    PG_PASSWORD:     'testpass',
    RESEARCH_MODEL:  'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
    WRITER_MODEL:    'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
    FOUNDATION_MODEL:'eu.anthropic.claude-sonnet-4-6',
    QA_MODEL:        'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
});

// ─── Shared state captured before clearMocks resets per-test ────────────────
// clearMocks: true in jest.config resets mock.calls between tests.
// We capture what we need in the first describe's beforeAll while the mock
// calls from the module-level main() run are still intact.

let sharedPersistArgs: unknown[];
let sharedEmittedMetrics: Array<{ name: string; value: number }> = [];
let sharedMetadataArg: Record<string, unknown>;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('run-pipeline — MDX-persist PII scrub', () => {
    let persistArgs: unknown[];

    // Dynamically import run-pipeline, which triggers main().
    // We await the persistLatch promise so the tests run only after
    // persistArticle has been called.
    beforeAll(async () => {
        await import('../run-pipeline.js');
        persistArgs = await persistLatch;
        sharedPersistArgs = persistArgs;
        // Capture EMF calls NOW — before clearMocks resets them between tests.
        sharedEmittedMetrics = emitEmfMetricMock.mock.calls.flatMap(
            (call) => (call as unknown[])[2] as Array<{ name: string; value: number }>,
        );
        // Await the metadata latch: the write lands a few awaits after persist.
        const metaArgs = await metaLatch;
        sharedMetadataArg = (metaArgs[2] ?? {}) as Record<string, unknown>;
    }, 10_000);

    it('calls persistArticle with redacted MDX — raw PII email is absent', () => {
        const contentArg = persistArgs[2] as string;
        expect(contentArg).not.toContain(RAW_PII_EMAIL);
    });

    it('calls persistArticle with redacted MDX — [EMAIL] token is present', () => {
        const contentArg = persistArgs[2] as string;
        expect(contentArg).toContain('[EMAIL]');
    });

    it('stamps ai_model provenance with the writer foundation model', () => {
        expect(persistArgs[3]).toBe('eu.anthropic.claude-sonnet-4-6');
    });

    it('writes the Writer title/excerpt/tags into their own columns (not the placeholder slug)', () => {
        expect(persistArgs[4]).toEqual({
            title:   'From Failure to Certification: the SPIDER Method',
            excerpt: 'A concise, specific SEO meta description for the test article.',
            tags:    ['aws', 'devops', 'certification'],
        });
    });
});

// ─── Grounding (flag-mode) tests ─────────────────────────────────────────────
// The scrubbed MDX that persistArticle should always receive (flag mode never alters it).
const EXPECTED_SCRUBBED_CONTENT = `# My Article\n\nContact [EMAIL] for more info.\n`;

describe('run-pipeline — grounding flag-mode post-QA (happy path, GROUNDED)', () => {
    // This describe re-uses the single run already triggered above.
    // groundingVerifyMock defaults to GROUNDED, so the happy path run
    // exercises the success EMF branch.

    it('persists exactly the scrubbed writer MDX — flag mode never alters content', async () => {
        // Wait until the module-level run has completed.
        await persistLatch;
        const persistedContent = sharedPersistArgs[2] as string;
        expect(persistedContent).toBe(EXPECTED_SCRUBBED_CONTENT);
    });

    it('emits GroundingChecked=1 and GroundingFailed=0 on a GROUNDED result', async () => {
        await persistLatch;
        // Use sharedEmittedMetrics captured in beforeAll — clearMocks: true would
        // have wiped emitEmfMetricMock.mock.calls by the time this test runs.
        expect(sharedEmittedMetrics).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'GroundingChecked', value: 1 }),
            expect.objectContaining({ name: 'GroundingFailed',  value: 0 }),
        ]));
    });
});

// ─── Structural lint (deterministic, record-mode) tests ──────────────────────

describe('run-pipeline — deterministic structural lint post-QA', () => {
    // Re-uses the single module-level run. The linter is a real (unmocked) pure
    // module, so it runs against the scrubbed mock article and its verdict is
    // folded into pipeline_runs.metadata.lint.

    it('emits a LintChecked metric (the stage ran)', async () => {
        await metaLatch;
        expect(sharedEmittedMetrics).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'LintChecked', value: 1 }),
        ]));
    });

    it('folds the structural-lint verdict into pipeline_runs.metadata.lint', async () => {
        await metaLatch;
        expect(sharedMetadataArg).toHaveProperty('lint');
        const lint = sharedMetadataArg['lint'] as {
            errors: number;
            warnings: number;
            findings: unknown[];
        };
        expect(typeof lint.errors).toBe('number');
        expect(typeof lint.warnings).toBe('number');
        expect(Array.isArray(lint.findings)).toBe(true);
    });

    it('persists exactly the scrubbed content — lint never mutates the body', async () => {
        await metaLatch;
        expect(sharedPersistArgs[2]).toBe(EXPECTED_SCRUBBED_CONTENT);
    });
});

/**
 * Drive a fresh pipeline run with custom @bedrock/shared and pipeline-runs mocks.
 *
 * jest.resetModules() + jest.mock() + require() is the standard pattern for
 * re-executing a module that has side effects at the top level (main() call).
 * We reset after each call to keep the module registry clean for subsequent tests.
 *
 * Defined at module scope (not inside a describe) to avoid S7721: functions
 * should not be defined in a nested scope when they can live at the outer scope.
 */
async function runPipelineWithMocks(opts: {
    verifyImpl: () => Promise<unknown>;
    emitImpl?: () => void;
}): Promise<{ persistArgs: unknown[]; emitCalls: unknown[][] }> {
    let resolveLatch!: (args: unknown[]) => void;
    const latch = new Promise<unknown[]>((res) => { resolveLatch = res; });

    const localPersist = jest.fn<() => Promise<void>>().mockImplementation((...args) => {
        resolveLatch(args);
        return Promise.resolve();
    });
    const localEmitCalls: unknown[][] = [];
    const localEmit = jest.fn<() => void>().mockImplementation((...args) => {
        localEmitCalls.push(args);
        opts.emitImpl?.(...(args as [])); // S4325 false-positive: `args` is unknown[], TS requires the cast to spread into () => void
    });
    const verifyFn = jest.fn<() => Promise<unknown>>().mockImplementation(opts.verifyImpl);

    // Reset and re-register all mocks so the module re-evaluates (runs main()).
    jest.resetModules();
    jest.mock('../lib/pipeline-runs.js', () => ({
        persistArticle:            localPersist,
        updatePipelineRun:         jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        updatePipelineRunMetadata: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    }));
    jest.mock('@bedrock/shared', () => {
        const actual = jest.requireActual<Record<string, unknown>>('@bedrock/shared');
        return {
            ...actual,
            PiiScrubber: jest.fn().mockImplementation(() => ({
                scrub: (text: string) => ({
                    redacted: text.replace(/\S+/g, (w) => (w.includes('@') ? '[EMAIL]' : w)),
                    findings: [],
                }),
            })),
            BedrockGroundingVerifier: jest.fn().mockImplementation(() => ({
                verify: verifyFn,
            })),
            emitEmfMetric: localEmit,
            bootstrapK8sObservability: jest.fn().mockReturnValue({
                logger:   { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
                registry: {},
                shutdown: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
            }),
            pushFinalMetrics: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        };
    });
    jest.mock('../lib/pg.js', () => ({
        getPool:   jest.fn().mockReturnValue({ query: jest.fn() }),
        closePool: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    }));
    jest.mock('../agents/research-agent.js', () => ({
        executeResearchAgent: jest.fn<() => Promise<unknown>>()
            .mockResolvedValue(fakeAgentResult(mockResearchData)),
    }));
    jest.mock('../agents/writer-agent.js', () => ({
        executeWriterAgent: jest.fn<() => Promise<unknown>>()
            .mockResolvedValue(fakeAgentResult(mockWriterData)),
    }));
    jest.mock('../agents/qa-agent.js', () => ({
        executeQaAgent: jest.fn<() => Promise<unknown>>()
            .mockResolvedValue(fakeAgentResult(mockQaData)),
    }));
    jest.mock('prom-client', () => ({
        Counter:   jest.fn().mockImplementation(() => ({ inc: jest.fn() })),
        Histogram: jest.fn().mockImplementation(() => ({ observe: jest.fn() })),
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../run-pipeline.js');

    const persistArgs = await latch;
    return { persistArgs, emitCalls: localEmitCalls };
}

describe('run-pipeline — grounding flag-mode post-QA (NOT_GROUNDED + fail-open)', () => {
    it('runs flag-mode grounding, never blocks, emits GroundingFailed=1 on NOT_GROUNDED', async () => {
        // Capture the arg the pipeline passes to verify() via a shared slot.
        // mockImplementation forwards all runtime args even when the TS type says ()
        // — the captured object is what the Bedrock ConverseCommand would receive.
        let capturedVerifyArg: Record<string, unknown> | undefined;
        const { persistArgs, emitCalls } = await runPipelineWithMocks({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            verifyImpl: ((...args: any[]) => {
                capturedVerifyArg = args[0];
                return Promise.resolve({
                    status: 'NOT_GROUNDED', reason: 'r', ungroundedClaims: ['c'], answer: 'IGNORED_IN_FLAG',
                });
            }),
        });

        // FLAG mode must NEVER alter the persisted content — even when NOT_GROUNDED.
        const persistedContent = persistArgs[2] as string;
        expect(persistedContent).toBe(EXPECTED_SCRUBBED_CONTENT);

        // The grounding verifier must receive the scrubbed content (no raw PII).
        expect(capturedVerifyArg).toBeDefined();
        expect(capturedVerifyArg!.answer).not.toContain(RAW_PII_EMAIL);
        expect(capturedVerifyArg!.answer).toContain('[EMAIL]');
        // The answer passed to verify must equal the same scrubbed string persisted.
        expect(capturedVerifyArg!.answer).toBe(EXPECTED_SCRUBBED_CONTENT);

        // Must emit at least one metric containing GroundingFailed=1.
        const emitted = emitCalls.flatMap(
            // S4325 false-positive: call[2] is unknown; cast is required for .flatMap to type the return
            (call) => call[2] as Array<{ name: string; value: number }>,
        );
        expect(emitted).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'GroundingFailed', value: 1 }),
        ]));
    }, 15_000);

    it('does not hard-fail when the grounding verifier throws (fail-open)', async () => {
        const result = runPipelineWithMocks({
            verifyImpl: () => Promise.reject(new Error('bedrock down')),
        });
        // Pipeline must still resolve (persistArticle is called) — fail-open.
        await expect(result).resolves.toBeDefined();
    }, 15_000);
});

// ─── updatePipelineRunMetadata — metadata merge unit test ────────────────────

describe('updatePipelineRunMetadata — non-destructive JSONB merge', () => {
    it('issues a COALESCE || merge query, not a bare overwrite', async () => {
         
        // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- jest.requireActual<typeof import(...)> needs the module-shape generic
        const { updatePipelineRunMetadata } = jest.requireActual<typeof import('../lib/pipeline-runs.js')>('../lib/pipeline-runs.js');
        const mockQuery = jest.fn<() => Promise<{ rowCount: number }>>().mockResolvedValue({ rowCount: 1 });
        const pool = { query: mockQuery } as unknown as Pool;

        await updatePipelineRunMetadata(pool, 'run-abc', { groundingStatus: 'GROUNDED', score: 1 });

        expect(mockQuery).toHaveBeenCalledTimes(1);
        const [sql, params] = mockQuery.mock.calls[0] as unknown as [string, unknown[]];

        // Assert the SET expression uses COALESCE||merge, not a bare overwrite.
        expect(sql).toContain('COALESCE(metadata');
        expect(sql).toContain('||');
        expect(sql).not.toMatch(/SET metadata\s*=\s*\$2[^:]/); // no bare overwrite

        // Params: [$1 = id, $2 = JSON string of payload]
        expect(params[0]).toBe('run-abc');
        expect(JSON.parse(params[1] as string)).toEqual({ groundingStatus: 'GROUNDED', score: 1 });
    });
});
