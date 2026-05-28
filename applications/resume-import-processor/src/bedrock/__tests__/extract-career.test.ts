import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// extractCareerData now goes through the shared runAgent() wrapper. Override
// only runAgent (keep the real PiiScrubber so redaction is genuinely tested).
// The mock runs the agent's parseResponse over a configurable tool input so
// schema validation is still exercised, and records the userMessage so the
// PII-redaction assertion can inspect what would have been sent to Bedrock.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let toolInput: any = {};
let tokenUsage = { inputTokens: 1200, outputTokens: 300, thinkingTokens: 0 };
let runAgentThrows: Error | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockRunAgent = jest.fn(async (opts: any) => {
  if (runAgentThrows) throw runAgentThrows;
  const data = await opts.parseResponse(JSON.stringify(toolInput));
  return { data, tokenUsage, durationMs: 1, agentName: opts.config.agentName, modelId: opts.config.modelId, costUsd: 0 };
});

jest.mock('@bedrock/shared', () => ({
  ...jest.requireActual<object>('@bedrock/shared'),
  runAgent: (opts: unknown) => mockRunAgent(opts),
}));

import { extractCareerData } from '../extract-career.js';

const VALID = {
  profile:         { name: 'Jane', title: 'Engineer', email: 'j@ex.com', location: 'Dublin' },
  summary:         'Test summary',
  experience:      [],
  skills:          [],
  education:       [],
  certifications:  [],
  projects:        [],
  keyAchievements: [],
};

beforeEach(() => {
  mockRunAgent.mockClear();
  toolInput = { ...VALID };
  tokenUsage = { inputTokens: 1200, outputTokens: 300, thinkingTokens: 0 };
  runAgentThrows = null;
});

describe('extractCareerData', () => {
  it('returns token counts alongside extracted data', async () => {
    const result = await extractCareerData('resume text', 'eu-west-1');
    expect(result.inputTokens).toBe(1200);
    expect(result.outputTokens).toBe(300);
    expect(result.data.profile.name).toBe('Jane');
  });

  it('returns zero tokens when usage is absent', async () => {
    tokenUsage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
    const result = await extractCareerData('resume text', 'eu-west-1');
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it('throws a typed schema_validation_failed error when a required field is missing', async () => {
    toolInput = { ...VALID };
    delete toolInput.profile;
    await expect(extractCareerData('resume text', 'eu-west-1')).rejects.toMatchObject({
      name: 'CareerExtractionError',
      code: 'schema_validation_failed',
    });
  });

  it('rejects model output that injects an unknown field', async () => {
    toolInput = { ...VALID, injected: 'unexpected' };
    await expect(extractCareerData('resume text', 'eu-west-1')).rejects.toMatchObject({
      name: 'CareerExtractionError',
      code: 'schema_validation_failed',
    });
  });

  it('maps a runAgent failure (no tool_use / refusal) to CareerExtractionError(no_tool_use_block)', async () => {
    runAgentThrows = new Error('forced tool produced no tool_use block');
    await expect(extractCareerData('resume text', 'eu-west-1')).rejects.toMatchObject({
      name: 'CareerExtractionError',
      code: 'no_tool_use_block',
    });
  });

  it('redacts PII from resume text before it reaches the model', async () => {
    await extractCareerData(
      'John Doe, john.doe@mail.com, SSN 123-45-6789. Senior Engineer with AWS, TS, k8s. 6 yrs.',
      'eu-west-1',
    );
    // The userMessage handed to runAgent is what would reach Bedrock.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = (mockRunAgent.mock.calls.at(-1)?.[0] as any).userMessage as string;
    expect(sent).not.toContain('john.doe@mail.com');
    expect(sent).not.toContain('123-45-6789');
    expect(sent).toContain('[EMAIL]');
  });
});
