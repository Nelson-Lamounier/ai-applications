/** @format */
import { jest } from '@jest/globals';

const capture = jest.fn<(c: string, a: string[]) => Promise<string>>();
const getSSMParameter = jest.fn<(name: string, cfg: unknown) => Promise<string>>();
jest.mock('../exec-wrapper', () => ({ capture }));
jest.mock('@repo/script-utils/aws.js', () => ({
  getSSMParameter,
  resolveAuth: () => ({ credentials: undefined }),
}));

import { resolveChatbotUrls, decodeK8sSecret, resolveRdsConn } from '../discovery';

describe('decodeK8sSecret', () => {
  it('base64-decodes a jsonpath secret value', () => {
    expect(decodeK8sSecret(Buffer.from('s3cr3t').toString('base64'))).toBe('s3cr3t');
  });
});

describe('resolveChatbotUrls', () => {
  beforeEach(() => getSSMParameter.mockReset());
  it('reads the single api-url param and returns the stripped base for all three', async () => {
    getSSMParameter.mockResolvedValueOnce('https://x/prod/');
    const r = await resolveChatbotUrls('bedrock-dev', { region: 'eu-west-1' });
    expect(r).toEqual({
      chatbotUrl: 'https://x/prod',
      chatbotPublicUrl: 'https://x/prod',
      chatbotAuthenticatedUrl: 'https://x/prod',
    });
    expect(getSSMParameter).toHaveBeenCalledTimes(1);
  });
});

describe('resolveRdsConn', () => {
  beforeEach(() => capture.mockReset());
  it('reads database/user/password from the platform k8s secret', async () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    capture.mockImplementation(async (_c, a) => {
      const jp = a[a.length - 1];
      if (jp.includes('PG_DATABASE')) return b64('tucaken');
      if (jp.includes('PG_USER')) return b64('app_user');
      if (jp.includes('PG_PASSWORD')) return b64('s3cr3t');
      return '';
    });
    const r = await resolveRdsConn();
    expect(r).toEqual({ database: 'tucaken', user: 'app_user', password: 's3cr3t' });
  });
});
