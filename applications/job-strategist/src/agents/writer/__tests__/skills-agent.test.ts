/** @format */
jest.mock('@bedrock/shared', () => ({
    ...jest.requireActual('@bedrock/shared'),
    runAgent: jest.fn(),
    log: () => undefined,
}));
import { runAgent } from '@bedrock/shared';
import { executeSkillsAgent } from '../skills-agent.js';
import type { SkillsMessageInput } from '../skills-message.js';

const mockRun = runAgent as jest.Mock;

const baseInput = (): SkillsMessageInput => ({
    jd: {
        targetRole: 'Technical Services Engineer',
        requiredSkills: ['Kubernetes'],
        preferredSkills: [],
        technologyInventory: { languages: [], frameworks: [], infrastructure: ['Kubernetes'], tools: [], methodologies: [] },
    } as never,
    verifiedMatches: [{ skill: 'Kubernetes', sourceCitation: 'infra/k8s.ts', depth: 'expert', recency: 'current', evidenceFiles: ['infra/k8s.ts'] }] as never,
    partialMatches: [] as never,
});

const baseCtx = {
    pipelineId: 'p',
    environment: 'test',
    cumulativeTokens: { input: 0, output: 0, thinking: 0 },
    cumulativeCostUsd: 0,
} as unknown as Parameters<typeof executeSkillsAgent>[0];

const validOutput = () => ({
    skills: [{ category: 'Infrastructure', skills: ['Kubernetes'] }],
});

describe('skills agent', () => {
    beforeEach(() => { mockRun.mockReset(); });

    it('sends the tool-forced config (emit_skills, no thinking, maxTokens 1500) and the built user message', async () => {
        mockRun.mockImplementation(async (opts: { parseResponse: (text: string) => unknown }) => ({
            data: opts.parseResponse(JSON.stringify(validOutput())),
        }));

        await executeSkillsAgent(baseCtx, baseInput());

        expect(mockRun).toHaveBeenCalledTimes(1);
        const call = mockRun.mock.calls[0]![0] as {
            userMessage: string;
            config: { agentName: string; tool?: { name: string; description: string }; thinkingBudget: number; maxTokens: number; modelId: string };
        };
        expect(call.config.agentName).toBe('strategist-skills');
        expect(call.config.tool?.name).toBe('emit_skills');
        expect(call.config.tool?.description.length).toBeGreaterThan(0);
        expect(call.config.thinkingBudget).toBe(0);
        expect(call.config.maxTokens).toBe(1500);
        expect(call.config.modelId).not.toMatch(/haiku/i);
        expect(call.userMessage).toContain('Kubernetes');
    });

    it('overrides the agent name when opts.agentName is passed', async () => {
        mockRun.mockImplementation(async (opts: { parseResponse: (text: string) => unknown }) => ({
            data: opts.parseResponse(JSON.stringify(validOutput())),
        }));

        await executeSkillsAgent(baseCtx, baseInput(), { agentName: 'strategist-skills-rewrite' as never });

        const call = mockRun.mock.calls[0]![0] as { config: { agentName: string } };
        expect(call.config.agentName).toBe('strategist-skills-rewrite');
    });

    it('parses a valid response via SkillsAgentOutputSchema (real parseResponse pipeline)', async () => {
        mockRun.mockImplementation(async (opts: { parseResponse: (text: string) => unknown }) => ({
            data: opts.parseResponse(JSON.stringify(validOutput())),
        }));

        const res = await executeSkillsAgent(baseCtx, baseInput());

        expect(res.data.skills).toHaveLength(1);
        expect(res.data.skills[0]!.category).toBe('Infrastructure');
        expect(res.data.skills[0]!.skills).toEqual(['Kubernetes']);
    });

    it('throws when the response fails SkillsAgentOutputSchema validation (malformed input)', async () => {
        mockRun.mockImplementation(async (opts: { parseResponse: (text: string) => unknown }) => ({
            data: opts.parseResponse(JSON.stringify({ skills: 'nope' })),
        }));

        await expect(executeSkillsAgent(baseCtx, baseInput())).rejects.toThrow();
    });
});
