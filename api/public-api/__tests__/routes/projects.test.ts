/**
 * @format
 * Tests for public-api routes/projects.ts
 *
 * Mocks the pg pool + config so the handler runs offline with no real
 * Postgres connection. Coverage is focused on what makes the public
 * endpoint correct as a recruiter-share surface:
 *
 *   - 404 when the path params look malformed
 *   - 404 when no row matches (the SQL filter on visibility='public'
 *     and status<>'archived' is enforced at the database, not in the
 *     handler — these tests verify the SQL is shaped correctly)
 *   - 200 with the assembled case-study payload
 *   - sets Cache-Control header
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.mock('../../src/lib/pg.js', () => ({
    getPool: jest.fn(),
}));

jest.mock('../../src/lib/config.js', () => ({
    loadConfig: jest.fn(),
}));

import projectsRoute from '../../src/routes/projects.js';
import { getPool } from '../../src/lib/pg.js';
import { loadConfig } from '../../src/lib/config.js';

const mockedGetPool    = jest.mocked(getPool);
const mockedLoadConfig = jest.mocked(loadConfig);

const OWNER_ID = '00000000-0000-0000-0000-000000000001';

const BASE_CONFIG = {
    awsRegion:           'eu-west-1',
    pgHost:              'pgbouncer',
    pgPort:              5432,
    pgDatabase:          'tucaken',
    pgUser:              'postgres',
    pgPassword:          'secret',
    port:                3001,
    allowedOrigins:      ['*'],
    bedrockApiKeySecretArn: undefined,
    bedrockAuthApiUrl:   undefined,
    oauthTokenKmsKeyArn: 'arn',
    portfolioOwnerUserId: OWNER_ID,
} as const;

const PROJECT_ROW = {
    id:               '00000000-0000-0000-0000-000000000111',
    user_id:          '00000000-0000-0000-0000-000000000001',
    name:             'Tucaken',
    slug:             'tucaken',
    tagline:          'A grounded RAG portfolio',
    pitch:            'Tucaken pairs an evidence-cited LLM pipeline with a Tailwind UI.',
    type:             'production_saas',
    shape:            'multi_repo',
    status:           'active',
    role_exhibited:   'sole_builder',
    started_at:       new Date('2025-06-01T00:00:00.000Z'),
    ended_at:         null,
    last_activity_at: new Date('2025-07-01T00:00:00.000Z'),
    updated_at:       new Date('2025-07-01T00:00:00.000Z'),
};

beforeEach(() => {
    jest.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedLoadConfig.mockReturnValue(BASE_CONFIG as any);
});

describe('GET /public/projects/:username/:slug', () => {
    it('returns 404 when username path param fails the regex', async () => {
        const queryMock = jest.fn() as jest.Mock<(sql: string, params?: unknown[]) => Promise<{ rows: object[] }>>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockedGetPool.mockReturnValue({ query: queryMock } as any);
        const res = await projectsRoute.request('/public/projects/Bad User!/tucaken');
        expect(res.status).toBe(404);
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('returns 404 when slug path param fails the regex', async () => {
        const queryMock = jest.fn() as jest.Mock<(sql: string, params?: unknown[]) => Promise<{ rows: object[] }>>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockedGetPool.mockReturnValue({ query: queryMock } as any);
        const res = await projectsRoute.request('/public/projects/alice/NOT-VALID-CAPS');
        expect(res.status).toBe(404);
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('returns 404 when no public row matches', async () => {
        const queryMock = jest.fn() as jest.Mock<(sql: string, params?: unknown[]) => Promise<{ rows: object[] }>>;
        queryMock.mockResolvedValueOnce({ rows: [] });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockedGetPool.mockReturnValue({ query: queryMock } as any);
        const res = await projectsRoute.request('/public/projects/alice/tucaken');
        expect(res.status).toBe(404);
        const sql = String(queryMock.mock.calls[0]?.[0]);
        expect(sql).toMatch(/visibility = 'public'/);
        expect(sql).toMatch(/status <> 'archived'/);
        expect(sql).toMatch(/oauth_connections/);
    });

    it('returns the assembled case-study payload and sets Cache-Control', async () => {
        const queryMock = jest.fn() as jest.Mock<(sql: string, params?: unknown[]) => Promise<{ rows: object[] }>>;
        queryMock
            .mockResolvedValueOnce({ rows: [PROJECT_ROW] })                               // project
            .mockResolvedValueOnce({ rows: [{ id: 'c1', name: 'API', kind: 'backend', order_index: 0 }] })
            .mockResolvedValueOnce({ rows: [{ component_id: 'c1', repository_full_name: 'alice/tucaken-api', subpath: '' }] })
            .mockResolvedValueOnce({ rows: [{ title: 'Bedrock tool_use', context: 'c', decision: 'd', consequences: 'k', confidence: 'high', source_signals: { commits: [] }, order_index: 0 }] })
            .mockResolvedValueOnce({ rows: [{ title: 'Grounded answers', description: 'd', order_index: 0 }] })
            .mockResolvedValueOnce({ rows: [{ problem: 'pgvector dim', solution: 'pin', source_signals: { commits: [] }, order_index: 0 }] })
            .mockResolvedValueOnce({ rows: [{ category: 'language', name: 'TypeScript', justification: '', order_index: 0 }] })
            .mockResolvedValueOnce({ rows: [{
                has_tests: true, test_coverage_signal: 'moderate', has_ci: true, ci_maturity: 'deploys_to_prod',
                documentation_density: 'docs_dir', has_deployment_evidence: true, deployment_url: 'https://x.test', refactor_count: 3,
            }] })
            .mockResolvedValueOnce({ rows: [{ diagram_format: 'mermaid', diagram_source: 'graph LR\n A --> B', nodes: [], edges: [] }] })
            .mockResolvedValueOnce({ rows: [{ tag: 'rag' }, { tag: 'aws' }] });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockedGetPool.mockReturnValue({ query: queryMock } as any);

        const res = await projectsRoute.request('/public/projects/alice/tucaken');
        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=300, stale-while-revalidate=600');
        const body = await res.json() as Record<string, unknown>;
        expect(body.username).toBe('alice');
        expect(body.slug).toBe('tucaken');
        expect(body.tags).toEqual(['rag', 'aws']);
        expect(Array.isArray(body.decisions)).toBe(true);
        expect(Array.isArray(body.highlights)).toBe(true);
        expect((body.depthMarkers as { refactor_count: number }).refactor_count).toBe(3);
        expect((body.architecture as { diagram_format: string }).diagram_format).toBe('mermaid');
    });
});

describe('GET /api/projects (owner-scoped list)', () => {
    // Card row shape produced by the list query (subset of the projects table
    // plus case_study_status so the consumer can distinguish a rich card).
    const LIST_ROW = {
        id:                '00000000-0000-0000-0000-000000000111',
        slug:              'tucaken',
        name:              'Tucaken',
        tagline:           'A grounded RAG portfolio',
        type:              'production_saas',
        shape:             'multi_repo',
        role_exhibited:    'sole_builder',
        case_study_status: 'complete',
        started_at:        new Date('2025-06-01T00:00:00.000Z'),
        last_activity_at:  new Date('2025-07-01T00:00:00.000Z'),
        updated_at:        new Date('2025-07-01T00:00:00.000Z'),
    };

    it('fails closed with an empty list when PORTFOLIO_OWNER_USER_ID is unset', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockedLoadConfig.mockReturnValue({ ...BASE_CONFIG, portfolioOwnerUserId: undefined } as any);
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const queryMock = jest.fn() as jest.Mock<(sql: string, params?: unknown[]) => Promise<{ rows: object[] }>>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockedGetPool.mockReturnValue({ query: queryMock } as any);
        const res = await projectsRoute.request('/api/projects');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ items: [], count: 0 });
        // Fail closed means NO query: an unset owner must not fall back to
        // an unscoped read that could surface other users' projects.
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('scopes the list by the owner user id, not by username', async () => {
        const queryMock = jest.fn() as jest.Mock<(sql: string, params?: unknown[]) => Promise<{ rows: object[] }>>;
        queryMock.mockResolvedValueOnce({ rows: [] });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockedGetPool.mockReturnValue({ query: queryMock } as any);
        const res = await projectsRoute.request('/api/projects');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ items: [], count: 0 });
        const sql    = String(queryMock.mock.calls[0]?.[0]);
        const params = queryMock.mock.calls[0]?.[1] as unknown[];
        expect(sql).toMatch(/p\.user_id = \$1/);
        expect(sql).toMatch(/visibility = 'public'/);
        expect(sql).toMatch(/status <> 'archived'/);
        // No username join anywhere in the owner path — usernames are not
        // unique and can be renamed/reclaimed on GitHub.
        expect(sql).not.toMatch(/oauth_connections/);
        expect(params[0]).toBe(OWNER_ID);
    });

    it('returns assembled cards with tags, stack, and public repo names', async () => {
        const queryMock = jest.fn() as jest.Mock<(sql: string, params?: unknown[]) => Promise<{ rows: object[] }>>;
        queryMock
            .mockResolvedValueOnce({ rows: [LIST_ROW] })                                        // projects
            .mockResolvedValueOnce({ rows: [{ project_id: LIST_ROW.id, tag: 'rag' }, { project_id: LIST_ROW.id, tag: 'aws' }] })
            .mockResolvedValueOnce({ rows: [{ project_id: LIST_ROW.id, category: 'language', name: 'TypeScript', order_index: 0 }] })
            .mockResolvedValueOnce({ rows: [{ project_id: LIST_ROW.id, repository_full_name: 'alice/tucaken-api' }] });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockedGetPool.mockReturnValue({ query: queryMock } as any);

        const res = await projectsRoute.request('/api/projects');
        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=300, stale-while-revalidate=600');
        const body = await res.json() as { items: Array<Record<string, unknown>>; count: number };
        expect(body.count).toBe(1);
        const card = body.items[0]!;
        expect(card.slug).toBe('tucaken');
        expect(card.caseStudyStatus).toBe('complete');
        expect(card.tags).toEqual(['rag', 'aws']);
        expect(card.stack).toEqual([{ category: 'language', name: 'TypeScript' }]);
        expect(card.repositories).toEqual(['alice/tucaken-api']);
        // Private repos must be excluded by the SQL, same as the detail route.
        const repoSql = String(queryMock.mock.calls[3]?.[0]);
        expect(repoSql).toMatch(/is_private = FALSE/);
    });
});

describe('GET /api/projects/:slug (owner-scoped detail)', () => {
    it('returns 404 when PORTFOLIO_OWNER_USER_ID is unset (fail closed)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockedLoadConfig.mockReturnValue({ ...BASE_CONFIG, portfolioOwnerUserId: undefined } as any);
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const queryMock = jest.fn() as jest.Mock<(sql: string, params?: unknown[]) => Promise<{ rows: object[] }>>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockedGetPool.mockReturnValue({ query: queryMock } as any);
        const res = await projectsRoute.request('/api/projects/tucaken');
        expect(res.status).toBe(404);
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('pins the lookup to the owner user id and 404s when no row matches', async () => {
        const queryMock = jest.fn() as jest.Mock<(sql: string, params?: unknown[]) => Promise<{ rows: object[] }>>;
        queryMock.mockResolvedValueOnce({ rows: [] });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockedGetPool.mockReturnValue({ query: queryMock } as any);
        const res = await projectsRoute.request('/api/projects/tucaken');
        expect(res.status).toBe(404);
        const sql    = String(queryMock.mock.calls[0]?.[0]);
        const params = queryMock.mock.calls[0]?.[1] as unknown[];
        expect(sql).toMatch(/p\.user_id = \$1/);
        expect(sql).toMatch(/visibility = 'public'/);
        expect(params[0]).toBe(OWNER_ID);
        expect(params[1]).toBe('tucaken');
    });

    it('returns the assembled case study for the owner slug', async () => {
        const queryMock = jest.fn() as jest.Mock<(sql: string, params?: unknown[]) => Promise<{ rows: object[] }>>;
        queryMock
            .mockResolvedValueOnce({ rows: [{ ...PROJECT_ROW, username: 'alice' }] })            // project + username join
            .mockResolvedValueOnce({ rows: [] })   // components
            .mockResolvedValueOnce({ rows: [] })   // repositories
            .mockResolvedValueOnce({ rows: [] })   // decisions
            .mockResolvedValueOnce({ rows: [] })   // highlights
            .mockResolvedValueOnce({ rows: [] })   // challenges
            .mockResolvedValueOnce({ rows: [] })   // stack
            .mockResolvedValueOnce({ rows: [] })   // depth markers
            .mockResolvedValueOnce({ rows: [] })   // architecture
            .mockResolvedValueOnce({ rows: [] })   // resume bullets
            .mockResolvedValueOnce({ rows: [] });  // tags
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockedGetPool.mockReturnValue({ query: queryMock } as any);

        const res = await projectsRoute.request('/api/projects/tucaken');
        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body.slug).toBe('tucaken');
        expect(body.username).toBe('alice');
        expect(body.tags).toEqual([]);
    });
});

describe('GET /public/projects/:username/:slug — resume bullets are private', () => {
    it('serves an empty resumeBullets array and never queries the table', async () => {
        const queryMock = jest.fn() as jest.Mock<(sql: string, params?: unknown[]) => Promise<{ rows: object[] }>>;
        queryMock
            .mockResolvedValueOnce({ rows: [PROJECT_ROW] })
            .mockResolvedValueOnce({ rows: [] })  // components
            .mockResolvedValueOnce({ rows: [] })  // repositories
            .mockResolvedValueOnce({ rows: [] })  // decisions
            .mockResolvedValueOnce({ rows: [] })  // highlights
            .mockResolvedValueOnce({ rows: [] })  // challenges
            .mockResolvedValueOnce({ rows: [] })  // stack
            .mockResolvedValueOnce({ rows: [] })  // depth
            .mockResolvedValueOnce({ rows: [] })  // architecture
            .mockResolvedValueOnce({ rows: [] }); // tags
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockedGetPool.mockReturnValue({ query: queryMock } as any);

        const res = await projectsRoute.request('/public/projects/alice/tucaken');
        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        // Dashboard-only CV material: the public payload carries an empty
        // array (key kept for old-UI compatibility) and the table is never
        // read on the public path.
        expect(body.resumeBullets).toEqual([]);
        const sqls = queryMock.mock.calls.map((call) => String(call[0]));
        expect(sqls.some((sql) => /project_resume_bullets/.test(sql))).toBe(false);
    });
});
