/**
 * @format
 * Tests for public-api routes/article-images.ts
 *
 * Strategy: mock `@aws-sdk/client-s3` and `../../src/lib/config.js` so the
 * handler runs offline with no real S3 call.
 *
 * Coverage:
 *   GET /api/articles/images/:file — 200 stream with 1h Cache-Control for
 *                                     valid filenames
 *   GET /api/articles/images/:file — 400 BEFORE any S3 call for invalid
 *                                     filenames (path traversal, uppercase,
 *                                     missing/disallowed extension, leading
 *                                     dash, encoded path separator)
 *   GET /api/articles/images/:file — 404 when the object does not exist
 *   GET /api/articles/images/:file — 503 when the bucket is not configured
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Config } from '../../src/lib/config.js';

// ---------------------------------------------------------------------------
// Module mocks — before subject imports
// ---------------------------------------------------------------------------

const mockSend = jest.fn<() => Promise<unknown>>();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  GetObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

jest.mock('../../src/lib/config.js', () => ({
  loadConfig: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import articleImages from '../../src/routes/article-images.js';
import { loadConfig } from '../../src/lib/config.js';

const mockedLoadConfig = jest.mocked(loadConfig);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_CONFIG: Config = {
  awsRegion: 'eu-west-1',
  oauthTokenKmsKeyArn: 'arn:aws:kms:eu-west-1:123456789012:key/12345678-1234-1234-1234-123456789012',
  githubAppSecretArn: 'arn:aws:secretsmanager:eu-west-1:123456789012:secret/github-app-test',
  pgHost: 'localhost',
  pgPort: 5432,
  pgDatabase: 'platform',
  pgUser: 'public_api',
  pgPassword: 'secret',
  port: 3001,
  allowedOrigins: ['http://localhost:3000'],
  bedrockApiUrl: undefined,
  bedrockApiKeySecretArn: undefined,
  bedrockPublicApiUrl: undefined,
  bedrockAuthApiUrl: undefined,
  portfolioOwnerUserId: undefined,
  articleAssetsBucketName: 'bkt',
};

beforeEach(() => {
  jest.resetAllMocks();
  mockedLoadConfig.mockReturnValue(BASE_CONFIG);
});

describe('GET /api/articles/images/:file', () => {
  it.each(['bff-architecture-hero.png', 'my-slug-cover.jpeg', 'a1.webp'])(
    'serves a valid filename %s from S3 with 1h cache',
    async (name) => {
      mockSend.mockResolvedValueOnce({
        Body: { transformToWebStream: () => new ReadableStream() },
        ContentType: 'image/png',
        ContentLength: 3,
      });
      const res = await articleImages.request(`/api/articles/images/${name}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
      expect(res.headers.get('content-type')).toBe('image/png');
    },
  );

  it.each([
    '../secrets.txt',
    'UPPER.png',
    'no-extension',
    'x.svg',
    '-leading-dash.png',
    'a%2Fb.png',
  ])('rejects invalid filename %s with 400 before any S3 call', async (name) => {
    const res = await articleImages.request(`/api/articles/images/${encodeURIComponent(name)}`);
    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects a raw single-encoded path-traversal filename (a%2Fb.png) with 400', async () => {
    // Hono's router decodes %2F to / before the handler sees the :file param,
    // so the raw request path below is what actually exercises the decoded
    // value against FILE_RE — this is distinct from the double-encoded case
    // above (encodeURIComponent('a%2Fb.png')), which never reaches a decoded
    // slash at all.
    const res = await articleImages.request('/api/articles/images/a%2Fb.png');
    expect(res.status).toBe(400);
    expect(mockSend).toHaveBeenCalledTimes(0);
  });

  it('returns 404 when the object does not exist', async () => {
    const err = Object.assign(new Error('no key'), { name: 'NoSuchKey' });
    mockSend.mockRejectedValueOnce(err);
    const res = await articleImages.request('/api/articles/images/missing.png');
    expect(res.status).toBe(404);
  });

  it('returns 503 when the bucket is not configured', async () => {
    mockedLoadConfig.mockReturnValue({ ...BASE_CONFIG, articleAssetsBucketName: undefined });
    const res = await articleImages.request('/api/articles/images/x.png');
    expect(res.status).toBe(503);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
