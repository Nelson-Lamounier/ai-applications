/**
 * @format
 * RepoIngestionOrchestrator — concurrent file fetch
 *
 * Covers the bounded-concurrency fetch pool that replaced the old
 * one-at-a-time loop: order preservation, error tolerance, progress
 * callback, and that fetches actually overlap.
 */

import { RepoIngestionOrchestrator } from './RepoIngestionOrchestrator.js';
import type { IRepoAdapter, RepoFile, RepoCommit } from '../interfaces/IRepoAdapter.js';
import type { IFileFilter } from '../interfaces/IFileFilter.js';
import type { ChunkerRegistry } from '../implementations/ChunkerRegistry.js';
import type { IngestionPipeline } from '../../rds/pipeline/IngestionPipeline.js';
import type { RawChunk, IngestionReport } from '../../rds/types.js';

// =============================================================================
// FAKES
// =============================================================================

class FakeRepoAdapter implements IRepoAdapter {
    /** filePath -> content. Order of this map defines listFiles order. */
    public readonly files: Map<string, string>;
    /** filePaths that should throw on fetch. */
    public readonly failPaths: Set<string>;
    public concurrentNow = 0;
    public peakConcurrency = 0;
    private readonly fetchDelayMs: number;

    constructor(files: Map<string, string>, opts: { failPaths?: Set<string>; fetchDelayMs?: number } = {}) {
        this.files = files;
        this.failPaths = opts.failPaths ?? new Set();
        this.fetchDelayMs = opts.fetchDelayMs ?? 0;
    }

    async listFiles(): Promise<RepoFile[]> {
        return [...this.files.keys()].map(path => ({ path, sizeBytes: 100 }));
    }

    async fetchFile(_repo: string, filePath: string): Promise<string> {
        this.concurrentNow++;
        this.peakConcurrency = Math.max(this.peakConcurrency, this.concurrentNow);
        try {
            if (this.fetchDelayMs > 0) await new Promise(r => setTimeout(r, this.fetchDelayMs));
            if (this.failPaths.has(filePath)) throw new Error(`boom: ${filePath}`);
            return this.files.get(filePath) ?? '';
        } finally {
            this.concurrentNow--;
        }
    }

    async listCommits(): Promise<RepoCommit[]> { return []; }
}

class FakeFileFilter implements IFileFilter {
    shouldInclude(): boolean { return true; }
    filter(p: string[]): string[] { return p; }
    filterWithSize(files: Array<{ path: string }>): string[] { return files.map(f => f.path); }
}

// One chunk per file: content is the file content, chunkIndex 0.
function fakeChunkerRegistry(): ChunkerRegistry {
    return {
        chunk(content: string, filePath: string): RawChunk[] {
            return [{ filePath, content, chunkIndex: 0, totalChunks: 1 }];
        },
    } as unknown as ChunkerRegistry;
}

function fakePipeline(): { pipeline: IngestionPipeline; lastChunks: () => RawChunk[] } {
    let captured: RawChunk[] = [];
    const pipeline = {
        async ingestChunks(_u: string, _r: string, chunks: RawChunk[]): Promise<IngestionReport> {
            captured = chunks;
            return { totalRawChunks: chunks.length } as unknown as IngestionReport;
        },
    } as unknown as IngestionPipeline;
    return { pipeline, lastChunks: () => captured };
}

// =============================================================================
// TESTS
// =============================================================================

describe('RepoIngestionOrchestrator concurrent fetch', () => {
    afterEach(() => { jest.restoreAllMocks(); });

    function build(adapter: FakeRepoAdapter) {
        const { pipeline, lastChunks } = fakePipeline();
        const orch = new RepoIngestionOrchestrator(
            adapter,
            new FakeFileFilter(),
            fakeChunkerRegistry(),
            pipeline,
            { commitChunker: null },
        );
        return { orch, lastChunks };
    }

    it('preserves file order despite out-of-order completion', async () => {
        const files = new Map(
            Array.from({ length: 20 }, (_, i) => [`f${i}.ts`, `content-${i}`] as const),
        );
        // Earlier files sleep longer so they finish last — proves ordering is by
        // index, not completion time.
        const adapter = new FakeRepoAdapter(files);
        const origFetch = adapter.fetchFile.bind(adapter);
        jest.spyOn(adapter, 'fetchFile').mockImplementation(async (repo, path) => {
            const i = Number(path.replace(/\D/g, ''));
            await new Promise(r => setTimeout(r, (20 - i) * 2));
            return origFetch(repo, path);
        });

        const { orch, lastChunks } = build(adapter);
        await orch.ingestRepo('user-1', 'owner/repo');

        const order = lastChunks().map(c => c.filePath);
        expect(order).toEqual(Array.from({ length: 20 }, (_, i) => `f${i}.ts`));
    });

    it('skips a failing file without aborting the run', async () => {
        const files = new Map([
            ['a.ts', 'A'], ['b.ts', 'B'], ['c.ts', 'C'],
        ]);
        const adapter = new FakeRepoAdapter(files, { failPaths: new Set(['b.ts']) });
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const { orch, lastChunks } = build(adapter);
        await orch.ingestRepo('user-1', 'owner/repo');

        expect(lastChunks().map(c => c.filePath)).toEqual(['a.ts', 'c.ts']);
    });

    it('fetches concurrently, bounded by the pool size (default 8)', async () => {
        const files = new Map(
            Array.from({ length: 30 }, (_, i) => [`f${i}.ts`, `c${i}`] as const),
        );
        const adapter = new FakeRepoAdapter(files, { fetchDelayMs: 10 });

        const { orch } = build(adapter);
        await orch.ingestRepo('user-1', 'owner/repo');

        // Concurrency proven: more than one in flight at once, never above pool.
        expect(adapter.peakConcurrency).toBeGreaterThan(1);
        expect(adapter.peakConcurrency).toBeLessThanOrEqual(8);
    });

    it('reports progress (0 first, total last)', async () => {
        const files = new Map(
            Array.from({ length: 30 }, (_, i) => [`f${i}.ts`, `c${i}`] as const),
        );
        const adapter = new FakeRepoAdapter(files);
        const { orch } = build(adapter);

        const calls: Array<[number, number]> = [];
        await orch.ingestRepo('user-1', 'owner/repo', (done, total) => calls.push([done, total]));

        expect(calls[0]).toEqual([0, 30]);
        expect(calls.at(-1)).toEqual([30, 30]);
    });
});
