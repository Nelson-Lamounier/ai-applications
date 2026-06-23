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

/**
 * Per-file harness: a pool whose SELECT returns rows carrying chunk_index +
 * content_hash, capturing every UPDATE so a test can assert which skills fanned
 * back to which chunk. Mirrors the real SELECT/UPDATE shape.
 */
function makePerFilePool(
    skippedRows: Array<{ id: string; file_path: string; heading: string | null; content: string; chunk_index: number; content_hash?: string | null; file_tech_stack?: string[] | null; embedding?: string | null }>,
) {
    const updates: Array<{ skills: string[]; id: string }> = [];
    const query = jest.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT') && sql.includes('document_embeddings')) {
            return { rows: skippedRows.map((r) => ({ content_hash: null, file_tech_stack: null, embedding: null, ...r })) };
        }
        if (sql.includes('UPDATE')) {
            updates.push({ skills: params?.[0] as string[], id: params?.[1] as string });
            return { rows: [] };
        }
        return { rows: [] };
    });
    return { pool: { query } as unknown as Pool, query, updates };
}

/**
 * Canonical enricher stub: enrichTextCanonical returns the given canonical skills
 * with no new-skills growth queue. Also provides enrichText so that perFileEnabled
 * returns true and the per-file batching path activates (which is the path the
 * embedding fan-back lane sits on). The canonical path takes precedence in enrichUnit
 * when canonicalVocab is set, so enrichText is never called in those tests.
 */
function makeCanonicalEnricher(canonical: string[]): IChunkEnricher {
    return {
        modelId: 'stub',
        enrichText: jest.fn(async () => ({ skills: canonical, technologies: [] })),
        enrichTextCanonical: jest.fn(async () => ({ canonical, newSkills: [] })),
    } as unknown as IChunkEnricher;
}

describe('reenrichSkippedChunks ENRICH_PER_FILE — Phase-B deadline remaining accounting', () => {
    afterEach(() => {
        delete process.env.ENRICH_PER_FILE;
        delete process.env.ENRICH_PER_FILE_MAX_CHARS;
        jest.restoreAllMocks();
    });

    /**
     * Regression: with the old code Phase A incremented `done` for every row
     * (including residue rows), so when a deadline cut Phase B mid-way the
     * un-run residue rows were already counted — `remaining` reported 0.
     * The fix: Phase A only counts rows it RESOLVES; Phase B counts rows when
     * their unit completes (success or failure).
     *
     * Technique: spy on Date.now() to simulate time advancing ONLY after Phase A
     * has fully processed all rows (returning them as residue) and then having
     * the clock tip past deadlineMs so Phase B unitWorker's first deadline check
     * fires and stops immediately. This isolates the Phase-B deadline cut.
     */
    it('ENRICH_PER_FILE=1 deadline trips in Phase-B: remaining > 0 and stoppedEarly === true', async () => {
        process.env.ENRICH_PER_FILE = '1';

        // Fix a stable "now" that is BEFORE the deadline, so Phase A's deadline
        // checks all pass. Then, when Phase B's unitWorker first calls deadlineReached(),
        // the clock has advanced past the deadline.
        const baseNow = 1_000_000;
        const deadlineMs = baseNow + 500;  // deadline 500 ms in the future from Phase A's perspective

        let callCount = 0;
        const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
            callCount += 1;
            // Phase A calls deadlineReached() once per row (4 rows) = first 4 calls.
            // Return a time BEFORE the deadline for those. After that (Phase B), return
            // a time PAST the deadline so the first unitWorker check fires.
            if (callCount <= 4) return baseNow;   // Phase A: deadline not yet reached
            return deadlineMs + 100;               // Phase B: deadline exceeded
        });

        const enricher = {
            modelId: 'haiku',
            enrichText: jest.fn(async () => ({ skills: ['kubernetes networking'], technologies: [] })),
        } as unknown as IChunkEnricher;

        // 4 rows across 2 files, no Tier-1/cache → ALL 4 are residue → 2 Phase-B units.
        const { pool } = makePerFilePool([
            { id: 'a1', file_path: 'a.ts', heading: null, content: 'uses kubernetes networking here', chunk_index: 0 },
            { id: 'a2', file_path: 'a.ts', heading: null, content: 'more kubernetes networking detail', chunk_index: 1 },
            { id: 'b1', file_path: 'b.ts', heading: null, content: 'kubernetes networking in b', chunk_index: 0 },
            { id: 'b2', file_path: 'b.ts', heading: null, content: 'more kubernetes in b', chunk_index: 1 },
        ]);

        const res = await reenrichSkippedChunks(pool, enricher, {
            userId: 'u1',
            concurrency: 1,
            deadlineMs,
        });

        dateNowSpy.mockRestore();

        expect(res.stoppedEarly).toBe(true);
        // Before the fix: Phase A incremented done for all 4 rows (including residue),
        // so remaining = 4 - 4 = 0 even though none were enriched.
        // After the fix: Phase A counts 0 (no cheap resolutions); Phase B counts 0
        // (no units dispatched); remaining = 4 - 0 = 4.
        expect(res.remaining).toBeGreaterThan(0);
        expect(res.enriched).toBe(0);
        expect((enricher.enrichText as jest.Mock)).not.toHaveBeenCalled();
    });

    it('ENRICH_PER_FILE=1 full run (no deadline): remaining === 0', async () => {
        process.env.ENRICH_PER_FILE = '1';
        const enricher = {
            modelId: 'haiku',
            enrichText: jest.fn(async () => ({ skills: ['kubernetes networking'], technologies: [] })),
        } as unknown as IChunkEnricher;
        const { pool } = makePerFilePool([
            { id: 'a1', file_path: 'a.ts', heading: null, content: 'uses kubernetes networking here', chunk_index: 0 },
            { id: 'a2', file_path: 'a.ts', heading: null, content: 'more kubernetes networking detail', chunk_index: 1 },
            { id: 'b1', file_path: 'b.ts', heading: null, content: 'kubernetes networking in b', chunk_index: 0 },
        ]);
        const res = await reenrichSkippedChunks(pool, enricher, { userId: 'u1', concurrency: 1 });

        expect(res.stoppedEarly).toBe(false);
        expect(res.remaining).toBe(0);
        expect(res.enriched).toBe(3);
    });
});

