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

import { coachAgent, CoachAgent, coachToolForStage } from './coach-agent';
import type { CoachAgentInput } from './coach-agent';
import type { StrategistPipelineContext, StrategistAnalysisResult } from '@bedrock/shared';

class TestableCoach extends CoachAgent {
    public parse(text: string, ctx: StrategistPipelineContext) {
        return this.parseResponse(text, {} as CoachAgentInput, ctx);
    }
    public buildMsg(input: CoachAgentInput, ctx: StrategistPipelineContext) {
        return this.buildUserMessage(input, ctx);
    }
}

const PARSE_CTX = { interviewStage: 'phone-screen' } as unknown as StrategistPipelineContext;

const BASE_PAYLOAD = {
    stageDescription: 'd', technicalQuestions: [], behaviouralQuestions: [],
    difficultQuestions: [], technicalPrepChecklist: [], questionsToAsk: [], coachingNotes: 'n',
};

describe('CoachAgent.parseResponse', () => {
    it('accepts a payload WITHOUT the optional phone-screen fields', () => {
        const r = new TestableCoach().parse(JSON.stringify(BASE_PAYLOAD), PARSE_CTX);
        expect(r.stage).toBe('phone-screen');
        expect(r.careerArcSummary).toBeUndefined();
    });
    it('accepts a payload WITH the phone-screen fields', () => {
        const payload = {
            ...BASE_PAYLOAD,
            careerArcSummary: 'Career arc...',
            jdTalkingPoints: [{ point: 'p', evidence: 'e' }],
            compScript: { targetEcho: 't', marketContext: null, deflectTemplate: 'd' },
        };
        const r = new TestableCoach().parse(JSON.stringify(payload), PARSE_CTX);
        expect(r.careerArcSummary).toBe('Career arc...');
        expect(r.jdTalkingPoints?.[0]).toEqual({ point: 'p', evidence: 'e', matchedSkills: [] });
        expect(r.compScript?.marketContext).toBeNull();
    });
});

const STUB_ANALYSIS = {
    analysisXml: 'x',
    metadata: { overallFitRating: 'STRONG FIT', applicationRecommendation: 'APPLY' },
} as any as StrategistAnalysisResult;

const STUB_CTX = {
    interviewStage: 'phone-screen',
    targetRole: 'R',
    targetCompany: 'C',
} as any as StrategistPipelineContext;

describe('buildCoachMessage — evidenceBlock injection', () => {
    it('includes Verified Evidence section when evidenceBlock is provided', () => {
        const msg = new TestableCoach().buildMsg(
            { analysis: STUB_ANALYSIS, evidenceBlock: 'V' },
            STUB_CTX,
        );
        expect(msg).toContain('## Verified Evidence (from Research)');
        expect(msg).toContain('V');
    });

    it('omits Verified Evidence section when evidenceBlock is absent', () => {
        const msg = new TestableCoach().buildMsg(
            { analysis: STUB_ANALYSIS },
            STUB_CTX,
        );
        expect(msg).not.toContain('Verified Evidence');
    });
});

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
    coachingNotes: {
        positioning: 'Lead with the operator project.',
        interviewFocus: [{ label: 'Coding', detail: 'A DS&A problem with complexity analysis.' }],
        tacticalPrep: 'Revise etcd internals.',
        finalCheckpoint: { items: ['Confirm the format and timing', 'Prepare two questions'], note: 'You are ready.' },
    },
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
        expect(result.data.coachingNotes.positioning).toContain('operator');
        expect(result.data.coachingNotes.interviewFocus?.[0].label).toBe('Coding');
        expect(result.data.coachingNotes.finalCheckpoint?.items).toHaveLength(2);
        expect(result.data.coachingNotes.finalCheckpoint?.note).toContain('ready');
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

describe('coachToolForStage — phone-screen required fields', () => {
    it('requires the phone-screen fields for phone-screen', () => {
        const required = coachToolForStage('phone-screen').inputSchema.required;
        expect(required).toEqual(expect.arrayContaining(['careerArcSummary', 'jdTalkingPoints', 'compScript']));
    });
    it('does NOT require phone-screen fields for other stages', () => {
        const required = coachToolForStage('technical-1').inputSchema.required as string[];
        expect(required).not.toContain('careerArcSummary');
        expect(required).not.toContain('jdTalkingPoints');
        expect(required).not.toContain('compScript');
    });
    it('forced toolConfig for phone-screen carries the required fields', async () => {
        const { ConverseCommand } = jest.requireMock('@aws-sdk/client-bedrock-runtime') as { ConverseCommand: jest.Mock };
        ConverseCommand.mockClear();
        mockSend.mockResolvedValueOnce(toolUseReply({
            ...VALID_COACH_INPUT,
            careerArcSummary: 'arc', jdTalkingPoints: [{ point: 'p', evidence: 'e' }],
            compScript: { targetEcho: 't', marketContext: null, deflectTemplate: 'd' },
        }));
        await coachAgent.execute({ analysis: ANALYSIS }, { ...CTX, interviewStage: 'phone-screen' } as any);
        const sent = ConverseCommand.mock.calls.at(-1)?.[0] as any;
        expect(sent.toolConfig.tools[0].toolSpec.inputSchema.json.required)
            .toEqual(expect.arrayContaining(['careerArcSummary', 'jdTalkingPoints', 'compScript']));
    });
});

import { buildSkillCandidateBlock } from './coach-agent.js';

describe('buildSkillCandidateBlock', () => {
    it('lists candidate ids per skill and a gap note for empties', () => {
        const block = buildSkillCandidateBlock([
            { jdSkill: 'Kubernetes', candidates: [{ projectId: 'p1', projectName: 'AI Apps', source: 'component', tier: 'demonstrated', id: 'c1', label: 'EKS' }] },
            { jdSkill: 'Kafka', candidates: [] },
        ]);
        expect(block).toContain('id=c1');
        expect(block).toContain('Kafka: (no project evidence → tier=gap)');
        expect(block).toContain('cite ONLY these ids');
    });
    it('returns empty string for no sets', () => {
        expect(buildSkillCandidateBlock([])).toBe('');
    });
});
