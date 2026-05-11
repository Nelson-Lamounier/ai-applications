import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({
    send: (jest.fn() as any).mockResolvedValue({
      body: Buffer.from(JSON.stringify({
        usage: { input_tokens: 1200, output_tokens: 300 },
        content: [{
          type: 'tool_use',
          input: {
            profile:         { name: 'Jane', title: 'Engineer', email: 'j@ex.com', location: 'Dublin' },
            summary:         'Test summary',
            experience:      [],
            skills:          [],
            education:       [],
            certifications:  [],
            projects:        [],
            keyAchievements: [],
          },
        }],
      })),
    }),
  })),
  InvokeModelCommand: jest.fn(),
}));

import { extractCareerData } from '../extract-career.js';

describe('extractCareerData', () => {
  it('returns token counts alongside extracted data', async () => {
    const result = await extractCareerData('resume text', 'eu-west-1');
    expect(result.inputTokens).toBe(1200);
    expect(result.outputTokens).toBe(300);
    expect(result.data.profile.name).toBe('Jane');
  });

  it('returns zero tokens when usage is absent', async () => {
    const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime');
    (BedrockRuntimeClient as jest.MockedClass<typeof BedrockRuntimeClient>).mockImplementationOnce(() => ({
      send: (jest.fn() as any).mockResolvedValue({
        body: Buffer.from(JSON.stringify({
          // no usage field
          content: [{
            type: 'tool_use',
            input: {
              profile:         { name: 'Bob', title: 'Dev', email: 'b@ex.com', location: 'London' },
              summary:         '',
              experience:      [],
              skills:          [],
              education:       [],
              certifications:  [],
              projects:        [],
              keyAchievements: [],
            },
          }],
        })),
      }),
    } as any));

    const result = await extractCareerData('resume text', 'eu-west-1');
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });
});
