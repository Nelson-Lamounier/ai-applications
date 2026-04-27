/**
 * @format
 * Tests for public-api routes/resumes.ts
 *
 * Strategy: mock `../../src/lib/pg.js` and `../../src/lib/config.js`
 * so the handler runs offline with no real PG connection.
 *
 * Coverage:
 *   GET /api/resumes/active — 200 with active resume payload
 *   GET /api/resumes/active — 204 when no active resume exists
 *   GET /api/resumes/active — sets Cache-Control header
 *   GET /api/resumes/active — uses content_json->>'is_active' filter
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Module mocks — before subject imports
// ---------------------------------------------------------------------------

jest.mock('../../src/lib/pg.js', () => ({
  getPool: jest.fn(),
}));

jest.mock('../../src/lib/config.js', () => ({
  loadConfig: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import resumes from '../../src/routes/resumes.js';
import { getPool } from '../../src/lib/pg.js';
import { loadConfig } from '../../src/lib/config.js';

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockedGetPool = jest.mocked(getPool);
const mockedLoadConfig = jest.mocked(loadConfig);

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const ACTIVE_RESUME_ROW = {
  id:           '00000000-0000-0000-0000-000000000001',
  content_json: {
    label:     'Senior Engineer CV',
    is_active: true,
    basics:    { name: 'Nelson Lamounier', title: 'Senior Engineer' },
  },
  generated_at: new Date('2026-01-01T00:00:00.000Z'),
};

const BASE_CONFIG = {
  awsRegion:  'eu-west-1',
  pgHost:     'pgbouncer.platform.svc.cluster.local',
  pgPort:     5432,
  pgDatabase: 'platform',
  pgUser:     'public_api',
  pgPassword: 'secret',
  port:       3001,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/resumes/active', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockedQuery: jest.Mock<any>;

  beforeEach(() => {
    jest.resetAllMocks();
    mockedQuery = jest.fn();
    mockedGetPool.mockReturnValue({ query: mockedQuery } as never);
    mockedLoadConfig.mockReturnValue(BASE_CONFIG as never);
  });

  it('returns 200 with resume data when an active resume exists', async () => {
    mockedQuery.mockResolvedValue({ rows: [ACTIVE_RESUME_ROW] });
    const res = await resumes.request('/api/resumes/active');
    expect(res.status).toBe(200);
  });

  it('includes resumeId, label, isActive, data, createdAt and updatedAt in the response', async () => {
    mockedQuery.mockResolvedValue({ rows: [ACTIVE_RESUME_ROW] });
    const res = await resumes.request('/api/resumes/active');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['resumeId']).toBe(ACTIVE_RESUME_ROW.id);
    expect(body['label']).toBe('Senior Engineer CV');
    expect(body['isActive']).toBe(true);
    expect(body['data']).toEqual(ACTIVE_RESUME_ROW.content_json);
    expect(body['createdAt']).toBeDefined();
    expect(body['updatedAt']).toBeDefined();
  });

  it('sets Cache-Control with s-maxage and stale-while-revalidate', async () => {
    mockedQuery.mockResolvedValue({ rows: [ACTIVE_RESUME_ROW] });
    const res = await resumes.request('/api/resumes/active');
    const cacheControl = res.headers.get('Cache-Control') ?? '';
    expect(cacheControl).toContain('s-maxage');
    expect(cacheControl).toContain('stale-while-revalidate');
  });

  it('returns 204 when no active resume exists', async () => {
    mockedQuery.mockResolvedValue({ rows: [] });
    const res = await resumes.request('/api/resumes/active');
    expect(res.status).toBe(204);
  });

  it("queries with content_json->>'is_active' = 'true' filter", async () => {
    mockedQuery.mockResolvedValue({ rows: [ACTIVE_RESUME_ROW] });
    await resumes.request('/api/resumes/active');
    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const sql = mockedQuery.mock.calls[0]?.[0] as string;
    expect(sql).toMatch(/content_json->>'is_active'\s*=\s*'true'/);
    expect(sql).toMatch(/FROM resumes/);
  });
});
