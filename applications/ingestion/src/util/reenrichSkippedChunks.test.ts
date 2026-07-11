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

describe('reenrichSkippedChunks WS5 content-hash dedup', () => {
    it('copies cached skills for a known content_hash — no LLM call', async () => {
        const updates: Array<{ skills: string[]; id: string }> = [];
        // The composite key for raw hash 'h1' with model 'haiku' is 'h1#haiku'.
        // The cache DB returns the row keyed by that composite key, and the lookup
        // in processRow also builds the composite key — so they match and we get a hit.
        const client = {
            query: jest.fn(async (sql: string) => {
                if (sql.includes('chunk_enrichment_cache') && sql.includes('SELECT')) {
                    return { rows: [{ content_hash: 'h1#haiku', skills: ['cached:kubernetes'] }] };
                }
                return { rows: [] };   // set_config, INSERT, BEGIN/COMMIT
            }),
            release: jest.fn(),
        };
        const pool = {
            query: jest.fn(async (sql: string, params?: unknown[]) => {
                if (sql.includes('SELECT') && sql.includes('document_embeddings')) {
                    return { rows: [{ id: 'a', file_path: 'x.ts', heading: null, content: 'k8s', content_hash: 'h1', file_tech_stack: null }] };
                }
                if (sql.includes('UPDATE')) { updates.push({ skills: params?.[0] as string[], id: params?.[1] as string }); return { rows: [] }; }
                return { rows: [] };
            }),
            connect: jest.fn(async () => client),
        } as unknown as Pool;

        const enrich = jest.fn(async () => ({ skills: ['fresh'], technologies: [] }));
        const enricher: IChunkEnricher = { modelId: 'haiku', enrich };

        const result = await reenrichSkippedChunks(pool, enricher, { userId: 'u1', concurrency: 1, dedupCache: true });

        expect(enrich).not.toHaveBeenCalled();                       // LLM skipped — the whole point
        expect(result.cacheHits).toBe(1);
        expect(updates[0]).toEqual({ skills: ['cached:kubernetes'], id: 'a' });  // cached skills copied
    });

    it('scopes the cache by method: canonical uses a #canon: composite key (no free-text cross-contamination)', async () => {
        let cacheLookupKeys: string[] = [];
        const client = {
            query: jest.fn(async (sql: string, p?: unknown[]) => {
                // $2 is now the composite-key array, not a model_id string.
                if (sql.includes('chunk_enrichment_cache') && sql.includes('SELECT')) { cacheLookupKeys = p?.[1] as string[]; return { rows: [] }; }
                return { rows: [] };
            }),
            release: jest.fn(),
        };
        const pool = {
            query: jest.fn(async (sql: string) => sql.includes('document_embeddings')
                ? { rows: [{ id: 'a', file_path: 'x.ts', heading: null, content: 'k8s', content_hash: 'h1', file_tech_stack: null }] }
                : { rows: [] }),
            connect: jest.fn(async () => client),
        } as unknown as Pool;
        const enricher: IChunkEnricher = {
            modelId: 'haiku',
            enrich: jest.fn(async () => ({ skills: [], technologies: [] })),
            enrichTextCanonical: jest.fn(async () => ({ canonical: ['kubernetes'], newSkills: [] })),
        };

        await reenrichSkippedChunks(pool, enricher, { userId: 'u1', concurrency: 1, dedupCache: true, canonicalVocab: ['kubernetes', 'terraform'] });

        // The composite key folds model + vocab-size into the content_hash column value.
        // A plain-model run would look up 'h1#haiku'; a canonical run looks up 'h1#haiku#canon:2'.
        // These are different rows in the DB, so canonical and free-text can never cross-contaminate.
        expect(cacheLookupKeys).toEqual(['h1#haiku#canon:2']);
    });
});

