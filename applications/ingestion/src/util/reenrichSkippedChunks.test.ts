/** @format */
import { reenrichSkippedChunks } from './reenrichSkippedChunks.js';
import type { Pool } from 'pg';
import type { IChunkEnricher } from '@bedrock/shared';

function makePool(skippedRows: Array<{ id: string; file_path: string; heading: string | null; content: string; file_tech_stack?: string[] | null }>) {
    const updates: Array<{ skills: string[]; id: string }> = [];
    const query = jest.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT')) return { rows: skippedRows };
        if (sql.includes('UPDATE')) {
            updates.push({ skills: params?.[0] as string[], id: params?.[1] as string });
            return { rows: [] };
        }
        return { rows: [] };
    });
    return { pool: { query } as unknown as Pool, query, updates };
}

const rows = [
    { id: 'a', file_path: 'src/x.ts', heading: 'X', content: 'uses kubernetes networking' },
    { id: 'b', file_path: 'src/y.ts', heading: null, content: 'cdk stack' },
];

describe('reenrichSkippedChunks', () => {
    it('enriches each skipped chunk and flips status to ok', async () => {
        const { pool, query, updates } = makePool(rows);
        const enricher: IChunkEnricher = {
            enrich: jest.fn(async () => ({ skills: ['kubernetes networking'], technologies: [] })),
        };

        const result = await reenrichSkippedChunks(pool, enricher, { userId: 'u1', concurrency: 1 });

        expect(result).toEqual({ candidates: 2, enriched: 2, failed: 0, tier1Resolved: 0, newSkillsQueued: 0, stoppedEarly: false, remaining: 0 });
        expect((enricher.enrich as jest.Mock)).toHaveBeenCalledTimes(2);
        expect(updates).toHaveLength(2);
        expect(updates[0]).toEqual({ skills: ['kubernetes networking'], id: 'a' });
        // SELECT scoped to the user, status filter present
        const selectSql = query.mock.calls[0][0] as string;
        expect(selectSql).toMatch(/enrichment_status' IN \('skipped_quota', 'pending'\)/);
        expect(selectSql).toMatch(/user_id = \$1::uuid/);
        // UPDATE flips status to ok via jsonb_set
        const updateSql = query.mock.calls.find(c => (c[0] as string).includes('UPDATE'))?.[0] as string;
        expect(updateSql).toMatch(/jsonb_set/);
        expect(updateSql).toMatch(/"ok"/);
    });

    it('counts enricher failures and leaves those rows untouched (retryable)', async () => {
        const { pool, updates } = makePool(rows);
        const enricher: IChunkEnricher = {
            enrich: jest.fn()
                .mockResolvedValueOnce({ skills: ['cdk'], technologies: [] })
                .mockRejectedValueOnce(new Error('throttled')),
        };

        const result = await reenrichSkippedChunks(pool, enricher, { concurrency: 1 });

        expect(result.candidates).toBe(2);
        expect(result.enriched).toBe(1);
        expect(result.failed).toBe(1);
        expect(updates).toHaveLength(1); // only the successful one updated
    });

    it('stops dispatching at the deadline, leaving the rest pending (resumable)', async () => {
        const { pool, updates } = makePool(rows);
        // Deadline already in the past → no row should be dispatched.
        const enricher: IChunkEnricher = { enrich: jest.fn(async () => ({ skills: [], technologies: [] })) };

        const result = await reenrichSkippedChunks(pool, enricher, {
            concurrency: 1,
            deadlineMs: Date.now() - 1,
        });

        expect((enricher.enrich as jest.Mock)).not.toHaveBeenCalled();
        expect(updates).toHaveLength(0);
        expect(result).toEqual({ candidates: 2, enriched: 0, failed: 0, tier1Resolved: 0, newSkillsQueued: 0, stoppedEarly: true, remaining: 2 });
    });

    it('applies a limit clause when provided', async () => {
        const { pool, query } = makePool(rows);
        const enricher: IChunkEnricher = { enrich: jest.fn(async () => ({ skills: [], technologies: [] })) };
        await reenrichSkippedChunks(pool, enricher, { limit: 50 });
        expect(query.mock.calls[0][0] as string).toMatch(/LIMIT 50/);
    });

    it('ENRICH_CANONICAL: controlled-vocab path writes canonical skills + counts NEW: queue', async () => {
        const { pool, updates } = makePool(rows);
        const enrich = jest.fn(async () => ({ skills: ['raw-llm'], technologies: [] }));
        const enricher: IChunkEnricher = {
            enrich,
            enrichTextCanonical: jest.fn(async () => ({ canonical: ['kubernetes', 'argocd'], newSkills: ['webassembly'] })),
        };

        const result = await reenrichSkippedChunks(pool, enricher, { concurrency: 1, canonicalVocab: ['kubernetes', 'argocd'] });

        expect((enricher.enrichTextCanonical as jest.Mock)).toHaveBeenCalledTimes(2);  // both via controlled-vocab
        expect(enrich).not.toHaveBeenCalled();                                          // free-text LLM bypassed
        expect(updates[0]).toEqual({ skills: ['kubernetes', 'argocd'], id: 'a' });      // canonical written
        expect(result.newSkillsQueued).toBe(2);                                         // 1 NEW: x 2 chunks
    });

    it('Tier 1 resolves chunks with file_tech_stack deterministically — no LLM call', async () => {
        const tieredRows = [
            { id: 'a', file_path: 'infra/cdk.ts', heading: null, content: 'cdk app', file_tech_stack: ['aws_cdk'] },
            { id: 'b', file_path: 'docs/readme.md', heading: null, content: 'prose', file_tech_stack: null },
        ];
        const { pool, updates } = makePool(tieredRows);
        const enrich = jest.fn(async () => ({ skills: ['llm-skill'], technologies: [] }));
        const enricher: IChunkEnricher = { enrich };
        const tier1Map = new Map<string, readonly string[]>([['aws_cdk', ['aws cdk', 'infrastructure as code']]]);

        const result = await reenrichSkippedChunks(pool, enricher, { userId: 'u1', concurrency: 1, tier1Map });

        expect(result.tier1Resolved).toBe(1);                       // chunk a via Tier 1
        expect((enrich as jest.Mock)).toHaveBeenCalledTimes(1);     // only chunk b (no file_tech_stack) hit the LLM
        expect(updates.find((u) => u.id === 'a')?.skills).toEqual(['aws cdk', 'infrastructure as code']);
        expect(updates.find((u) => u.id === 'b')?.skills).toEqual(['llm-skill']);
        expect(result.enriched).toBe(2);
    });

    it('reenrichAll drops the status filter — re-processes every chunk (rollout)', async () => {
        const { pool, query } = makePool(rows);
        const enricher: IChunkEnricher = { enrich: jest.fn(async () => ({ skills: ['observability'], technologies: [] })) };
        await reenrichSkippedChunks(pool, enricher, { reenrichAll: true, repoFullName: 'o/r' });
        const selectSql = query.mock.calls[0][0] as string;
        expect(selectSql).not.toMatch(/enrichment_status/);  // no status gate
        expect(selectSql).toMatch(/repo_full_name = \$1/);     // still repo-scoped
    });
});
