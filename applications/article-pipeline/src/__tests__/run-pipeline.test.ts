import { describe, it, expect, jest, beforeAll } from '@jest/globals';

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

jest.mock('../lib/pipeline-runs.js', () => ({
    persistArticle:    mockPersistArticle,
    updatePipelineRun: mockUpdatePipelineRun,
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
const mockWriterData = {
    content:        `# My Article\n\nContact ${RAW_PII_EMAIL} for more info.\n`,
    title:          'My Article',
    tags:           [],
    tldr:           '',
    description:    '',
    heroImage:      '',
    seoTitle:       '',
    seoDescription: '',
    readingTime:    1,
    complexity:     { tier: 'LOW', budgetTokens: 2048, reason: '', signals: {} },
    suggestions:    [],
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

const mockQaData = {
    overallScore:   85,
    recommendation: 'PASS',
    issues:         [],
    suggestions:    [],
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

// Observability stubs — avoid real Prometheus setup in tests.
jest.mock('@bedrock/shared', () => {
    const actual = jest.requireActual<Record<string, unknown>>('@bedrock/shared');
    return {
        ...actual,
        PiiScrubber: jest.fn().mockImplementation(() => ({
            scrub: (text: string) => ({
                // Minimal scrub: replace email patterns with [EMAIL]
                redacted: text.replace(
                    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
                    '[EMAIL]',
                ),
                findings: [],
            }),
        })),
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
    QA_MODEL:        'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('run-pipeline — MDX-persist PII scrub', () => {
    let persistArgs: unknown[];

    // Dynamically import run-pipeline, which triggers main().
    // We await the persistLatch promise so the tests run only after
    // persistArticle has been called.
    beforeAll(async () => {
        await import('../run-pipeline.js');
        persistArgs = await persistLatch;
    }, 10_000);

    it('calls persistArticle with redacted MDX — raw PII email is absent', () => {
        const contentArg = persistArgs[2] as string;
        expect(contentArg).not.toContain(RAW_PII_EMAIL);
    });

    it('calls persistArticle with redacted MDX — [EMAIL] token is present', () => {
        const contentArg = persistArgs[2] as string;
        expect(contentArg).toContain('[EMAIL]');
    });
});
