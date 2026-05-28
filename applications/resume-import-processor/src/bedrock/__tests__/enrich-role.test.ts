import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// enrichRole now goes through the shared runAgent() wrapper. Override only
// runAgent (keep the real PiiScrubber so redaction is genuinely tested); the
// mock runs the agent's parseResponse over a configurable tool input and
// records the userMessage so the PII assertion can inspect what would be sent.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let toolInput: any = {};
let tokenUsage = { inputTokens: 800, outputTokens: 200, thinkingTokens: 0 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockRunAgent = jest.fn(async (opts: any) => {
  const data = await opts.parseResponse(JSON.stringify(toolInput));
  return { data, tokenUsage, durationMs: 1, agentName: opts.config.agentName, modelId: opts.config.modelId, costUsd: 0 };
});

jest.mock('@bedrock/shared', () => ({
  ...jest.requireActual<object>('@bedrock/shared'),
  runAgent: (opts: unknown) => mockRunAgent(opts),
}));

import { enrichRole } from '../enrich-role.js';
import type { ResumeExperience } from '../extract-career.js';

const VALID = {
  roleDescription: 'Senior software engineer responsibilities',
  responsibilities: ['System design', 'Code review'],
  transferableSkills: ['Leadership', 'Communication'],
  industryContext: 'Technology / SaaS',
  typicalTechStack: ['TypeScript', 'React', 'Node.js'],
  careerLevel: 'senior',
};

function searchToolReturning(results: unknown[]) {
  return { search: jest.fn(async () => results) as unknown as never };
}

describe('enrichRole', () => {
  beforeEach(() => {
    mockRunAgent.mockClear();
    toolInput = { ...VALID };
    tokenUsage = { inputTokens: 800, outputTokens: 200, thinkingTokens: 0 };
  });

  it('does not leak PII in the prompt sent to the model', async () => {
    const piiExperience: ResumeExperience = {
      title:           'Software Engineer',
      company:         'Acme jane@acme.com Corp',
      period:          '2019-2022',
      highlights:      ['Increased revenue', 'call 415-555-2671 for more info'],
      confidenceFlags: [],
    };

    await enrichRole(piiExperience, searchToolReturning([
      { title: 'Result', url: '', content: 'Generic job context', score: 0 },
    ]), 'eu-west-1');

    expect(mockRunAgent).toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = (mockRunAgent.mock.calls[0]?.[0] as any).userMessage as string;
    expect(sent).not.toContain('jane@acme.com');
    expect(sent).not.toContain('415-555-2671');
    expect(sent).toMatch(/\[EMAIL\]|\[PHONE\]/);
  });

  it('returns token counts alongside enriched data', async () => {
    const experience: ResumeExperience = {
      title: 'Senior Engineer', company: 'TechCorp', period: '2020-2023',
      highlights: ['Led team', 'Shipped features'], confidenceFlags: [],
    };

    const result = await enrichRole(experience, searchToolReturning([
      { title: 'Result', url: '', content: 'Some context', score: 0 },
    ]), 'eu-west-1');

    expect(result.inputTokens).toBe(800);
    expect(result.outputTokens).toBe(200);
    expect(result.data).not.toBeNull();
    expect(result.data?.careerLevel).toBe('senior');
  });

  it('skips gracefully (null) when the model output fails schema validation', async () => {
    toolInput = {
      // careerLevel missing + responsibilities wrong type + unknown field
      roleDescription: 'x',
      responsibilities: 'not-an-array',
      transferableSkills: [],
      industryContext: 'y',
      typicalTechStack: [],
      injected: 'nope',
    };

    const result = await enrichRole(
      { title: 'Eng', company: 'Co', period: '2020-2023', highlights: ['h'], confidenceFlags: [] },
      searchToolReturning([{ title: 'Result', url: '', content: 'ctx', score: 0 }]),
      'eu-west-1',
    );

    expect(result).toEqual({ data: null, inputTokens: 0, outputTokens: 0 });
  });

  it('returns zero tokens when search returns empty array (no model call)', async () => {
    const result = await enrichRole(
      { title: 'Senior Engineer', company: 'TechCorp', period: '2020-2023', highlights: ['Led team'], confidenceFlags: [] },
      searchToolReturning([]),
      'eu-west-1',
    );

    expect(result).toEqual({ data: null, inputTokens: 0, outputTokens: 0 });
    expect(mockRunAgent).not.toHaveBeenCalled();
  });
});
