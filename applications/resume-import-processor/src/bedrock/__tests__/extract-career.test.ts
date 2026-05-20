import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({
    send: (jest.fn() as jest.MockedFunction<() => Promise<unknown>>).mockResolvedValue({
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
      send: (jest.fn() as jest.MockedFunction<() => Promise<unknown>>).mockResolvedValue({
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
    } as unknown as never));

    const result = await extractCareerData('resume text', 'eu-west-1');
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it('throws a typed schema_validation_failed error when a required field is missing', async () => {
    const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime');
    (BedrockRuntimeClient as jest.MockedClass<typeof BedrockRuntimeClient>).mockImplementationOnce(() => ({
      send: (jest.fn() as jest.MockedFunction<() => Promise<unknown>>).mockResolvedValue({
        body: Buffer.from(JSON.stringify({
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{
            type: 'tool_use',
            input: {
              // profile is missing entirely — model violated the schema
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
    } as unknown as never));

    await expect(extractCareerData('resume text', 'eu-west-1')).rejects.toMatchObject({
      name: 'CareerExtractionError',
      code: 'schema_validation_failed',
    });
  });

  it('rejects model output that injects an unknown field', async () => {
    const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime');
    (BedrockRuntimeClient as jest.MockedClass<typeof BedrockRuntimeClient>).mockImplementationOnce(() => ({
      send: (jest.fn() as jest.MockedFunction<() => Promise<unknown>>).mockResolvedValue({
        body: Buffer.from(JSON.stringify({
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{
            type: 'tool_use',
            input: {
              profile:         { name: 'Jane', title: 'Engineer', email: 'j@ex.com', location: 'Dublin' },
              summary:         '',
              experience:      [],
              skills:          [],
              education:       [],
              certifications:  [],
              projects:        [],
              keyAchievements: [],
              injected:        'unexpected',
            },
          }],
        })),
      }),
    } as unknown as never));

    await expect(extractCareerData('resume text', 'eu-west-1')).rejects.toMatchObject({
      name: 'CareerExtractionError',
      code: 'schema_validation_failed',
    });
  });

  it('throws a typed no_tool_use_block error when Bedrock returns no tool_use', async () => {
    const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime');
    (BedrockRuntimeClient as jest.MockedClass<typeof BedrockRuntimeClient>).mockImplementationOnce(() => ({
      send: (jest.fn() as jest.MockedFunction<() => Promise<unknown>>).mockResolvedValue({
        body: Buffer.from(JSON.stringify({
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'text', text: 'I cannot do that.' }],
        })),
      }),
    } as unknown as never));

    await expect(extractCareerData('resume text', 'eu-west-1')).rejects.toMatchObject({
      name: 'CareerExtractionError',
      code: 'no_tool_use_block',
    });
  });

  it('redacts PII from resume text before the Bedrock request body', async () => {
    const awsSdk = await import('@aws-sdk/client-bedrock-runtime');
    const invokeModelCommandMock = awsSdk.InvokeModelCommand as unknown as jest.Mock;
    invokeModelCommandMock.mockClear();

    await extractCareerData(
      'John Doe, john.doe@mail.com, SSN 123-45-6789. Senior Engineer with AWS, TS, k8s. 6 yrs.',
      'eu-west-1',
    );

    // InvokeModelCommand receives the request as its first constructor argument;
    // the body field is a Buffer containing the JSON-encoded Bedrock request.
    const constructorArg = invokeModelCommandMock.mock.calls.at(-1)?.[0] as { body: Buffer };
    const sent = JSON.stringify(JSON.parse(Buffer.from(constructorArg.body).toString('utf-8')));

    expect(sent).not.toContain('john.doe@mail.com');
    expect(sent).not.toContain('123-45-6789');
    expect(sent).toContain('[EMAIL]');
  });
});
