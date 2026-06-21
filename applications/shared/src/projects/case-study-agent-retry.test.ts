/** @format */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock the runner so we control success/failure without hitting Bedrock. The
// `mock`-prefixed name is allowed inside the hoisted factory; requireActual keeps
// AgentExecutionError + parseJsonResponse real.
const mockRunAgent = jest.fn<(opts: unknown) => Promise<unknown>>();
jest.mock('../agent-runner.js', () => ({
    ...(jest.requireActual('../agent-runner.js') as object),
    runAgent: mockRunAgent,
}));

import { bedrockCaseStudyAgent, CaseStudySchemaError } from './case-study-agent.js';
import { AgentExecutionError } from '../agent-runner.js';
import type { CaseStudyContext } from './case-study-types.js';
import type { BasePipelineContext } from '../base-agent.js';

const ctx = {
    pipelineId: 'pl', environment: 'development',
    cumulativeTokens: { input: 0, output: 0, thinking: 0 }, cumulativeCostUsd: 0,
} as unknown as BasePipelineContext;

const context: CaseStudyContext = {
    projectId: 'p', projectName: 'P', tagline: null, pitch: null, userOverrides: {},
    components: [], repositories: [], commits: [], pulls: [], kbChunks: [],
};

const okResult = {
    data: { tagline: 't' }, tokenUsage: { inputTokens: 1, outputTokens: 1, thinkingTokens: 0 },
    durationMs: 1, agentName: 'project-case-study', modelId: 'm', costUsd: 0.1,
};

function schemaFail(detail: string): AgentExecutionError {
    // runAgent wraps the parseResponse throw in AgentExecutionError (.cause).
    return new AgentExecutionError('project-case-study', 'pl', new CaseStudySchemaError(detail));
}

describe('bedrockCaseStudyAgent.invoke — bounded schema-repair retry', () => {
    beforeEach(() => { mockRunAgent.mockReset(); });

    it('retries ONCE, feeding the schema detail back, then returns the second result', async () => {
        mockRunAgent
            .mockRejectedValueOnce(schemaFail('[{"path":["architecture"],"message":"Expected object"}]'))
            .mockResolvedValueOnce(okResult);

        const res = await bedrockCaseStudyAgent.invoke(context, ctx);

        expect(mockRunAgent).toHaveBeenCalledTimes(2);
        const secondMsg = (mockRunAgent.mock.calls[1]![0] as { userMessage: string }).userMessage;
        expect(secondMsg).toContain('FAILED schema validation');   // error fed back
        expect(secondMsg).toContain('architecture');               // the specific violation
        expect(res).toBe(okResult);
    });

    it('does NOT retry a non-schema error — propagates after a single call', async () => {
        mockRunAgent.mockRejectedValueOnce(new Error('bedrock 500'));

        await expect(bedrockCaseStudyAgent.invoke(context, ctx)).rejects.toThrow('bedrock 500');
        expect(mockRunAgent).toHaveBeenCalledTimes(1);             // no retry on infra errors
    });

    it('is bounded — a second schema failure propagates, no third attempt', async () => {
        mockRunAgent.mockRejectedValue(schemaFail('[]'));

        await expect(bedrockCaseStudyAgent.invoke(context, ctx)).rejects.toBeDefined();
        expect(mockRunAgent).toHaveBeenCalledTimes(2);             // original + exactly one retry
    });
});
