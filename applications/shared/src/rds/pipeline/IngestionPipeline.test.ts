/**
 * @format
 * IngestionPipeline — enrichment behaviour
 *
 * Focused on the new IChunkEnricher integration added by pick #2 of the
 * Tucaken-product roadmap. The rest of the pipeline (hash-skip, embed,
 * upsert, prune) is exercised by integration tests elsewhere.
 */

import { IngestionPipeline } from './IngestionPipeline.js';
import type { IChunkEnricher, ChunkEnrichment } from '../interfaces/IChunkEnricher.js';
import type { IEmbeddingProvider } from '../interfaces/IEmbeddingProvider.js';
import type { ISyncStateRepository } from '../interfaces/ISyncStateRepository.js';
import type { IVectorStore } from '../interfaces/IVectorStore.js';
import type { IRetrievalProbe, RetrievalBreakdown } from '../quality/retrievalProbe.js';
import type {
    ChunkIdentity,
    DocumentChunk,
    HashCheckResult,
    QueryParams,
    RawChunk,
    SimilarityResult,
    UpsertBatchResult,
} from '../types.js';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { trace, context } from '@opentelemetry/api';
import { jest } from '@jest/globals';

// =============================================================================
// FAKES
// =============================================================================

class FakeVectorStore implements IVectorStore {
    public upserts: DocumentChunk[][] = [];

    async upsertBatch(chunks: DocumentChunk[]): Promise<UpsertBatchResult> {
        this.upserts.push(chunks);
        return { inserted: chunks.length, updated: 0, skipped: 0, errors: 0 };
    }

    async checkContentHashes(
        _userId: string,
        _repoFullName: string,
        candidates: ChunkIdentity[],
    ): Promise<HashCheckResult> {
        // All candidates considered missing → enrichment runs on every chunk.
        return { missing: candidates, stale: [], unchanged: [] };
    }

    async querySimilar(_p: QueryParams): Promise<SimilarityResult[]> { return []; }
    async deleteChunksByRepo(): Promise<number> { return 0; }
    async pruneDeletedFiles(): Promise<number> { return 0; }
}

class FakeSyncState implements ISyncStateRepository {
    public markCompleteCalls: unknown[][] = [];
    async markStarted(): Promise<void> {}
    async markPhase(): Promise<void> {}
    async markComplete(...args: unknown[]): Promise<void> { this.markCompleteCalls.push(args); }
    async markError(): Promise<void> {}
    async saveArchetypeSignals(): Promise<void> {}
    async saveEvidenceTopology(): Promise<void> { /* test fake — no-op */ }
    async getLastSyncedCommitSha(): Promise<string | null> { return null; }
    async setLastSyncedCommitSha(): Promise<void> {}
    async get(): Promise<undefined> { return undefined; }
    async upsert(): Promise<void> {}
}

class FakeEmbedder implements IEmbeddingProvider {
    readonly dimension = 4;
    async embed(_text: string): Promise<number[]> { return [0, 0, 0, 0]; }
}

class FakeEnricher implements IChunkEnricher {
    public calls = 0;
    constructor(private readonly impl: (chunk: RawChunk, callIndex: number) => Promise<ChunkEnrichment>) {}
    async enrich(chunk: RawChunk): Promise<ChunkEnrichment> {
        const idx = this.calls++;
        return this.impl(chunk, idx);
    }
}

/** Enricher with the per-file enrichText seam (feature 002). Records text calls. */
class FakeTextEnricher implements IChunkEnricher {
    public textCalls: { filePath: string; content: string }[] = [];
    public batchCalls = 0;
    /** Assigned in the constructor only when a batchMode is given (else absent). Keyed by item id. */
    public enrichBatch?: (items: readonly { id: string; filePath: string }[]) => Promise<Map<string, ChunkEnrichment>>;

    constructor(
        private readonly skillsForFile: (filePath: string) => string[],
        /** undefined = no batch; 'throw' = batch fails (test fallback); 'ok' = batch returns skills. */
        batchMode?: 'throw' | 'ok',
    ) {
        if (batchMode) {
            this.enrichBatch = async (items): Promise<Map<string, ChunkEnrichment>> => {
                this.batchCalls++;
                if (batchMode === 'throw') throw new Error('batch infra unavailable');
                return new Map(items.map((it) => [it.id, { skills: this.skillsForFile(it.filePath), technologies: [] }]));
            };
        }
    }
    async enrich(chunk: RawChunk): Promise<ChunkEnrichment> { return { skills: this.skillsForFile(chunk.filePath), technologies: [] }; }
    async enrichText(filePath: string, content: string): Promise<ChunkEnrichment> {
        this.textCalls.push({ filePath, content });
        return { skills: this.skillsForFile(filePath), technologies: [] };
    }
}

