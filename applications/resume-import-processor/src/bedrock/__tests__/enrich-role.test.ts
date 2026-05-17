import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({
    send: (jest.fn() as any).mockResolvedValue({
      body: Buffer.from(JSON.stringify({
        usage: { input_tokens: 800, output_tokens: 200 },
        content: [{
          type: 'tool_use',
          input: {
            roleDescription: 'Senior software engineer responsibilities',
            responsibilities: ['System design', 'Code review'],
            transferableSkills: ['Leadership', 'Communication'],
            industryContext: 'Technology / SaaS',
            typicalTechStack: ['TypeScript', 'React', 'Node.js'],
            careerLevel: 'senior',
          },
        }],
      })),
    }),
  })),
  InvokeModelCommand: jest.fn(),
}));

import { enrichRole } from '../enrich-role.js';
import type { ResumeExperience } from '../extract-career.js';

describe('enrichRole', () => {
  it('does not leak PII in the Bedrock request body', async () => {
    const { InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
    const mockCmd = InvokeModelCommand as unknown as ReturnType<typeof jest.fn>;
    mockCmd.mockClear();

    const piiExperience: ResumeExperience = {
      title:           'Software Engineer',
      company:         'Acme jane@acme.com Corp',
      period:          '2019-2022',
      highlights:      ['Increased revenue', 'call 415-555-2671 for more info'],
      confidenceFlags: [],
    };

    const searchTool = {
      search: jest.fn(async () => [
        { title: 'Result', url: '', content: 'Generic job context', score: 0 },
      ]) as any,
    };

    await enrichRole(piiExperience, searchTool, 'eu-west-1');

    expect(mockCmd).toHaveBeenCalled();
    const callArg = mockCmd.mock.calls[0]?.[0] as { body: Buffer };
    const bodyStr = Buffer.from(callArg.body).toString('utf-8');

    // Raw PII must NOT appear in the Bedrock request body
    expect(bodyStr).not.toContain('jane@acme.com');
    expect(bodyStr).not.toContain('415-555-2671');

    // Redaction tokens MUST appear
    expect(bodyStr).toMatch(/\[EMAIL\]|\[PHONE\]/);
  });

  it('returns token counts alongside enriched data', async () => {
    const experience: ResumeExperience = {
      title: 'Senior Engineer',
      company: 'TechCorp',
      period: '2020-2023',
      highlights: ['Led team', 'Shipped features'],
      confidenceFlags: [],
    };

    const searchTool = {
      search: jest.fn(async () => [
        { title: 'Result', url: '', content: 'Some context', score: 0 },
      ]) as any,
    };

    const result = await enrichRole(experience, searchTool, 'eu-west-1');

    expect(result.inputTokens).toBe(800);
    expect(result.outputTokens).toBe(200);
    expect(result.data).not.toBeNull();
    expect(result.data?.careerLevel).toBe('senior');
  });

  it('returns zero tokens when search returns empty array', async () => {
    const experience: ResumeExperience = {
      title: 'Senior Engineer',
      company: 'TechCorp',
      period: '2020-2023',
      highlights: ['Led team'],
      confidenceFlags: [],
    };

    const searchTool = {
      search: jest.fn(async () => []) as any,
    };

    const result = await enrichRole(experience, searchTool, 'eu-west-1');

    expect(result).toEqual({ data: null, inputTokens: 0, outputTokens: 0 });
  });
});
