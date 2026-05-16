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
const mockS3Send = jest.fn<() => Promise<unknown>>();
jest.mock('@aws-sdk/client-s3', () => ({
    S3Client:        jest.fn().mockImplementation(() => ({ send: mockS3Send })),
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
        mockRetrieve.mockReset();
        mockRetrieve.mockResolvedValue([]);
        MockPgVectorRetriever.mockClear();
        MockTitanEmbeddingProvider.mockClear();
        mockS3Send.mockClear();
    });

    // Mock S3 read so executeResearchAgent can progress past the draft read
    beforeEach(() => {
        mockS3Send.mockResolvedValue({
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

        let passageTextFound = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (runAgent as any).mockImplementationOnce(async (opts: { userMessage?: string }) => {
            passageTextFound = opts.userMessage?.includes(retrievedPassage.text) ?? false;
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
                tokenUsage: { input: 0, output: 0, thinking: 0 },
                durationMs: 0,
                agentName: 'research',
                modelId: 'test',
                costUsd: 0,
            };
        });

        await executeResearchAgent(makeCtx(), fakePool);
        expect(passageTextFound).toBe(true);
    });

    it('throws if RESEARCH_RETRIEVAL_SOURCE=pgvector but ctx.userId is absent', async () => {
        process.env['RESEARCH_RETRIEVAL_SOURCE'] = 'pgvector';
        const ctxWithoutUserId = makeCtx({ userId: undefined });
        await expect(executeResearchAgent(ctxWithoutUserId, fakePool))
            .rejects.toThrow('userId');
    });

    it('redacts PII from the author draft before KB query and Bedrock', async () => {
        process.env['RESEARCH_RETRIEVAL_SOURCE'] = 'pgvector';

        const piiDraft = 'Draft by author@example.com about serverless. Phone 415-555-2671.';

        // Override S3 mock to return PII-containing draft
        mockS3Send.mockResolvedValueOnce({
            Body: {
                transformToString: jest.fn<() => Promise<string>>().mockResolvedValue(piiDraft),
            },
        });

        const { runAgent } = jest.requireMock<{
            runAgent: jest.MockedFunction<typeof import('@bedrock/shared').runAgent>;
        }>('@bedrock/shared');

        let capturedUserMessage = '';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (runAgent as any).mockImplementationOnce(async (opts: { userMessage?: string }) => {
            capturedUserMessage = opts.userMessage ?? '';
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
                tokenUsage: { input: 0, output: 0, thinking: 0 },
                durationMs: 0,
                agentName: 'research',
                modelId: 'test',
                costUsd: 0,
            };
        });

        // pgvector retrieve args are captured via mockRetrieve
        mockRetrieve.mockResolvedValueOnce([]);

        await executeResearchAgent(makeCtx(), fakePool);

        // The user message passed to Bedrock must not contain raw PII
        expect(capturedUserMessage).not.toContain('author@example.com');
        expect(capturedUserMessage).not.toContain('415-555-2671');
        expect(capturedUserMessage).toContain('[EMAIL]');

        // The KB query (retrieve first arg) must not contain raw PII
        const queryArgs = mockRetrieve.mock.calls[0] as unknown[];
        const queryString = (queryArgs ?? []).join(' ');
        expect(queryString).not.toContain('author@example.com');
    });
});
