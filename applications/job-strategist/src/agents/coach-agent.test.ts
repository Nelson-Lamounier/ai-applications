/**
 * @format
 * Interview Coach Agent — forced tool_use + schema validation tests.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
    BedrockRuntimeClient: jest.fn(() => ({ send: mockSend })),
    ConverseCommand: jest.fn((params: unknown) => ({ input: params })),
}));

import { coachAgent } from './coach-agent';
import type { StrategistPipelineContext, StrategistAnalysisResult } from '@bedrock/shared';

const VALID_COACH_INPUT = {
    stageDescription: 'Technical screen focused on systems.',
    technicalQuestions: [{
        question: 'Explain your K8s operator.',
        answerFramework: 'STAR using portfolio/self-healing.',
        sourceProject: 'self-healing',
        difficulty: 'medium',
        keyPoints: ['controller pattern', 'drift remediation'],
    }],
    behaviouralQuestions: [{
        question: 'Tell me about a conflict.',
        answerFramework: 'STAR.',
        sourceProject: 'team-lead',
        difficulty: 'easy',
        keyPoints: ['ownership'],
    }],
    difficultQuestions: [{
        question: 'Why the CDK->Terraform gap?',
        answerFramework: 'Honest bridge.',
        bridgeStrategy: 'IaC fundamentals transfer.',
    }],
    technicalPrepChecklist: [{
        topic: 'etcd internals',
        priority: 'high',
        rationale: 'likely probed',
        suggestedResources: ['etcd docs'],
    }],
    questionsToAsk: [{ question: 'Team on-call model?', rationale: 'shows ops maturity' }],
    coachingNotes: 'Lead with the operator project.',
};

const ANALYSIS = {
    analysisXml: '<analysis>...</analysis>',
    metadata: { overallFitRating: 'STRONG', applicationRecommendation: 'APPLY' },
} as unknown as StrategistAnalysisResult;

const CTX = {
    pipelineId: 'p1',
    operation: 'coach',
    applicationSlug: 'acme-sre',
    targetCompany: 'Acme',
    targetRole: 'SRE',
    interviewStage: 'technical-1',
    environment: 'development',
    cumulativeTokens: { input: 0, output: 0, thinking: 0 },
    cumulativeCostUsd: 0,
} as unknown as StrategistPipelineContext;

function toolUseReply(input: unknown) {
    return {
        output: { message: { content: [{ toolUse: { toolUseId: 't', name: 'emit_interview_coaching', input } }] } },
        usage: { inputTokens: 100, outputTokens: 80 },
        stopReason: 'tool_use',
    };
}

describe('CoachAgent (forced tool_use)', () => {
    beforeEach(() => mockSend.mockReset());

    it('returns a validated coaching result with stage injected from context', async () => {
        mockSend.mockResolvedValueOnce(toolUseReply(VALID_COACH_INPUT));

        const result = await coachAgent.execute({ analysis: ANALYSIS }, CTX);

        expect(result.data.stage).toBe('technical-1');
        expect(result.data.technicalQuestions).toHaveLength(1);
        expect(result.data.coachingNotes).toContain('operator');
    });

    it('sends a forced toolConfig and disables extended thinking', async () => {
        const { ConverseCommand } = jest.requireMock('@aws-sdk/client-bedrock-runtime') as { ConverseCommand: jest.Mock };
        ConverseCommand.mockClear();
        mockSend.mockResolvedValueOnce(toolUseReply(VALID_COACH_INPUT));

        await coachAgent.execute({ analysis: ANALYSIS }, CTX);

        const sent = ConverseCommand.mock.calls.at(-1)?.[0] as any;
        expect(sent.toolConfig.toolChoice).toEqual({ tool: { name: 'emit_interview_coaching' } });
        expect(sent.toolConfig.tools[0].toolSpec.inputSchema.json.additionalProperties).toBe(false);
        expect(sent.additionalModelRequestFields).toBeUndefined();
    });

    it('fails fast when the tool input violates the schema', async () => {
        mockSend.mockResolvedValueOnce(toolUseReply({ ...VALID_COACH_INPUT, technicalQuestions: 'not-an-array' }));
        await expect(coachAgent.execute({ analysis: ANALYSIS }, CTX)).rejects.toThrow();
    });

    it('fails fast when the model injects an unknown field', async () => {
        mockSend.mockResolvedValueOnce(toolUseReply({ ...VALID_COACH_INPUT, injected: 'nope' }));
        await expect(coachAgent.execute({ analysis: ANALYSIS }, CTX)).rejects.toThrow();
    });
});
