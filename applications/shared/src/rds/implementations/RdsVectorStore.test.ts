/** @format */
import { RdsVectorStore } from './RdsVectorStore.js';
import type { Pool } from 'pg';
import type { DocumentChunk } from '../types.js';

function chunk(over: Partial<DocumentChunk> = {}): DocumentChunk {
    return {
        userId: 'u1', repoFullName: 'o/r', filePath: 'a.ts', heading: null,
        content: 'x', fileType: 'ts', tags: [], chunkIndex: 0, totalChunks: 1,
        metadata: {}, skills: [], technologies: [],
        contentHash: 'h0', embedding: [0.1, 0.2],
        ...over,
    } as DocumentChunk;
}

function store(query: jest.Mock): RdsVectorStore {
    const pool = { query } as unknown as Pool;
    return new RdsVectorStore({ host: 'h', port: 5432, database: 'd', user: 'u', password: 'p' }, pool);
}

describe('RdsVectorStore.upsertBatch (multi-row)', () => {
    it('issues ONE multi-row INSERT per sub-batch and counts inserts/updates', async () => {
        const query = jest.fn(async () => ({ rows: [{ was_inserted: true }, { was_inserted: false }] }));
        const res = await store(query).upsertBatch([chunk({ filePath: 'a.ts' }), chunk({ filePath: 'b.ts' })]);

        expect(query).toHaveBeenCalledTimes(1);
        const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
        expect(sql).toMatch(/INSERT INTO document_embeddings/);
        expect(sql).toMatch(/\$14::vector,NOW\(\)\),\(\$15/); // two value tuples
        expect(values).toHaveLength(28); // 2 rows × 14 params
        expect(res).toEqual({ inserted: 1, updated: 1, skipped: 0, errors: 0 });
    });

    it('counts skipped = batch − returned (unchanged content_hash filtered by WHERE)', async () => {
        const query = jest.fn(async () => ({ rows: [{ was_inserted: true }] })); // 1 of 2 returned
        const res = await store(query).upsertBatch([chunk({ filePath: 'a.ts' }), chunk({ filePath: 'b.ts' })]);
        expect(res).toEqual({ inserted: 1, updated: 0, skipped: 1, errors: 0 });
    });

    it('dedupes duplicate conflict keys, keeping the last occurrence', async () => {
        const query = jest.fn(async () => ({ rows: [{ was_inserted: true }] }));
        const res = await store(query).upsertBatch([
            chunk({ filePath: 'a.ts', chunkIndex: 0, contentHash: 'h1' }),
            chunk({ filePath: 'a.ts', chunkIndex: 0, contentHash: 'h2' }),
        ]);
        const [, values] = query.mock.calls[0] as unknown as [string, unknown[]];
        expect(values).toHaveLength(14);     // one row after dedupe
        expect(values).toContain('h2');      // last wins
        expect(res.inserted + res.updated).toBe(1);
    });

    it('splits into multiple INSERTs above UPSERT_BATCH_SIZE (200)', async () => {
        const query = jest.fn(async () => ({ rows: [] }));
        const chunks = Array.from({ length: 250 }, (_, i) => chunk({ filePath: `f${i}.ts` }));
        await store(query).upsertBatch(chunks);
        expect(query).toHaveBeenCalledTimes(2); // 200 + 50
    });

    it('falls back to per-row when a batch INSERT throws', async () => {
        const query = jest.fn()
            .mockRejectedValueOnce(new Error('batch boom'))      // multi-row attempt
            .mockResolvedValue({ rows: [{ was_inserted: true }] }); // per-row retries
        const res = await store(query).upsertBatch([chunk({ filePath: 'a.ts' }), chunk({ filePath: 'b.ts' })]);
        expect(query).toHaveBeenCalledTimes(3); // 1 batch + 2 per-row
        expect(res).toEqual({ inserted: 2, updated: 0, skipped: 0, errors: 0 });
    });

    it('returns zero for an empty batch without querying', async () => {
        const query = jest.fn();
        const res = await store(query).upsertBatch([]);
        expect(query).not.toHaveBeenCalled();
        expect(res).toEqual({ inserted: 0, updated: 0, skipped: 0, errors: 0 });
    });
});

describe('RdsVectorStore.querySimilar (filter-then-rank)', () => {
    const simRow = (over: Record<string, unknown> = {}) => ({
        id: 'id1', repo_full_name: 'o/r', file_path: 'a.ts', heading: null,
        content: 'x', chunk_index: 0, tags: [], similarity: 0.9, cosine: 0.9, ...over,
    });

    it('routes to the filtered path when a prefilter is present and gates tech FILE-grained with a repo fallback', async () => {
        const query = jest.fn(async () => ({ rows: [simRow()] }));
        await store(query).querySimilar({
            userId: 'u1', queryEmbedding: [0.1, 0.2], limit: 5,
            prefilter: { skills: ['python'], tech: ['openai_api'], minResults: 1 },
        });

        // minResults=1 satisfied by the single row → pass-2 top-up never runs.
        expect(query).toHaveBeenCalledTimes(1);
        const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
        // file-grained tech preferred…
        expect(sql).toMatch(/metadata->'file_tech_stack' \?\| \$7::text\[\]/);
        // …with repo_tech_stack as the fallback ONLY for chunks lacking file evidence.
        expect(sql).toMatch(/NOT \(d\.metadata \? 'file_tech_stack'\)/);
        // hard authorship gates still present.
        expect(sql).toMatch(/COALESCE\(\(d\.metadata->>'is_fork'\)::bool, false\) = false/);
        // applySoft=true on pass 1; $7 carries skills ∪ tech.
        expect(values[5]).toBe(true);
        expect(values[6]).toEqual(['python', 'openai_api']);
    });

    it('tops up from the hard-gated-only set (soft relaxed) when pass 1 under-fills minResults', async () => {
        const query = jest.fn()
            .mockResolvedValueOnce({ rows: [simRow({ id: 'p1' })] })           // pass 1 (soft): 1 < minResults 3
            .mockResolvedValueOnce({ rows: [simRow({ id: 't1' }), simRow({ id: 't2' })] }); // pass 2 top-up
        const res = await store(query).querySimilar({
            userId: 'u1', queryEmbedding: [0.1, 0.2], limit: 3,
            prefilter: { skills: [], tech: ['openai_api'], minResults: 3 },
        });

        expect(query).toHaveBeenCalledTimes(2);
        const [, p2vals] = query.mock.calls[1] as unknown as [string, unknown[]];
        expect(p2vals[5]).toBe(false);              // applySoft=false on the top-up
        expect(p2vals[7]).toEqual(['p1']);          // excludeIds = pass-1 results
        expect(res.map((r) => r.id)).toEqual(['p1', 't1', 't2']);
    });

    it('does NOT use the filtered path when no prefilter is supplied (fail-open to pure vector)', async () => {
        const query = jest.fn(async () => ({ rows: [simRow()] }));
        await store(query).querySimilar({ userId: 'u1', queryEmbedding: [0.1, 0.2] });
        const [sql] = query.mock.calls[0] as unknown as [string, unknown[]];
        expect(sql).not.toMatch(/file_tech_stack/);
    });
});