function makeChunk(filePath: string, idx: number, content = 'body'): RawChunk {
    return {
        filePath,
        content,
        chunkIndex:  idx,
        totalChunks: 1,
    };
}

// =============================================================================
// TESTS
// =============================================================================

describe('IngestionPipeline — document_embeddings build visibility', () => {
    let store: FakeVectorStore;
    let sync:  FakeSyncState;
    let embed: FakeEmbedder;

    beforeEach(() => {
        store = new FakeVectorStore();
        sync  = new FakeSyncState();
        embed = new FakeEmbedder();
    });
    afterEach(() => { jest.restoreAllMocks(); });

    it('logs the target table, files visited, and per-fileClass lane counts', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        const pipeline = new IngestionPipeline(store, sync, embed);
        const chunks: RawChunk[] = [
            { filePath: 'src/a.ts', content: 'x', chunkIndex: 0, totalChunks: 1, metadata: { fileClass: 'source' } },
            { filePath: 'src/b.ts', content: 'y', chunkIndex: 0, totalChunks: 1, metadata: { fileClass: 'source' } },
            { filePath: 'a.test.ts', content: 'z', chunkIndex: 0, totalChunks: 1, metadata: { fileClass: 'test' } },
        ];
        await pipeline.ingestChunks('u1', 'o/r', chunks);

        const lines = logSpy.mock.calls.map(c => String(c[0]));
        const build = lines.find(m => m.includes('document_embeddings build'));
        expect(build).toBeDefined();
        expect(build).toContain('3 files visited');
        expect(build).toContain('source=2');
        expect(build).toContain('test=1');
        expect(build).toContain('table=document_embeddings');
        // The write phase names the table + insert/update counts too.
        expect(lines.find(m => m.includes('document_embeddings written'))).toBeDefined();
    });
});

describe('IngestionPipeline enrichment', () => {
    let store: FakeVectorStore;
    let sync:  FakeSyncState;
    let embed: FakeEmbedder;

    beforeEach(() => {
        store = new FakeVectorStore();
        sync  = new FakeSyncState();
        embed = new FakeEmbedder();
    });

    it('skips enrichment entirely when no enricher is configured', async () => {
        const pipeline = new IngestionPipeline(store, sync, embed);
        const chunks   = [makeChunk('a.md', 0)];

        await pipeline.ingestChunks('u1', 'o/r', chunks);

        const upserted = store.upserts[0][0];
        expect(upserted.skills).toBeUndefined();
        expect(upserted.technologies).toBeUndefined();
        expect(upserted.metadata).toBeUndefined();
    });

    it('defers enrichment: tags chunks pending and never calls the enricher inline', async () => {
        const enricher = new FakeEnricher(async () => ({ skills: ['x'], technologies: [] }));
        const pipeline = new IngestionPipeline(store, sync, embed, { enricher, deferEnrichment: true });

        await pipeline.ingestChunks('u1', 'o/r', [makeChunk('a.md', 0)]);

        const upserted = store.upserts[0][0];
        expect((upserted.metadata as Record<string, unknown>).enrichment_status).toBe('pending');
        expect(upserted.skills).toEqual([]);       // empty until the background pass backfills
        expect(enricher.calls).toBe(0);            // no inline Bedrock calls
    });

    it('populates skills + technologies + enrichment_status=ok when enricher succeeds', async () => {
        const enricher = new FakeEnricher(async () => ({
            skills:       ['kubernetes networking'],
            technologies: ['calico'],
        }));
        const pipeline = new IngestionPipeline(store, sync, embed, { enricher });

        await pipeline.ingestChunks('u1', 'o/r', [makeChunk('a.md', 0)]);

        const upserted = store.upserts[0][0];
        expect(upserted.skills).toEqual(['kubernetes networking']);
        expect(upserted.technologies).toEqual(['calico']);
        expect((upserted.metadata as Record<string, unknown>).enrichment_status).toBe('ok');
    });

    it('marks chunk as failed and continues when enricher throws', async () => {
        const enricher = new FakeEnricher(async (chunk, _i) => {
            if (chunk.filePath === 'bad.md') throw new Error('boom');
            return { skills: ['s'], technologies: ['t'] };
        });
        const pipeline = new IngestionPipeline(store, sync, embed, { enricher });

        await pipeline.ingestChunks('u1', 'o/r', [
            makeChunk('good.md', 0),
            makeChunk('bad.md',  0),
        ]);

        const upserted = store.upserts[0];
        const good = upserted.find(c => c.filePath === 'good.md')!;
        const bad  = upserted.find(c => c.filePath === 'bad.md')!;

        expect((good.metadata as Record<string, unknown>).enrichment_status).toBe('ok');
        expect(good.skills).toEqual(['s']);

        expect((bad.metadata as Record<string, unknown>).enrichment_status).toBe('failed');
        expect(bad.skills).toEqual([]);
        expect(bad.technologies).toEqual([]);
    });

    it('caps enrichment at maxEnrichmentPerRun and tags overflow as skipped_quota', async () => {
        const enricher = new FakeEnricher(async () => ({
            skills:       ['x'],
            technologies: ['y'],
        }));
        const pipeline = new IngestionPipeline(store, sync, embed, {
            enricher,
            maxEnrichmentPerRun: 2,
        });

        const chunks = [
            makeChunk('a.md', 0),
            makeChunk('b.md', 0),
            makeChunk('c.md', 0),
            makeChunk('d.md', 0),
        ];
        await pipeline.ingestChunks('u1', 'o/r', chunks);

        // Only the first 2 calls should reach the enricher.
        expect(enricher.calls).toBe(2);

        const upserted = store.upserts[0];
        const enriched = upserted.filter(c => (c.metadata as Record<string, unknown>).enrichment_status === 'ok');
        const skipped  = upserted.filter(c => (c.metadata as Record<string, unknown>).enrichment_status === 'skipped_quota');

        expect(enriched.length).toBe(2);
        expect(skipped.length).toBe(2);
        skipped.forEach(c => {
            expect(c.skills).toEqual([]);
            expect(c.technologies).toEqual([]);
        });
    });
});

