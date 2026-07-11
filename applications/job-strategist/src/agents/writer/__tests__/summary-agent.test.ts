/** @format */
jest.mock('@bedrock/shared', () => ({
    ...jest.requireActual('@bedrock/shared'),
    runAgent: jest.fn(),
    log: () => undefined,
}));
import { runAgent } from '@bedrock/shared';
import type { StrategistResearchResult, StructuredResumeData } from '@bedrock/shared';
import { executeSummaryAgent } from '../summary-agent.js';
import type { SummaryMessageInput } from '../summary-message.js';

const mockRun = runAgent as jest.Mock;

const baseResearch = (): StrategistResearchResult => ({
    fitSummary: 'Strong alignment on platform engineering fundamentals.',
    overallFitRating: 'REASONABLE FIT',
    verifiedMatches: [],
    partialMatches: [],
    gaps: [],
    companyProblem: '',
} as unknown as StrategistResearchResult);

const baseBody = (): StructuredResumeData => ({
    profile: { name: 'Nelson', title: 'Platform Engineer', email: 'n@x.com', location: 'Dublin' },
    summary: '',
    experience: [],
    skills: [],
    education: [],
    certifications: [],
    projects: [],
    keyAchievements: [],
});

const baseInput = (): SummaryMessageInput => ({
    research: baseResearch(),
    body: baseBody(),
    profileIntelligence: '',
    yearsGapFraming: '',
    achievementEvidence: '',
});

const baseCtx = {
    pipelineId: 'p',
    environment: 'test',
    cumulativeTokens: { input: 0, output: 0, thinking: 0 },
    cumulativeCostUsd: 0,
} as unknown as Parameters<typeof executeSummaryAgent>[0];

describe('summary agent', () => {
    beforeEach(() => { mockRun.mockReset(); });

    it('assembles beats into a summary string via the real parseResponse pipeline', async () => {
        // Drive runAgent's `parseResponse` directly (the real one, imported by
        // summary-agent.ts) so this exercises SummaryBeatsSchema.parse +
        // assembleSummary — not a hand-rolled test double.
        mockRun.mockImplementation(async (opts: { parseResponse: (text: string) => unknown }) => ({
            data: opts.parseResponse(JSON.stringify({ s1: 'A.', s2: 'B.', s3: 'C.', s4: 'D.' })),
        }));

        const res = await executeSummaryAgent(baseCtx, baseInput());

        expect(res.data.summary).toBe('A. B. C. D.');
        expect(res.data.beats.s1).toBe('A.');
        expect(res.data.beats.s2).toBe('B.');
        expect(res.data.beats.s3).toBe('C.');
        expect(res.data.beats.s4).toBe('D.');
    });

    it('sends the tool-forced config (emit_summary, no thinking) and the built user message', async () => {
        mockRun.mockImplementation(async (opts: { parseResponse: (text: string) => unknown }) => ({
            data: opts.parseResponse(JSON.stringify({ s1: 'A.', s2: 'B.', s3: 'C.', s4: 'D.' })),
        }));

        await executeSummaryAgent(baseCtx, baseInput());

        expect(mockRun).toHaveBeenCalledTimes(1);
        const call = mockRun.mock.calls[0]![0] as {
            userMessage: string;
            config: { tool?: { name: string; description: string }; thinkingBudget: number; modelId: string };
        };
        expect(call.config.tool?.name).toBe('emit_summary');
        expect(call.config.tool?.description.length).toBeGreaterThan(0);
        expect(call.config.thinkingBudget).toBe(0);
        expect(call.config.modelId).not.toMatch(/haiku/i);
        expect(call.userMessage).toContain('Strong alignment on platform engineering fundamentals.');
    });

    it('propagates a schema-validation failure when a beat is missing', async () => {
        mockRun.mockImplementation(async (opts: { parseResponse: (text: string) => unknown }) => ({
            data: opts.parseResponse(JSON.stringify({ s1: 'A.', s2: 'B.', s3: 'C.' })),
        }));

        await expect(executeSummaryAgent(baseCtx, baseInput())).rejects.toThrow();
    });
});