describe('reenrichSkippedChunks ENRICH_PER_FILE residue batching', () => {
    afterEach(() => { delete process.env.ENRICH_PER_FILE; delete process.env.ENRICH_PER_FILE_MAX_CHARS; });

    it('ENRICH_PER_FILE=1: makes one LLM call per file-unit, not per chunk', async () => {
        process.env.ENRICH_PER_FILE = '1';
        const calls: string[] = [];
        const enricher = {
            modelId: 'haiku',
            enrichText: async (filePath: string) => { calls.push(filePath); return { skills: ['kubernetes networking'], technologies: [] }; },
        } as unknown as IChunkEnricher;
        const { pool, updates } = makePerFilePool([
            { id: 'a1', file_path: 'a.ts', heading: null, content: 'uses kubernetes networking here', chunk_index: 0 },
            { id: 'a2', file_path: 'a.ts', heading: null, content: 'more kubernetes networking detail', chunk_index: 1 },
            { id: 'b1', file_path: 'b.ts', heading: null, content: 'kubernetes networking in b', chunk_index: 0 },
        ]);
        const res = await reenrichSkippedChunks(pool, enricher, { userId: 'u1', repoFullName: 'me/r', dedupCache: false, deadlineMs: Date.now() + 60_000 });
        expect(calls.length).toBe(2);          // one call per FILE (a.ts, b.ts), not 3
        expect(res.enriched).toBe(3);          // all 3 chunks written
        expect(updates).toHaveLength(3);
    });

    it('ENRICH_PER_FILE=1: fans a skill back only to chunks whose content surface-matches it', async () => {
        process.env.ENRICH_PER_FILE = '1';
        const enricher = {
            modelId: 'haiku',
            enrichText: async () => ({ skills: ['kubernetes networking'], technologies: [] }),
        } as unknown as IChunkEnricher;
        const { pool, updates } = makePerFilePool([
            { id: 'a1', file_path: 'a.ts', heading: null, content: 'this chunk mentions kubernetes networking', chunk_index: 0 },
            { id: 'a2', file_path: 'a.ts', heading: null, content: 'this chunk is about something else', chunk_index: 1 },
        ]);
        await reenrichSkippedChunks(pool, enricher, { userId: 'u1', deadlineMs: Date.now() + 60_000 });
        expect(updates.find((u) => u.id === 'a1')?.skills).toEqual(['kubernetes networking']);
        expect(updates.find((u) => u.id === 'a2')?.skills).toEqual([]);   // no surface match → []
    });

    it('ENRICH_PER_FILE=1: Tier-1 + cache chunks are resolved with NO LLM call (residue-only)', async () => {
        process.env.ENRICH_PER_FILE = '1';
        const calls: string[] = [];
        const enricher = {
            modelId: 'haiku',
            enrichText: async (filePath: string) => { calls.push(filePath); return { skills: ['residue skill'], technologies: [] }; },
        } as unknown as IChunkEnricher;
        const { pool, updates } = makePerFilePool([
            { id: 't1', file_path: 'infra/cdk.ts', heading: null, content: 'cdk app', chunk_index: 0, file_tech_stack: ['aws_cdk'] },
            { id: 'r1', file_path: 'src/x.ts', heading: null, content: 'plain prose with residue skill', chunk_index: 0, file_tech_stack: null },
        ]);
        const tier1Map = new Map<string, readonly string[]>([['aws_cdk', ['aws cdk']]]);
        const res = await reenrichSkippedChunks(pool, enricher, { userId: 'u1', tier1Map, deadlineMs: Date.now() + 60_000 });
        expect(calls.length).toBe(1);                                 // only the residue chunk hit the LLM
        expect(res.tier1Resolved).toBe(1);
        expect(updates.find((u) => u.id === 't1')?.skills).toEqual(['aws cdk']);
        expect(updates.find((u) => u.id === 'r1')?.skills).toEqual(['residue skill']);
        expect(res.enriched).toBe(2);
    });
});

