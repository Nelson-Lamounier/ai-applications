/**
 * @format
 * Tests for public-api routes/articles.ts
 *
 * Strategy: mock `../../src/lib/pg.js` and `../../src/lib/config.js` so the
 * handler runs offline with a fake pg pool. The destination filter is the
 * focus — portfolio reads must be scoped to `destinations @> ARRAY['portfolio']`
 * in addition to `status = 'published'`.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.mock('../../src/lib/pg.js', () => ({ getPool: jest.fn() }));
jest.mock('../../src/lib/config.js', () => ({ loadConfig: jest.fn() }));

import articles from '../../src/routes/articles.js';
import { getPool } from '../../src/lib/pg.js';
import { loadConfig } from '../../src/lib/config.js';

const mockedGetPool = jest.mocked(getPool);
const mockedLoadConfig = jest.mocked(loadConfig);

const BASE_CONFIG = {
  awsRegion: 'eu-west-1',
  pgHost: 'pgbouncer.platform.svc.cluster.local',
  pgPort: 5432,
  pgDatabase: 'platform',
  pgUser: 'tucaken_app',
  pgPassword: 'secret',
  port: 3001,
};

describe('public articles routes — destination filter', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockedQuery: jest.Mock<any>;

  beforeEach(() => {
    jest.resetAllMocks();
    mockedQuery = jest.fn();
    mockedGetPool.mockReturnValue({ query: mockedQuery } as never);
    mockedLoadConfig.mockReturnValue(BASE_CONFIG as never);
  });

  describe('GET /api/articles', () => {
    it('scopes the list query to published portfolio articles', async () => {
      mockedQuery.mockResolvedValueOnce({
        rows: [
          {
            slug: 'a',
            title: 'A',
            excerpt: null,
            published_at: new Date('2026-01-01T00:00:00Z'),
            tags: ['x'],
            cover_image: null,
          },
        ],
      });

      const res = await articles.request('/api/articles');
      expect(res.status).toBe(200);

      const body = (await res.json()) as { items: unknown[]; count: number };
      expect(body.count).toBe(1);

      const sql = mockedQuery.mock.calls[0]?.[0] as string;
      expect(sql).toMatch(/status = 'published'/);
      expect(sql).toMatch(/destinations @> ARRAY\['portfolio'\]/);
    });
  });

  describe('GET /api/articles/:slug', () => {
    it('scopes the detail query to published portfolio articles', async () => {
      mockedQuery.mockResolvedValueOnce({
        rows: [
          {
            slug: 'a',
            title: 'A',
            excerpt: null,
            content_md: '# A',
            tags: [],
            ai_generated: false,
            ai_model: null,
            cover_image: null,
            published_at: new Date('2026-01-01T00:00:00Z'),
            created_at: new Date('2026-01-01T00:00:00Z'),
            updated_at: new Date('2026-01-01T00:00:00Z'),
          },
        ],
      });

      const res = await articles.request('/api/articles/a');
      expect(res.status).toBe(200);

      const sql = mockedQuery.mock.calls[0]?.[0] as string;
      expect(sql).toMatch(/status = 'published'/);
      expect(sql).toMatch(/destinations @> ARRAY\['portfolio'\]/);
    });

    it('404s when no published portfolio article matches the slug', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [] });
      const res = await articles.request('/api/articles/missing');
      expect(res.status).toBe(404);
    });
  });
});
