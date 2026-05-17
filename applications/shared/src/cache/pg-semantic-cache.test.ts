const queryMock = jest.fn();
jest.mock('pg', () => ({ Pool: jest.fn(() => ({ query: queryMock })) }));
const embedMock = jest.fn();
jest.mock('../rds/index.js', () => ({
    TitanEmbeddingProvider: { fromEnvironment: () => ({ embed: embedMock }) },
}));
const emitMock = jest.fn();
jest.mock('../emf.js', () => ({ emitEmfMetric: (...a: unknown[]) => emitMock(...a) }));
jest.mock('../security/index.js', () => ({
    PiiScrubber: jest.fn(() => ({ scrub: (t: string) => ({ redacted: t }) })),
}));

import { PgSemanticCache } from './pg-semantic-cache.js';

const cfg = { host: 'h', port: 5432, database: 'd', user: 'u', password: 'p' };

beforeEach(() => { queryMock.mockReset(); embedMock.mockReset(); emitMock.mockReset();
    embedMock.mockResolvedValue([0.1, 0.2]); });

describe('PgSemanticCache', () => {
    it('returns a hit when similarity >= threshold', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [{ id: 7, response: { a: 1 }, similarity: 0.97 }] })
            .mockResolvedValueOnce({ rows: [] });
        const c = new PgSemanticCache({ ...cfg, threshold: 0.95 });
        const r = await c.get({ scope: 's', kbTag: 'k', queryText: 'hello' });
        expect(r.hit).toBe(true);
        expect(r.response).toEqual({ a: 1 });
        expect(emitMock).toHaveBeenCalled();
    });

    it('returns a miss when similarity is below threshold', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ id: 7, response: { a: 1 }, similarity: 0.8 }] });
        const c = new PgSemanticCache({ ...cfg, threshold: 0.95 });
        const r = await c.get({ scope: 's', kbTag: 'k', queryText: 'hello' });
        expect(r.hit).toBe(false);
    });

    it('returns a miss when no row matches scope/tag/ttl', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const c = new PgSemanticCache(cfg);
        expect((await c.get({ scope: 's', kbTag: 'k', queryText: 'q' })).hit).toBe(false);
    });

    it('is fail-open: DB error on get → miss, no throw, CacheError emitted', async () => {
        queryMock.mockRejectedValueOnce(new Error('db down'));
        const c = new PgSemanticCache(cfg);
        const r = await c.get({ scope: 's', kbTag: 'k', queryText: 'q' });
        expect(r.hit).toBe(false);
        expect(emitMock.mock.calls.some(c => JSON.stringify(c).includes('CacheError'))).toBe(true);
    });

    it('is fail-open: embed error → miss, no throw', async () => {
        embedMock.mockRejectedValueOnce(new Error('bedrock down'));
        const c = new PgSemanticCache(cfg);
        expect((await c.get({ scope: 's', kbTag: 'k', queryText: 'q' })).hit).toBe(false);
    });

    it('put inserts a row and is fail-open on error', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const c = new PgSemanticCache(cfg);
        await c.put({ scope: 's', kbTag: 'k', queryText: 'q', response: { x: 1 } });
        const sql = String(queryMock.mock.calls.at(-1)?.[0]);
        expect(sql).toMatch(/INSERT INTO semantic_cache/i);
        queryMock.mockRejectedValueOnce(new Error('db down'));
        await expect(c.put({ scope: 's', kbTag: 'k', queryText: 'q', response: {} }))
            .resolves.toBeUndefined();
    });

    it('fires hit_count increment on a hit', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [{ id: 7, response: {}, similarity: 0.99 }] })
            .mockResolvedValueOnce({ rows: [] });
        const c = new PgSemanticCache({ ...cfg, threshold: 0.95 });
        await c.get({ scope: 's', kbTag: 'k', queryText: 'q' });
        await new Promise(r => setImmediate(r));
        const calls = queryMock.mock.calls.map(c => String(c[0]));
        expect(calls.some(s => /hit_count\s*=\s*hit_count\s*\+\s*1/i.test(s))).toBe(true);
    });

    it('invalidate deletes rows scoped by scope+kbTag and returns the count', async () => {
        queryMock.mockResolvedValueOnce({ rowCount: 4 });
        const c = new PgSemanticCache(cfg);
        const n = await c.invalidate({ scope: 's', kbTag: 'k' });
        expect(n).toBe(4);
        const [sql, params] = queryMock.mock.calls.at(-1) as [string, unknown[]];
        expect(sql).toMatch(/DELETE FROM semantic_cache/i);
        expect(sql).toMatch(/scope = \$1/);
        expect(sql).toMatch(/kb_tag = \$2/);
        expect(params).toEqual(['s', 'k']);
    });

    it('invalidate by scope only deletes the whole scope', async () => {
        queryMock.mockResolvedValueOnce({ rowCount: 12 });
        const c = new PgSemanticCache(cfg);
        const n = await c.invalidate({ scope: 's' });
        expect(n).toBe(12);
        const [sql, params] = queryMock.mock.calls.at(-1) as [string, unknown[]];
        expect(sql).toMatch(/scope = \$1/);
        expect(sql).not.toMatch(/kb_tag/);
        expect(params).toEqual(['s']);
    });

    it('invalidate is fail-open: db error → returns 0, CacheError emitted', async () => {
        queryMock.mockRejectedValueOnce(new Error('db down'));
        const c = new PgSemanticCache(cfg);
        const n = await c.invalidate({ scope: 's', kbTag: 'k' });
        expect(n).toBe(0);
        expect(emitMock.mock.calls.some(c => JSON.stringify(c).includes('CacheError'))).toBe(true);
    });

    it('scrubs PII from query_text before inserting into the DB', async () => {
        const { PiiScrubber } = jest.requireMock('../security/index.js') as
            { PiiScrubber: jest.Mock };
        PiiScrubber.mockImplementationOnce(() => ({
            scrub: (t: string) => ({ redacted: t.replace(/[^\s@]+@[^\s@]+/, '[EMAIL]') }),
        }));
        queryMock.mockResolvedValueOnce({ rows: [] });
        const c = new PgSemanticCache(cfg);
        await c.put({ scope: 's', kbTag: 'k', queryText: 'reach me at user@example.com', response: {} });
        const params = queryMock.mock.calls.at(-1)?.[1] as string[];
        expect(params[2]).not.toContain('user@example.com');
        expect(params[2]).toContain('[EMAIL]');
    });
});
