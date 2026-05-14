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
  it('returns token counts alongside enriched data', async () => {
    const experience: ResumeExperience = {
      title: 'Senior Engineer',
      company: 'TechCorp',
      period: '2020-2023',
      highlights: ['Led team', 'Shipped features'],
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
    };

    const searchTool = {
      search: jest.fn(async () => []) as any,
    };

    const result = await enrichRole(experience, searchTool, 'eu-west-1');

    expect(result).toEqual({ data: null, inputTokens: 0, outputTokens: 0 });
  });
});