describe('reenrichSkippedChunks WS5 content-hash dedup', () => {
    it('copies cached skills for a known content_hash — no LLM call', async () => {
        const updates: Array<{ skills: string[]; id: string }> = [];
        // Connect-capable fake: main query returns the chunk; the dedicated client
        // returns a cache hit for content_hash 'h1'.
        const client = {
            query: jest.fn(async (sql: string) => {
                if (sql.includes('chunk_enrichment_cache') && sql.includes('SELECT')) {
                    return { rows: [{ content_hash: 'h1', skills: ['cached:kubernetes'] }] };
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

    it('scopes the cache by method: canonical uses a #canon: model key (no free-text cross-contamination)', async () => {
        let cacheLookupModel = '';
        const client = {
            query: jest.fn(async (sql: string, p?: unknown[]) => {
                if (sql.includes('chunk_enrichment_cache') && sql.includes('SELECT')) { cacheLookupModel = p?.[1] as string; return { rows: [] }; }
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

        expect(cacheLookupModel).toBe('haiku#canon:2');   // method + vocab-size scoped, NOT plain 'haiku'
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

describe('ENRICH_PER_FILE embedding fan-back', () => {
    const prev = process.env.ENRICH_PER_FILE;
    afterEach(() => { process.env.ENRICH_PER_FILE = prev; });

    it('recovers a non-surface-matching skill via skillVectorLookup', async () => {
        process.env.ENRICH_PER_FILE = '1';
        // Two residue chunks of one file. The canonical enricher returns the
        // unit skill 'aws auto scaling' which does NOT appear verbatim in chunk 0's
        // text, but chunk 0's embedding is vector-close to the skill's.
        const { pool, updates } = makePerFilePool([
            { id: 'c0', file_path: 'infra/asg.tf', heading: null, content: 'resource scaling group desired 3', chunk_index: 0, content_hash: null, file_tech_stack: null, embedding: '[1,0]' },
            { id: 'c1', file_path: 'infra/asg.tf', heading: null, content: 'unrelated prose', chunk_index: 1, content_hash: null, file_tech_stack: null, embedding: '[0,1]' },
        ]);
        const enricher = makeCanonicalEnricher(['aws auto scaling']);
        const skillVectorLookup = async (names: readonly string[]) =>
            new Map(names.includes('aws auto scaling') ? [['aws auto scaling', [1, 0]]] : []);

        await reenrichSkippedChunks(pool, enricher, {
            canonicalVocab: ['aws auto scaling'],
            skillVectorLookup,
            fanbackThreshold: 0.8,
        });

        const c0 = updates.find((w) => w.id === 'c0');
        const c1 = updates.find((w) => w.id === 'c1');
        expect(c0?.skills).toEqual(['aws auto scaling']); // recovered by cosine([1,0],[1,0])=1
        expect(c1?.skills).toEqual([]);                    // cosine([1,0],[0,1])=0 < 0.8, no surface match
    });

    it('without skillVectorLookup, behaves exactly as surface-match-only (today)', async () => {
        process.env.ENRICH_PER_FILE = '1';
        const { pool, updates } = makePerFilePool([
            { id: 'c0', file_path: 'infra/asg.tf', heading: null, content: 'resource scaling group desired 3', chunk_index: 0, content_hash: null, file_tech_stack: null, embedding: '[1,0]' },
        ]);
        const enricher = makeCanonicalEnricher(['aws auto scaling']);
        await reenrichSkippedChunks(pool, enricher, { canonicalVocab: ['aws auto scaling'] });
        expect(updates.find((w) => w.id === 'c0')?.skills).toEqual([]); // no surface match, no vectors -> dropped
    });
});
