import type { Pool } from 'pg';

/**
 * Resolve the single portfolio owner's id RLS-safely, via the
 * `portfolio_owner_id()` SECURITY DEFINER function (migration 114) — app roles
 * (tucaken_app) can EXECUTE it, and it returns only the non-sensitive owner id
 * without weakening user isolation on the `users` table.
 *
 * Falls back to `envFallback` (the PORTFOLIO_OWNER_USER_ID env) when the DB is
 * unreachable or the function/owner is absent, so the hot public path never
 * breaks and a deploy-order race (Lambda up before the function exists) degrades
 * safely. Callers should cache the result — the owner is global and effectively
 * immutable per process.
 */
export async function resolvePortfolioOwnerId(pool: Pool, envFallback: string): Promise<string> {
    try {
        const r = await pool.query<{ portfolio_owner_id: string | null }>('SELECT portfolio_owner_id()');
        return r.rows[0]?.portfolio_owner_id ?? envFallback;
    } catch {
        return envFallback;
    }
}