describe('reenrichSkippedChunks', () => {
    it('enriches each skipped chunk and flips status to ok', async () => {
        const { pool, query, updates } = makePool(rows);
        const enricher: IChunkEnricher = {
            enrich: jest.fn(async () => ({ skills: ['kubernetes networking'], technologies: [] })),
        };

        const result = await reenrichSkippedChunks(pool, enricher, { userId: 'u1', concurrency: 1 });

        expect(result).toEqual({ candidates: 2, enriched: 2, failed: 0, tier1Resolved: 0, newSkillsQueued: 0, cacheHits: 0, stoppedEarly: false, remaining: 0 });
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
        expect(result).toEqual({ candidates: 2, enriched: 0, failed: 0, tier1Resolved: 0, newSkillsQueued: 0, cacheHits: 0, stoppedEarly: true, remaining: 2 });
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

describe('reenrichSkippedChunks — canonical packing (deferred lane)', () => {
    const vocab = ['kubernetes', 'argocd'];

    it('resolves the whole residue with ONE pack call instead of per-chunk calls', async () => {
        const { pool, updates } = makePool(rows);
        const enrichTextCanonical = jest.fn(async () => ({ canonical: ['fallback'], newSkills: [] }));
        const enrichPackCanonical = jest.fn(async (_v: readonly string[], items: ReadonlyArray<{ key: string }>) =>
            new Map(items.map((it) => [it.key, { canonical: ['kubernetes'], newSkills: ['webassembly'] }])),
        );
        const enricher: IChunkEnricher = {
            enrich: jest.fn(async () => ({ skills: [], technologies: [] })),
            enrichTextCanonical,
            enrichPackCanonical,
        };

        const result = await reenrichSkippedChunks(pool, enricher, {
            concurrency: 1, canonicalVocab: vocab, packSize: 10,
        });

        expect(enrichPackCanonical).toHaveBeenCalledTimes(1);      // one call for both chunks
        expect(enrichTextCanonical).not.toHaveBeenCalled();        // no per-chunk residue calls
        expect(updates).toHaveLength(2);
        expect(updates[0].skills).toEqual(['kubernetes']);
        expect(result.enriched).toBe(2);
        expect(result.newSkillsQueued).toBe(2);                    // 1 NEW: per chunk
        expect(result.remaining).toBe(0);
    });

    it('falls a key the model skipped back to per-chunk canonical (fail-safe)', async () => {
        const { pool, updates } = makePool(rows);
        // Pack answers only chunk 'a'; chunk 'b' must be retried per-chunk.
        const enrichPackCanonical = jest.fn(async () => new Map([['a', { canonical: ['kubernetes'], newSkills: [] }]]));
        const enrichTextCanonical = jest.fn(async () => ({ canonical: ['argocd'], newSkills: [] }));
        const enricher: IChunkEnricher = {
            enrich: jest.fn(async () => ({ skills: [], technologies: [] })),
            enrichTextCanonical,
            enrichPackCanonical,
        };

        const result = await reenrichSkippedChunks(pool, enricher, {
            concurrency: 1, canonicalVocab: vocab, packSize: 10,
        });

        expect(enrichTextCanonical).toHaveBeenCalledTimes(1);
        expect(updates.find((u) => u.id === 'a')?.skills).toEqual(['kubernetes']);
        expect(updates.find((u) => u.id === 'b')?.skills).toEqual(['argocd']);
        expect(result.enriched).toBe(2);
    });

    it('falls the WHOLE pack back to per-chunk when the pack call throws', async () => {
        const { pool, updates } = makePool(rows);
        const enrichPackCanonical = jest.fn(async () => { throw new Error('transport'); });
        const enrichTextCanonical = jest.fn(async () => ({ canonical: ['kubernetes'], newSkills: [] }));
        const enricher: IChunkEnricher = {
            enrich: jest.fn(async () => ({ skills: [], technologies: [] })),
            enrichTextCanonical,
            enrichPackCanonical,
        };

        const result = await reenrichSkippedChunks(pool, enricher, {
            concurrency: 1, canonicalVocab: vocab, packSize: 10,
        });

        expect(enrichTextCanonical).toHaveBeenCalledTimes(2);      // every row retried per-chunk
        expect(updates).toHaveLength(2);
        expect(result.enriched).toBe(2);
        expect(result.failed).toBe(0);
    });

    it('packSize absent keeps the per-chunk path exactly as before', async () => {
        const { pool } = makePool(rows);
        const enrichPackCanonical = jest.fn();
        const enrichTextCanonical = jest.fn(async () => ({ canonical: ['kubernetes'], newSkills: [] }));
        const enricher: IChunkEnricher = {
            enrich: jest.fn(async () => ({ skills: [], technologies: [] })),
            enrichTextCanonical,
            enrichPackCanonical,
        };

        await reenrichSkippedChunks(pool, enricher, { concurrency: 1, canonicalVocab: vocab });

        expect(enrichPackCanonical).not.toHaveBeenCalled();
        expect(enrichTextCanonical).toHaveBeenCalledTimes(2);
    });

    it('a deadline hit before the pack phase leaves the residue pending (remaining > 0)', async () => {
        const { pool, updates } = makePool(rows);
        const enrichPackCanonical = jest.fn();
        const enricher: IChunkEnricher = {
            enrich: jest.fn(async () => ({ skills: [], technologies: [] })),
            enrichTextCanonical: jest.fn(async () => ({ canonical: [], newSkills: [] })),
            enrichPackCanonical,
        };
        // Row workers defer both rows to the pack phase; the pack phase's own
        // deadline check then refuses to dispatch.
        const result = await reenrichSkippedChunks(pool, enricher, {
            concurrency: 1, canonicalVocab: vocab, packSize: 10,
            deadlineMs: Date.now() - 1,
        });

        expect(enrichPackCanonical).not.toHaveBeenCalled();
        expect(updates).toHaveLength(0);
        expect(result.stoppedEarly).toBe(true);
        expect(result.remaining).toBe(2);
    });
});

describe('reenrichSkippedChunks — Tier-1-only (no enricher)', () => {
    it('applies deterministic Tier-1 skills and makes NO LLM call when enricher is absent', async () => {
        const captured = { updates: [] as unknown[] };
        const fakePool = {
            query: async (sql: string, params?: unknown[]) => {
                if (/SELECT .*file_tech_stack|FROM document_embeddings/i.test(sql)) {
                    return { rows: [{ id: 'c1', file_path: 'a.ts', content: 'x', heading: null, file_tech_stack: ['kubernetes'], content_hash: 'h1' }] };
                }
                if (/UPDATE document_embeddings/i.test(sql)) { captured.updates.push(params); return { rowCount: 1, rows: [] }; }
                return { rows: [] };
            },
        } as never;

        const tier1Map = new Map<string, readonly string[]>([['kubernetes', ['kubernetes networking']]]);
        // enricher omitted entirely — must not throw, must not call any LLM.
        const result = await reenrichSkippedChunks(fakePool, undefined, {
            userId: 'u1', repoFullName: 'me/r', tier1Map, dedupCache: false, deadlineMs: Date.now() + 60_000,
        });

        expect(result.tier1Resolved ?? result.enriched ?? 0).toBeGreaterThanOrEqual(1); // Tier-1 skills resolved
        expect(captured.updates.length).toBeGreaterThan(0);                              // Tier-1 skills written
    });
});
