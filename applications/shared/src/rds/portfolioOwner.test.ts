import { describe, it, expect, jest } from '@jest/globals';
import type { Pool } from 'pg';
import { resolvePortfolioOwnerId } from './portfolioOwner.js';

const OWNER = '1d4c645a-447e-4b5b-924d-19a3c75a84db';
const poolWith = (query: jest.Mock): Pool => ({ query } as unknown as Pool);

describe('resolvePortfolioOwnerId', () => {
    it('returns the DB owner via the portfolio_owner_id() function', async () => {
        const q = jest.fn(async () => ({ rows: [{ portfolio_owner_id: OWNER }] })) as unknown as jest.Mock;
        const got = await resolvePortfolioOwnerId(poolWith(q), 'env-fallback');
        expect(got).toBe(OWNER);
        expect((q.mock.calls[0] as unknown as [string])[0]).toMatch(/portfolio_owner_id\(\)/);
    });

    it('falls back to env when the function returns null (no owner set)', async () => {
        const q = jest.fn(async () => ({ rows: [{ portfolio_owner_id: null }] })) as unknown as jest.Mock;
        expect(await resolvePortfolioOwnerId(poolWith(q), 'env-fallback')).toBe('env-fallback');
    });

    it('falls back to env when the query throws (DB unreachable / function missing)', async () => {
        const q = jest.fn(async () => { throw new Error('function portfolio_owner_id() does not exist'); }) as unknown as jest.Mock;
        expect(await resolvePortfolioOwnerId(poolWith(q), 'env-fallback')).toBe('env-fallback');
    });
});