describe('IngestionPipeline — incremental-safe pruning', () => {
    let store: FakeVectorStore;
    let sync:  FakeSyncState;
    let embed: FakeEmbedder;
    let pruneSpy: ReturnType<typeof jest.spyOn>;

    beforeEach(() => {
        store = new FakeVectorStore();
        sync  = new FakeSyncState();
        embed = new FakeEmbedder();
        pruneSpy = jest.spyOn(store, 'pruneDeletedFiles');
    });

    it('prunes against knownFilePaths when provided, not the rawChunks subset', async () => {
        const pipeline = new IngestionPipeline(store, sync, embed);

        // Incremental run: only the changed file's chunk is passed, but the
        // caller knows the full current tree via knownFilePaths.
        await pipeline.ingestChunks('u1', 'o/r', [makeChunk('changed.ts', 0)], {
            knownFilePaths: ['changed.ts', 'unchanged.ts'],
        });

        expect(pruneSpy).toHaveBeenCalledWith('u1', 'o/r', ['changed.ts', 'unchanged.ts']);
    });

    it('falls back to rawChunks-derived paths when knownFilePaths omitted', async () => {
        const pipeline = new IngestionPipeline(store, sync, embed);

        await pipeline.ingestChunks('u1', 'o/r', [makeChunk('a.ts', 0)]);

        expect(pruneSpy).toHaveBeenCalledWith('u1', 'o/r', ['a.ts']);
    });
});

describe('IngestionPipeline retrieval probe', () => {
    let store: FakeVectorStore;
    let sync:  FakeSyncState;
    let embed: FakeEmbedder;

    beforeEach(() => {
        store = new FakeVectorStore();
        sync  = new FakeSyncState();
        embed = new FakeEmbedder();
    });

    it('folds probe result into report and markComplete when probe returns ok', async () => {
        const okBreakdown: RetrievalBreakdown = {
            version: 1,
            status: 'ok',
            sampled: 5,
            recallAt3: 0.8,
            mrr: 0.7,
            meanTopSimilarity: 0.75,
            score: 0.76,
            perQuestion: [],
            suggestions: [],
        };
        const probe: IRetrievalProbe = {
            evaluate: async () => okBreakdown,
        };

        const pipeline = new IngestionPipeline(store, sync, embed, { retrievalProbe: probe });
        const report = await pipeline.ingestChunks('u1', 'o/r', [makeChunk('a.md', 0)]);

        expect(report.retrievalScore).toBe(0.76);
        expect(report.retrievalBreakdown).toMatchObject({ status: 'ok' });

        const callArgs = sync.markCompleteCalls[0];
        expect(callArgs[6]).toBe(0.76);
        expect(callArgs[7]).toEqual(expect.objectContaining({ status: 'ok' }));
    });

    it('leaves retrievalScore and retrievalBreakdown undefined when no probe is injected', async () => {
        const pipeline = new IngestionPipeline(store, sync, embed);
        const report = await pipeline.ingestChunks('u1', 'o/r', [makeChunk('a.md', 0)]);

        expect(report.retrievalScore).toBeUndefined();
        expect(report.retrievalBreakdown).toBeUndefined();
    });

    it('resolves ingestion and preserves kbQualityScore when probe throws', async () => {
        const probe: IRetrievalProbe = {
            evaluate: async () => { throw new Error('probe explosion'); },
        };

        const pipeline = new IngestionPipeline(store, sync, embed, { retrievalProbe: probe });
        const report = await pipeline.ingestChunks('u1', 'o/r', [makeChunk('a.md', 0)]);

        expect(report.retrievalScore).toBeUndefined();
        expect(typeof report.kbQualityScore).toBe('number');
    });
});

