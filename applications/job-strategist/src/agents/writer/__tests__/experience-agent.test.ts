/** @format */
jest.mock('@bedrock/shared', () => ({
    ...jest.requireActual('@bedrock/shared'),
    runAgent: jest.fn(),
    log: () => undefined,
}));
import { runAgent } from '@bedrock/shared';
import type { AgentName, StrategistResearchResult } from '@bedrock/shared';
import { executeExperienceAgent } from '../experience-agent.js';
import type { ExperienceMessageInput } from '../experience-message.js';

const mockRun = runAgent as jest.Mock;

const baseResearch = (): StrategistResearchResult => ({
    targetRole: 'Platform Engineer',
    fitSummary: 'Strong alignment on platform engineering fundamentals.',
    overallFitRating: 'REASONABLE FIT',
    verifiedMatches: [],
    partialMatches: [],
    gaps: [],
    companyProblem: '',
} as unknown as StrategistResearchResult);

const baseInput = (): ExperienceMessageInput => ({
    research: baseResearch(),
    roster: [{ company: 'Acme', title: 'Platform Engineer', period: '2020-2024' }],
    careerLines: [{ id: 'c0.h0', roleIndex: 0, text: 'Configured VPC networking and Route53 DNS.' }],
    atsTargets: [],
    groundedMetrics: '',
    codeStack: '',
});

const baseCtx = {
    pipelineId: 'p',
    environment: 'test',
    cumulativeTokens: { input: 0, output: 0, thinking: 0 },
    cumulativeCostUsd: 0,
} as unknown as Parameters<typeof executeExperienceAgent>[0];

const validOutput = () => ({
    roles: [{
        company: 'Acme',
        title: 'Platform Engineer',
        period: '2020-2024',
        highlights: [{ text: 'Configured DNS routing.', sources: ['c0.h0'], atsTargets: [] }],
    }],
    accounting: { dropped: [] },
});

describe('experience agent', () => {
    beforeEach(() => { mockRun.mockReset(); });

    it('sends the tool-forced config (emit_experience, no thinking) and the built user message', async () => {
        mockRun.mockImplementation(async (opts: { parseResponse: (text: string) => unknown }) => ({
            data: opts.parseResponse(JSON.stringify(validOutput())),
        }));

        await executeExperienceAgent(baseCtx, baseInput());

        expect(mockRun).toHaveBeenCalledTimes(1);
        const call = mockRun.mock.calls[0]![0] as {
            userMessage: string;
            config: { agentName: string; tool?: { name: string; description: string }; thinkingBudget: number; modelId: string };
        };
        expect(call.config.agentName).toBe('strategist-experience');
        expect(call.config.tool?.name).toBe('emit_experience');
        expect(call.config.tool?.description.length).toBeGreaterThan(0);
        expect(call.config.thinkingBudget).toBe(0);
        expect(call.config.modelId).not.toMatch(/haiku/i);
        expect(call.userMessage).toContain('c0.h0');
    });

    it('overrides the agent name to strategist-experience-rewrite when opts.agentName is passed', async () => {
        mockRun.mockImplementation(async (opts: { parseResponse: (text: string) => unknown }) => ({
            data: opts.parseResponse(JSON.stringify(validOutput())),
        }));

        await executeExperienceAgent(baseCtx, baseInput(), { agentName: 'strategist-experience-rewrite' as AgentName });

        const call = mockRun.mock.calls[0]![0] as { config: { agentName: string } };
        expect(call.config.agentName).toBe('strategist-experience-rewrite');
    });

    it('parses a valid response via ExperienceAgentOutputSchema (real parseResponse pipeline)', async () => {
        mockRun.mockImplementation(async (opts: { parseResponse: (text: string) => unknown }) => ({
            data: opts.parseResponse(JSON.stringify(validOutput())),
        }));

        const res = await executeExperienceAgent(baseCtx, baseInput());

        expect(res.data.roles).toHaveLength(1);
        expect(res.data.roles[0]!.company).toBe('Acme');
        expect(res.data.roles[0]!.highlights[0]!.sources).toEqual(['c0.h0']);
        expect(res.data.accounting.dropped).toEqual([]);
    });

    it('throws when the response fails ExperienceAgentOutputSchema validation (malformed input)', async () => {
        mockRun.mockImplementation(async (opts: { parseResponse: (text: string) => unknown }) => ({
            data: opts.parseResponse(JSON.stringify({ roles: 'not-an-array' })),
        }));

        await expect(executeExperienceAgent(baseCtx, baseInput())).rejects.toThrow();
    });
});
