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