describe('IngestionPipeline — OTel spans', () => {
    let exporter: InMemorySpanExporter;
    let provider: NodeTracerProvider;

    beforeEach(() => {
        exporter = new InMemorySpanExporter();
        provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
        provider.register();
    });

    afterEach(async () => {
        await provider.shutdown();
        exporter.reset();
    });

    it('creates ingestion.chunk, ingestion.enrich, ingestion.embed_upsert, ingestion.prune, ingestion.retrieval_probe spans', async () => {
        const fakeProbe: IRetrievalProbe = {
            evaluate: async () => ({
                version:           1,
                status:            'ok',
                sampled:           1,
                recallAt3:         1,
                mrr:               1,
                meanTopSimilarity: 1,
                score:             1,
                perQuestion:       [],
                suggestions:       [],
            }),
        };

        const rootSpan = trace.getTracer('test').startSpan('test.root');
        await context.with(trace.setSpan(context.active(), rootSpan), async () => {
            const pipeline = new IngestionPipeline(
                new FakeVectorStore(),
                new FakeSyncState(),
                new FakeEmbedder(),
                { retrievalProbe: fakeProbe },
            );
            const chunk: RawChunk = {
                filePath:    'src/index.ts',
                chunkIndex:  0,
                totalChunks: 1,
                content:     'export function main() {}',
            };
            await pipeline.ingestChunks('user-1', 'owner/repo', [chunk]);
        });
        rootSpan.end();

        const allSpans = exporter.getFinishedSpans();
        const spanNames = allSpans.map(s => s.name);
        expect(spanNames).toContain('ingestion.chunk');
        expect(spanNames).toContain('ingestion.enrich');
        expect(spanNames).toContain('ingestion.embed_upsert');
        expect(spanNames).toContain('ingestion.prune');
        expect(spanNames).toContain('ingestion.retrieval_probe');

        // Phase spans must be children of the test root span
        const rootSpanId = rootSpan.spanContext().spanId;
        const phaseSpanNames = [
            'ingestion.chunk',
            'ingestion.enrich',
            'ingestion.embed_upsert',
            'ingestion.prune',
            'ingestion.retrieval_probe',
        ];
        for (const name of phaseSpanNames) {
            const span = allSpans.find(s => s.name === name);
            expect(span).toBeDefined();
            expect(span!.parentSpanContext?.spanId).toBe(rootSpanId);
        }
    });
});

