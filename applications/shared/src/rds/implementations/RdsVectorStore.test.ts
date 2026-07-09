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
        expect(sql).toMatch(/\$14::vector,\$15,NOW\(\)\),\(\$16/); // two value tuples (15 cols/row)
        expect(values).toHaveLength(30); // 2 rows × 15 params
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
        expect(values).toHaveLength(15);     // one row after dedupe (15 cols)
        expect(values).toContain('h2');      // last wins
        expect(res.inserted + res.updated).toBe(1);
    });

    it('dual-writes the injected github_repo_id (COALESCE on conflict, last param/row)', async () => {
        const query = jest.fn(async () => ({ rows: [{ was_inserted: true }] }));
        const pool = { query } as unknown as Pool;
        const vs = new RdsVectorStore(
            { host: 'h', port: 5432, database: 'd', user: 'u', password: 'p' },
            pool,
            4242,
        );
        await vs.upsertBatch([chunk({ filePath: 'a.ts' })]);
        const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
        expect(sql).toMatch(/github_repo_id/);
        expect(sql).toMatch(/COALESCE\(EXCLUDED\.github_repo_id, document_embeddings\.github_repo_id\)/);
        expect(values.at(-1)).toBe(4242); // github_repo_id is each tuple's last param
    });

    it('binds null github_repo_id on a pre-backfill run (default)', async () => {
        const query = jest.fn(async () => ({ rows: [{ was_inserted: true }] }));
        const res = await store(query).upsertBatch([chunk({ filePath: 'a.ts' })]);
        const [, values] = query.mock.calls[0] as unknown as [string, unknown[]];
        expect(values.at(-1)).toBeNull();
        expect(res.inserted).toBe(1);
    });

    it('stamps the run commit_sha into metadata (source provenance), preserving existing keys', async () => {
        const query = jest.fn(async () => ({ rows: [{ was_inserted: true }] }));
        const pool = { query } as unknown as Pool;
        const vs = new RdsVectorStore(
            { host: 'h', port: 5432, database: 'd', user: 'u', password: 'p' },
            pool, 4242, 'commitabc',
        );
        await vs.upsertBatch([chunk({ filePath: 'a.ts', metadata: { lineStart: 1, lineEnd: 9 } })]);
        const [, values] = query.mock.calls[0] as unknown as [string, unknown[]];
        const metadata = JSON.parse(values[7] as string) as Record<string, unknown>;
        expect(metadata).toEqual({ lineStart: 1, lineEnd: 9, commit_sha: 'commitabc' });
    });

    it('does not add commit_sha when none is injected (default run)', async () => {
        const query = jest.fn(async () => ({ rows: [{ was_inserted: true }] }));
        await store(query).upsertBatch([chunk({ filePath: 'a.ts', metadata: { lineStart: 1 } })]);
        const [, values] = query.mock.calls[0] as unknown as [string, unknown[]];
        const metadata = JSON.parse(values[7] as string) as Record<string, unknown>;
        expect(metadata).not.toHaveProperty('commit_sha');
    });

    it('stamps embedding/enrichment lineage into metadata.lineage', async () => {
        const query = jest.fn(async () => ({ rows: [{ was_inserted: true }] }));
        const pool = { query } as unknown as Pool;
        const lineage = { embedding_model: 'titan-v2', embedding_dim: 1024, enrichment_model: 'haiku' };
        const vs = new RdsVectorStore(
            { host: 'h', port: 5432, database: 'd', user: 'u', password: 'p' },
            pool, null, null, lineage,
        );
        await vs.upsertBatch([chunk({ filePath: 'a.ts', metadata: { lineStart: 1 } })]);
        const [, values] = query.mock.calls[0] as unknown as [string, unknown[]];
        const metadata = JSON.parse(values[7] as string) as Record<string, unknown>;
        expect(metadata).toEqual({ lineStart: 1, lineage });
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

describe('RdsVectorStore.toCroissant', () => {
    it('builds a Croissant data card from the aggregated chunk corpus', async () => {
        const query = jest.fn(async () => ({ rows: [{
            record_count: 200,
            skills: ['kubernetes networking', 'gitops'],
            commit_sha: 'abc123',
            lineage: { embedding_model: 'titan-v2', embedding_dim: 1024, enrichment_model: 'haiku' },
        }] }));
        const ds = await store(query).toCroissant('u1', 'o/r');

        const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
        expect(sql).toMatch(/FROM document_embeddings/);
        expect(params).toEqual(['u1', 'o/r']);
        expect(ds.conformsTo).toBe('http://mlcommons.org/croissant/1.0');
        expect(ds.name).toBe('rag-kb-o-r');
        expect(ds.version).toBe('abc123');
        expect(ds.keywords).toEqual(['kubernetes networking', 'gitops']);
        expect(ds.description).toContain('200 chunks');
        expect(ds.description).toContain('titan-v2 (1024d)');
    });

    it('produces a valid empty data card when the repo has no chunks', async () => {
        const query = jest.fn(async () => ({ rows: [{ record_count: 0, skills: null, commit_sha: null, lineage: null }] }));
        const ds = await store(query).toCroissant('u1', 'o/r');
        expect(ds.recordSet[0]?.name).toBe('chunks');
        expect(ds).not.toHaveProperty('version');
        expect(ds.description).toContain('0 chunks');
    });
});

describe('RdsVectorStore.querySimilar (filter-then-rank)', () => {
    const simRow = (over: Record<string, unknown> = {}) => ({
        id: 'id1', repo_full_name: 'o/r', file_path: 'a.ts', heading: null,
        content: 'x', chunk_index: 0, tags: [], similarity: 0.9, cosine: 0.9, ...over,
    });

    it('gates tech by chunk TYPE: file-grained for code/config, prose exempt, config-without-evidence excluded', async () => {
        const query = jest.fn(async () => ({ rows: [simRow()] }));
        await store(query).querySimilar({
            userId: 'u1', queryEmbedding: [0.1, 0.2], limit: 5,
            prefilter: { skills: ['python'], tech: ['openai_api'], minResults: 1 },
        });

        // minResults=1 satisfied by the single row → pass-2 top-up never runs.
        expect(query).toHaveBeenCalledTimes(1);
        const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
        // file-grained tech gate for chunks WITH evidence…
        expect(sql).toMatch(/metadata->'file_tech_stack' \?\| \$7::text\[\]/);
        // …and chunks WITHOUT file evidence pass UNLESS they are a config file (the
        // config-extension exclusion that stops a YAML free-riding its repo stack).
        expect(sql).toMatch(/NOT \(d\.metadata \? 'file_tech_stack'\)/);
        expect(sql).toContain("d.file_path !~* '\\.(ya?ml|json|toml|lock|cfg|ini|env|tf|tfvars)$'");
        // the broken repo-grained fallback must be GONE (it admitted any chunk of a
        // repo that used a JD tech anywhere — the prose-gating + config-leak bug).
        // Assert the metadata ACCESS is gone (a comment may still name the old field).
        expect(sql).not.toMatch(/metadata->'repo_tech_stack'/);
        expect(sql).not.toMatch(/repo_tech_stack' \?\|/);
        // hard authorship gates still present.
        expect(sql).toMatch(/COALESCE\(\(d\.metadata->>'is_fork'\)::bool, false\) = false/);
        // applySoft=true on pass 1; $7 carries skills ∪ tech; skills lane defaults on ($9).
        expect(values[5]).toBe(true);
        expect(values[6]).toEqual(['python', 'openai_api']);
        expect(values[8]).toBe(true);
    });

    it('skips the enriched-skills admitter when prefilter.skillsLane=false (enrichment A/B leg)', async () => {
        const query = jest.fn(async () => ({ rows: [simRow()] }));
        await store(query).querySimilar({
            userId: 'u1', queryEmbedding: [0.1, 0.2], limit: 5,
            prefilter: { skills: ['python'], tech: ['openai_api'], minResults: 1, skillsLane: false },
        });
        const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
        // The admitter is parameterised, not removed — deterministic lanes unchanged.
        expect(sql).toMatch(/\$9::bool AND d\.skills && \$7::text\[\]/);
        expect(values[8]).toBe(false);
        expect(sql).toMatch(/metadata->'file_tech_stack' \?\| \$7::text\[\]/);
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

describe('RdsVectorStore.pruneDeletedFiles (commit-history lane)', () => {
    it('excludes _commits/ synthetic paths from tree-based pruning', async () => {
        const query = jest.fn(async () => ({ rowCount: 2, rows: [] }));
        const n = await store(query).pruneDeletedFiles('u1', 'o/r', ['a.ts', 'b.md']);

        expect(n).toBe(2);
        const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
        expect(sql).toMatch(/NOT starts_with\(file_path, \$3\)/);
        expect(sql).toMatch(/file_path NOT IN \(\$4, \$5\)/);
        expect(values).toEqual(['u1', 'o/r', '_commits/', 'a.ts', 'b.md']);
    });

    it('still deletes the whole repo (commit lane included) on an empty whitelist', async () => {
        const query = jest.fn(async () => ({ rowCount: 7, rows: [] }));
        const n = await store(query).pruneDeletedFiles('u1', 'o/r', []);

        expect(n).toBe(7);
        const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
        expect(sql).not.toMatch(/starts_with/);
        expect(sql).toMatch(/DELETE FROM document_embeddings/);
        expect(values).toEqual(['u1', 'o/r']);
    });
});
