/** @format */
jest.mock('@bedrock/shared', () => ({
    ...jest.requireActual('@bedrock/shared'),
    runAgent: jest.fn(),
    log: () => undefined,
}));
import { runAgent } from '@bedrock/shared';
import type { AgentName } from '@bedrock/shared';
import { executeProjectsAgent } from '../projects-agent.js';
import type { ProjectsMessageInput } from '../projects-message.js';

const mockRun = runAgent as jest.Mock;

const baseInput = (): ProjectsMessageInput => ({
    pool: [
        {
            index: 0,
            name: 'Tucaken',
            pitch: 'AI-driven career platform',
            repoUrls: ['github.com/o/tucaken-app'],
            curated: [{ id: 'p0.b0', text: 'Shipped RLS-scoped multi-tenant Postgres schema' }],
            repoCurrent: [{ id: 'p0.r0', skill: 'DNS', sourceCitation: 'o/tucaken-app/infra/dns.ts', repositoryId: 'r1', githubRepoId: 1, fullName: 'o/tucaken-app' }],
        },
    ],
    atsTargets: [],
    targetRole: 'Technical Services Engineer',
});

const baseCtx = {
    pipelineId: 'p',
    environment: 'test',
    cumulativeTokens: { input: 0, output: 0, thinking: 0 },
    cumulativeCostUsd: 0,
} as unknown as Parameters<typeof executeProjectsAgent>[0];

const validOutput = () => ({
    entries: [{
        name: 'Tucaken',
        github: 'github.com/o/tucaken-app',
        description: 'AI-driven career platform for job seekers.',
        highlights: [{ bulletId: 'p0.b0' }],
    }],
});

describe('projects agent', () => {
    beforeEach(() => { mockRun.mockReset(); });

    it('sends the tool-forced config (emit_projects, no thinking) and the built user message', async () => {
        mockRun.mockImplementation(async (opts: { parseResponse: (text: string) => unknown }) => ({
            data: opts.parseResponse(JSON.stringify(validOutput())),
        }));

        await executeProjectsAgent(baseCtx, baseInput());

        expect(mockRun).toHaveBeenCalledTimes(1);
        const call = mockRun.mock.calls[0]![0] as {
            userMessage: string;
            config: { agentName: string; tool?: { name: string; description: string }; thinkingBudget: number; modelId: string };
        };
        expect(call.config.agentName).toBe('strategist-projects');
        expect(call.config.tool?.name).toBe('emit_projects');
        expect(call.config.tool?.description.length).toBeGreaterThan(0);
        expect(call.config.thinkingBudget).toBe(0);
        expect(call.config.modelId).not.toMatch(/haiku/i);
        expect(call.userMessage).toContain('p0.b0');
    });

    it('overrides the agent name to strategist-projects-rewrite when opts.agentName is passed', async () => {
        mockRun.mockImplementation(async (opts: { parseResponse: (text: string) => unknown }) => ({
            data: opts.parseResponse(JSON.stringify(validOutput())),
        }));

        await executeProjectsAgent(baseCtx, baseInput(), { agentName: 'strategist-projects-rewrite' as AgentName /* Task 6 adds these to the union */ });

        const call = mockRun.mock.calls[0]![0] as { config: { agentName: string } };
        expect(call.config.agentName).toBe('strategist-projects-rewrite');
    });

    it('parses a valid response via ProjectsAgentOutputSchema (real parseResponse pipeline)', async () => {
        mockRun.mockImplementation(async (opts: { parseResponse: (text: string) => unknown }) => ({
            data: opts.parseResponse(JSON.stringify(validOutput())),
        }));

        const res = await executeProjectsAgent(baseCtx, baseInput());

        expect(res.data.entries).toHaveLength(1);
        expect(res.data.entries[0]!.name).toBe('Tucaken');
        expect(res.data.entries[0]!.highlights).toEqual([{ bulletId: 'p0.b0' }]);
    });

    it('throws when the response fails ProjectsAgentOutputSchema validation (malformed input)', async () => {
        mockRun.mockImplementation(async (opts: { parseResponse: (text: string) => unknown }) => ({
            data: opts.parseResponse(JSON.stringify({ entries: 'nope' })),
        }));

        await expect(executeProjectsAgent(baseCtx, baseInput())).rejects.toThrow();
    });
});
