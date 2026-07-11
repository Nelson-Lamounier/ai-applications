/**
 * @format
 * Tests for public-api routes/engagement.ts
 *
 * Strategy: mock `../../src/lib/pg.js` and `../../src/lib/config.js` so the
 * handler runs offline with a fake pg pool.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.mock('../../src/lib/pg.js', () => ({ getPool: jest.fn() }));
jest.mock('../../src/lib/config.js', () => ({ loadConfig: jest.fn() }));

import engagement from '../../src/routes/engagement.js';
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

describe('engagement routes', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockedQuery: jest.Mock<any>;

  beforeEach(() => {
    jest.resetAllMocks();
    mockedQuery = jest.fn();
    mockedGetPool.mockReturnValue({ query: mockedQuery } as never);
    mockedLoadConfig.mockReturnValue(BASE_CONFIG as never);
  });

  describe('GET /api/articles/:slug/like', () => {
    it('returns liked=false and the count when no sessionId is given', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [{ n: 3 }] }); // likeCount
      const res = await engagement.request('/api/articles/my-post/like');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ liked: false, likeCount: 3 });
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });

    it('reports liked=true when the session has a like row', async () => {
      mockedQuery
        .mockResolvedValueOnce({ rows: [{ 1: 1 }] }) // liked lookup
        .mockResolvedValueOnce({ rows: [{ n: 5 }] }) // likeCount
      const res = await engagement.request('/api/articles/my-post/like?sessionId=abc')
      expect(await res.json()).toEqual({ liked: true, likeCount: 5 })
    });
  });

  describe('POST /api/articles/:slug/like', () => {
    it('adds a like when none existed (delete removes 0 rows)', async () => {
      mockedQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // DELETE
        .mockResolvedValueOnce({ rows: [] })             // INSERT
        .mockResolvedValueOnce({ rows: [{ n: 1 }] })     // likeCount
      const res = await engagement.request('/api/articles/my-post/like', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-1' }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ liked: true, likeCount: 1 })
    });

    it('removes a like when one existed (delete removes a row)', async () => {
      mockedQuery
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // DELETE
        .mockResolvedValueOnce({ rows: [{ n: 0 }] })      // likeCount
      const res = await engagement.request('/api/articles/my-post/like', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-1' }),
      })
      expect(await res.json()).toEqual({ liked: false, likeCount: 0 })
    });

    it('400s when sessionId is missing', async () => {
      const res = await engagement.request('/api/articles/my-post/like', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
      expect(mockedQuery).not.toHaveBeenCalled()
    });
  });

  describe('GET /api/articles/:slug/comments', () => {
    it('returns approved comments without email/IP and sets cache header', async () => {
      mockedQuery.mockResolvedValueOnce({
        rows: [
          { id: 'c1', name: 'Ada', body: 'Great post', created_at: new Date('2026-01-01T00:00:00Z') },
        ],
      })
      const res = await engagement.request('/api/articles/my-post/comments')
      expect(res.status).toBe(200)
      const body = (await res.json()) as Array<Record<string, unknown>>
      expect(body[0]).toMatchObject({ commentId: 'c1', name: 'Ada', body: 'Great post' })
      expect(body[0]).not.toHaveProperty('email')
      expect(res.headers.get('Cache-Control')).toContain('s-maxage')
      const sql = mockedQuery.mock.calls[0]?.[0] as string
      expect(sql).toMatch(/status = 'approved'/)
    });
  });

  describe('POST /api/articles/:slug/comments', () => {
    it('creates a pending comment and returns 201 (public-safe)', async () => {
      mockedQuery
        .mockResolvedValueOnce({ rows: [{ n: 0 }] })                                   // rate-limit count
        .mockResolvedValueOnce({ rows: [{ id: 'new-id', created_at: new Date('2026-02-02T00:00:00Z') }] }) // INSERT
      const res = await engagement.request('/api/articles/my-post/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Ada', email: 'ada@example.com', body: 'Nice' }),
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as Record<string, unknown>
      expect(body).toMatchObject({ commentId: 'new-id', name: 'Ada', body: 'Nice' })
      expect(body).not.toHaveProperty('email')
      // INSERT defaults status to pending
      const insertSql = mockedQuery.mock.calls[1]?.[0] as string
      expect(insertSql).toMatch(/'pending'/)
    });

    it('400s on a missing/invalid email', async () => {
      const res = await engagement.request('/api/articles/my-post/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Ada', email: 'nope', body: 'Nice' }),
      })
      expect(res.status).toBe(400)
      expect(mockedQuery).not.toHaveBeenCalled()
    });

    it('429s when the IP exceeds the rate limit', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [{ n: 5 }] }) // rate-limit count at max
      const res = await engagement.request('/api/articles/my-post/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
        body: JSON.stringify({ name: 'Ada', email: 'ada@example.com', body: 'Nice' }),
      })
      expect(res.status).toBe(429)
    });

    it('rate-limits on the proxy-appended IP, not a spoofed leftmost XFF', async () => {
      // A caller pre-seeds "9.9.9.9"; the ALB appends the real peer "203.0.113.9".
      // The per-IP count must key on the trusted (rightmost) value so an
      // attacker cannot dodge the limit by rotating the leftmost entry.
      mockedQuery
        .mockResolvedValueOnce({ rows: [{ n: 0 }] }) // rate-limit count
        .mockResolvedValueOnce({ rows: [{ id: 'x', created_at: new Date('2026-02-02T00:00:00Z') }] })
      await engagement.request('/api/articles/my-post/comments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '9.9.9.9, 203.0.113.9',
        },
        body: JSON.stringify({ name: 'Ada', email: 'ada@example.com', body: 'Nice' }),
      })
      const rateLimitParams = mockedQuery.mock.calls[0]?.[1] as unknown[]
      expect(rateLimitParams[0]).toBe('203.0.113.9')
    });
  });
});
