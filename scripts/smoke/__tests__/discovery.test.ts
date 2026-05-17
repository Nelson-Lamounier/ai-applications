/** @format */
import { jest } from '@jest/globals';

const capture = jest.fn<(c: string, a: string[]) => Promise<string>>();
const getSSMParameter = jest.fn<(name: string, cfg: unknown) => Promise<string>>();
jest.mock('../exec-wrapper', () => ({ capture }));
jest.mock('@repo/script-utils/aws.js', () => ({
  getSSMParameter,
  resolveAuth: () => ({ credentials: undefined }),
}));

import { resolveChatbotUrls, decodeK8sSecret } from '../discovery';

describe('decodeK8sSecret', () => {
  it('base64-decodes a jsonpath secret value', () => {
    expect(decodeK8sSecret(Buffer.from('s3cr3t').toString('base64'))).toBe('s3cr3t');
  });
});

describe('resolveChatbotUrls', () => {
  beforeEach(() => getSSMParameter.mockReset());
  it('reads the three CDK SSM params and strips trailing slashes', async () => {
    getSSMParameter
      .mockResolvedValueOnce('https://a.example.com/prod/')
      .mockResolvedValueOnce('https://b.example.com/prod/')
      .mockResolvedValueOnce('https://c.example.com/prod/');
    const r = await resolveChatbotUrls('bedrock-data-development', { region: 'eu-west-1' });
    expect(r).toEqual({
      chatbotUrl: 'https://a.example.com/prod',
      chatbotPublicUrl: 'https://b.example.com/prod',
      chatbotAuthenticatedUrl: 'https://c.example.com/prod',
    });
  });
});