describe('IngestionPipeline — per-file enrichment (feature 002 cost lever)', () => {
    let store: FakeVectorStore;
    let sync:  FakeSyncState;
    let embed: FakeEmbedder;

    beforeEach(() => { store = new FakeVectorStore(); sync = new FakeSyncState(); embed = new FakeEmbedder(); });
    afterEach(() => { delete process.env.ENRICH_PER_FILE; });

    it('ENRICH_PER_FILE=1 makes ONE call per file and fans skills back by evidence', async () => {
        process.env.ENRICH_PER_FILE = '1';
        const enricher = new FakeTextEnricher((fp) => (fp === 'a.ts' ? ['kubernetes'] : ['react']));
        const pipeline = new IngestionPipeline(store, sync, embed, { enricher });

        await pipeline.ingestChunks('u1', 'o/r', [
            makeChunk('a.ts', 0, 'uses kubernetes here'),
            makeChunk('a.ts', 1, 'plain prose, no signal'),
            makeChunk('b.ts', 0, 'a react app'),
        ]);

        // 3 chunks -> 2 model calls (one per file), the call-reduction lever
        expect(enricher.textCalls).toHaveLength(2);

        const upserted = store.upserts[0];
        const byKey = new Map(upserted.map((c) => [`${c.filePath}#${c.chunkIndex}`, c.skills]));
        expect(byKey.get('a.ts#0')).toEqual(['kubernetes']);  // evidences it
        expect(byKey.get('a.ts#1')).toEqual([]);              // file has it, chunk doesn't -> not smeared
        expect(byKey.get('b.ts#0')).toEqual(['react']);
    });

    it('falls back to per-chunk when the enricher lacks enrichText (fail-safe)', async () => {
        process.env.ENRICH_PER_FILE = '1';
        const enricher = new FakeEnricher(async () => ({ skills: ['s'], technologies: [] })); // no enrichText
        const pipeline = new IngestionPipeline(store, sync, embed, { enricher });

        await pipeline.ingestChunks('u1', 'o/r', [makeChunk('a.ts', 0, 'x'), makeChunk('a.ts', 1, 'y')]);

        expect(enricher.calls).toBe(2);  // per-chunk path, not per-file
    });

    it('ENRICH_BATCH=1 uses the batch result and skips inline enrichText calls', async () => {
        process.env.ENRICH_PER_FILE = '1';
        process.env.ENRICH_BATCH = '1';
        const enricher = new FakeTextEnricher((fp) => (fp === 'a.ts' ? ['kubernetes'] : ['react']), 'ok');
        const pipeline = new IngestionPipeline(store, sync, embed, { enricher });

        await pipeline.ingestChunks('u1', 'o/r', [makeChunk('a.ts', 0, 'uses kubernetes here'), makeChunk('b.ts', 0, 'a react app')]);

        expect(enricher.batchCalls).toBe(1);
        expect(enricher.textCalls).toHaveLength(0);  // batch supplied skills — no inline calls
        const byKey = new Map(store.upserts[0].map((c) => [`${c.filePath}#${c.chunkIndex}`, c.skills]));
        expect(byKey.get('a.ts#0')).toEqual(['kubernetes']);
        delete process.env.ENRICH_BATCH;
    });

    it('a failing batch falls back to inline enrichText — skills never lost (SC-006)', async () => {
        process.env.ENRICH_PER_FILE = '1';
        process.env.ENRICH_BATCH = '1';
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const enricher = new FakeTextEnricher((fp) => (fp === 'a.ts' ? ['kubernetes'] : ['react']), 'throw');
        const pipeline = new IngestionPipeline(store, sync, embed, { enricher });

        await pipeline.ingestChunks('u1', 'o/r', [makeChunk('a.ts', 0, 'uses kubernetes here')]);

        expect(enricher.batchCalls).toBe(1);            // tried batch
        expect(enricher.textCalls).toHaveLength(1);     // fell back to inline
        expect(warn).toHaveBeenCalled();                // surfaced, not silent
        expect(store.upserts[0][0].skills).toEqual(['kubernetes']);  // skills still correct
        delete process.env.ENRICH_BATCH;
    });

    // --- The chosen lever: batch the PER-CHUNK calls (recall-neutral ~50%) ---

    it('ENRICH_BATCH=1 alone batches the per-chunk calls, keyed by chunk id', async () => {
        process.env.ENRICH_BATCH = '1';   // NO ENRICH_PER_FILE — per-chunk granularity preserved
        const enricher = new FakeTextEnricher((fp) => (fp === 'a.ts' ? ['kubernetes'] : ['react']), 'ok');
        const pipeline = new IngestionPipeline(store, sync, embed, { enricher });

        await pipeline.ingestChunks('u1', 'o/r', [makeChunk('a.ts', 0, 'x'), makeChunk('a.ts', 1, 'y'), makeChunk('b.ts', 0, 'z')]);

        expect(enricher.batchCalls).toBe(1);          // one batch job for all chunks
        const byKey = new Map(store.upserts[0].map((c) => [`${c.filePath}#${c.chunkIndex}`, c.skills]));
        expect(byKey.get('a.ts#0')).toEqual(['kubernetes']);   // each chunk keyed distinctly
        expect(byKey.get('a.ts#1')).toEqual(['kubernetes']);   // same file, separate record
        expect(byKey.get('b.ts#0')).toEqual(['react']);
        delete process.env.ENRICH_BATCH;
    });

    it('a failing per-chunk batch falls back to inline enrich — skills preserved (SC-006)', async () => {
        process.env.ENRICH_BATCH = '1';
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const enricher = new FakeTextEnricher(() => ['kubernetes'], 'throw');
        const pipeline = new IngestionPipeline(store, sync, embed, { enricher });

        await pipeline.ingestChunks('u1', 'o/r', [makeChunk('a.ts', 0, 'x')]);

        expect(enricher.batchCalls).toBe(1);
        expect(warn).toHaveBeenCalled();
        expect(store.upserts[0][0].skills).toEqual(['kubernetes']);  // inline enrich filled it
        delete process.env.ENRICH_BATCH;
    });
});
