/**
 * @format
 * QA Agent — forced tool_use + schema validation tests.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
    BedrockRuntimeClient: jest.fn(() => ({ send: mockSend })),
    ConverseCommand: jest.fn((params: unknown) => ({ input: params })),
}));

import { qaAgent } from './qa-agent';
import type { PipelineContext, WriterResult } from '@bedrock/shared';

const DIM = { score: 90, issues: [] };
const VALID_QA = {
    overallScore: 88,
    recommendation: 'publish',
    dimensions: {
        technicalAccuracy: DIM,
        seoCompliance: DIM,
        mdxStructure: DIM,
        metadataQuality: DIM,
        contentQuality: { score: 70, issues: [{ severity: 'warning', location: 'intro', description: 'thin', fix: 'expand' }] },
    },
    summary: 'Solid article, minor intro tweak.',
    confidenceOverride: 85,
};

const WRITER = {
    content: '# Title\nbody',
    metadata: {
        title: 'T', slug: 's', tags: ['a'], readingTime: 5, description: 'd',
        aiSummary: 'x', technicalConfidence: 80, category: 'c', skillsDemonstrated: ['k'],
    },
    shotList: [],
} as unknown as WriterResult;

const CTX = {
    pipelineId: 'p1', slug: 'a', sourceKey: 'k', bucket: 'b', environment: 'development',
    cumulativeTokens: { input: 0, output: 0, thinking: 0 }, cumulativeCostUsd: 0,
    retryAttempt: 0, version: 0, startedAt: new Date().toISOString(),
} as unknown as PipelineContext;

function toolUseReply(input: unknown) {
    return {
        output: { message: { content: [{ toolUse: { toolUseId: 't', name: 'emit_qa_result', input } }] } },
        usage: { inputTokens: 100, outputTokens: 80 },
        stopReason: 'tool_use',
    };
}

describe('QaAgent (forced tool_use)', () => {
    beforeEach(() => mockSend.mockReset());

    it('returns a validated QA result and clamps scores', async () => {
        mockSend.mockResolvedValueOnce(toolUseReply({ ...VALID_QA, overallScore: 130 }));
        const result = await qaAgent.execute({ writer: WRITER, technicalFacts: [], mode: 'kb' }, CTX);
        expect(result.data.overallScore).toBe(100); // clamped
        expect(result.data.recommendation).toBe('publish');
        expect(result.data.dimensions.contentQuality.issues).toHaveLength(1);
    });

    it('sends a forced toolConfig and disables extended thinking', async () => {
        const { ConverseCommand } = jest.requireMock('@aws-sdk/client-bedrock-runtime') as { ConverseCommand: jest.Mock };
        ConverseCommand.mockClear();
        mockSend.mockResolvedValueOnce(toolUseReply(VALID_QA));
        await qaAgent.execute({ writer: WRITER, technicalFacts: [], mode: 'kb' }, CTX);
        const sent = ConverseCommand.mock.calls.at(-1)?.[0] as any;
        expect(sent.toolConfig.toolChoice).toEqual({ tool: { name: 'emit_qa_result' } });
        expect(sent.toolConfig.tools[0].toolSpec.inputSchema.json.additionalProperties).toBe(false);
        expect(sent.additionalModelRequestFields).toBeUndefined();
    });

    it('fails fast on an invalid recommendation enum', async () => {
        mockSend.mockResolvedValueOnce(toolUseReply({ ...VALID_QA, recommendation: 'maybe' }));
        await expect(qaAgent.execute({ writer: WRITER, technicalFacts: [], mode: 'kb' }, CTX)).rejects.toThrow();
    });

    it('fails fast when the model injects an unknown field', async () => {
        mockSend.mockResolvedValueOnce(toolUseReply({ ...VALID_QA, injected: 'nope' }));
        await expect(qaAgent.execute({ writer: WRITER, technicalFacts: [], mode: 'kb' }, CTX)).rejects.toThrow();
    });
});
