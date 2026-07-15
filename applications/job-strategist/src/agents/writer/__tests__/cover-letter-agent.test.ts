/** @format */
jest.mock('@bedrock/shared', () => ({
    ...jest.requireActual('@bedrock/shared'),
    runAgent: jest.fn(),
    log: () => undefined,
}));
import { runAgent } from '@bedrock/shared';
import { executeCoverLetterAgent } from '../cover-letter-agent.js';
import type { CoverLetterMessageInput } from '../cover-letter-message.js';

const mockRun = runAgent as jest.Mock;

const baseInput = (): CoverLetterMessageInput => ({
    targetRole: 'Technical Services Engineer',
    targetCompany: 'Acme Corp',
});

const baseCtx = {
    pipelineId: 'p',
    environment: 'test',
    cumulativeTokens: { input: 0, output: 0, thinking: 0 },
    cumulativeCostUsd: 0,
} as unknown as Parameters<typeof executeCoverLetterAgent>[0];

const validOutput = () => ({
    greeting: 'Dear Hiring Manager,',
    paragraphs: ['P1.', 'P2.', 'P3.'],
    signoff: { name: 'Nelson', email: 'n@x.com', linkedin: 'linkedin/n', github: 'github/n' },
});

describe('cover letter agent', () => {
    beforeEach(() => { mockRun.mockReset(); });

    it('sends the tool-forced config (emit_cover_letter, no thinking, maxTokens 1500) and the built user message', async () => {
        mockRun.mockImplementation(async (opts: { parseResponse: (text: string) => unknown }) => ({
            data: opts.parseResponse(JSON.stringify(validOutput())),
        }));

        await executeCoverLetterAgent(baseCtx, baseInput());

        expect(mockRun).toHaveBeenCalledTimes(1);
        const call = mockRun.mock.calls[0]![0] as {
            userMessage: string;
            config: { agentName: string; tool?: { name: string; description: string; inputSchema: unknown }; thinkingBudget: number; maxTokens: number; modelId: string };
        };
        expect(call.config.agentName).toBe('strategist-cover-letter');
        expect(call.config.tool?.name).toBe('emit_cover_letter');
        expect(call.config.tool?.description.length).toBeGreaterThan(0);
        expect(call.config.thinkingBudget).toBe(0);
        expect(call.config.maxTokens).toBe(1500);
        expect(call.config.modelId).not.toMatch(/haiku/i);
        expect(call.userMessage).toContain('Technical Services Engineer');
    });

    it('mirrors CoverLetterSchema in the forced tool input schema -- greeting/paragraphs/signoff all required, signoff fields required', async () => {
        mockRun.mockImplementation(async (opts: { parseResponse: (text: string) => unknown }) => ({
            data: opts.parseResponse(JSON.stringify(validOutput())),
        }));

        await executeCoverLetterAgent(baseCtx, baseInput());

        const call = mockRun.mock.calls[0]![0] as { config: { tool?: { inputSchema: { required?: string[]; properties?: Record<string, { required?: string[] }> } } } };
        const schema = call.config.tool!.inputSchema;
        expect(schema.required).toEqual(expect.arrayContaining(['greeting', 'paragraphs', 'signoff']));
        expect(schema.properties!['signoff']!.required).toEqual(expect.arrayContaining(['name', 'email', 'linkedin', 'github']));
    });

    it('parses a valid response via CoverLetterSchema (real parseResponse pipeline)', async () => {
        mockRun.mockImplementation(async (opts: { parseResponse: (text: string) => unknown }) => ({
            data: opts.parseResponse(JSON.stringify(validOutput())),
        }));

        const res = await executeCoverLetterAgent(baseCtx, baseInput());

        expect(res.data.greeting).toBe('Dear Hiring Manager,');
        expect(res.data.paragraphs).toEqual(['P1.', 'P2.', 'P3.']);
        expect(res.data.signoff.name).toBe('Nelson');
    });

    it('throws when the response fails CoverLetterSchema validation (malformed input)', async () => {
        mockRun.mockImplementation(async (opts: { parseResponse: (text: string) => unknown }) => ({
            data: opts.parseResponse(JSON.stringify({ greeting: 1 })),
        }));

        await expect(executeCoverLetterAgent(baseCtx, baseInput())).rejects.toThrow();
    });
});
