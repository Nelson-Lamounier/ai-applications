/** @format */
import { loadCommitPrEvidence } from './commit-pr-evidence.js';

function makePool(rows: { pulls?: unknown[]; commits?: unknown[] }) {
    return {
        query: async (sql: string) => {
            if (/FROM repo_pull_requests/.test(sql)) return { rows: rows.pulls ?? [] };
            if (/FROM repo_commits/.test(sql)) return { rows: rows.commits ?? [] };
            return { rows: [] };
        },
    } as never;
}

describe('loadCommitPrEvidence', () => {
    it('formats merged PRs and authored commits into a shipped-work block', async () => {
        const out = await loadCommitPrEvidence(makePool({
            pulls: [{ repo_full_name: 'me/app', number: 12, title: 'feat(ingestion): enable controlled-vocabulary enrichment in production' }],
            commits: [{ repo_full_name: 'me/app', message: 'feat(enrichment): content-hash dedup cache — skip Haiku for unchanged chunks' }],
        }), 'u1');
        expect(out).toContain('Shipped work');
        expect(out).toContain('controlled-vocabulary enrichment');
        expect(out).toContain('#12');
        expect(out).toContain('content-hash dedup cache');
    });

    it('returns empty string on no rows (fail-open)', async () => {
        expect(await loadCommitPrEvidence(makePool({}), 'u1')).toBe('');
    });

    it('returns empty string when the query throws', async () => {
        const pool = { query: async () => { throw new Error('db down'); } } as never;
        expect(await loadCommitPrEvidence(pool, 'u1')).toBe('');
    });
});
