/**
 * @format
 * RepoIngestionOrchestrator — concurrent file fetch
 *
 * Covers the bounded-concurrency fetch pool that replaced the old
 * one-at-a-time loop: order preservation, error tolerance, progress
 * callback, and that fetches actually overlap.
 */

import { RepoIngestionOrchestrator } from './RepoIngestionOrchestrator.js';
import type { RepoActivityStore } from './RepoIngestionOrchestrator.js';
import type { IRepoAdapter, RepoFile, RepoCommit, RepoPullRequest, CommitDetail } from './acquisition/IRepoAdapter.js';
import type { IFileFilter } from './knowledge/IFileFilter.js';
import type { ChunkerRegistry } from './knowledge/ChunkerRegistry.js';
import type { IngestionPipeline, RawChunk, IngestionReport } from '@bedrock/shared';

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
        return [...this.files.keys()].map(path => ({ path, sizeBytes: 100, blobSha: `sha_${path}` }));
    }

    async getHeadCommitSha(): Promise<string> { return 'head'; }

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

// =============================================================================
// ACTIVITY PERSISTENCE
// =============================================================================

const SAMPLE_COMMIT: RepoCommit = {
    sha:        'abc123',
    authorName: 'Octocat',
    authoredAt: '2026-01-01T00:00:00Z',
    message:    'init',
};

const SAMPLE_PULL: RepoPullRequest = {
    number:      7,
    title:       'Add feature',
    body:        'body',
    createdAt:   '2026-01-02T00:00:00Z',
    mergedAt:    '2026-01-03T00:00:00Z',
    state:       'merged',
    authorLogin: 'octocat',
    htmlUrl:     'https://github.com/o/a/pull/7',
};

/** Adapter with commits + (optionally throwing) pull-request support. */
class ActivityAdapter implements IRepoAdapter {
    public listPullRequestsCalled = false;
    constructor(private readonly opts: { pullsThrow?: boolean } = {}) {}

    async listFiles(): Promise<RepoFile[]> { return []; }
    async getHeadCommitSha(): Promise<string> { return 'head'; }
    async fetchFile(): Promise<string> { return ''; }
    async listCommits(): Promise<RepoCommit[]> { return [SAMPLE_COMMIT]; }
    async listPullRequests(): Promise<RepoPullRequest[]> {
        this.listPullRequestsCalled = true;
        if (this.opts.pullsThrow) throw new Error('boom: PRs');
        return [SAMPLE_PULL];
    }
}

function makeActivityStore() {
    return {
        upsertCommits:      jest.fn(async () => 0),
        upsertPullRequests: jest.fn(async () => 0),
    } as unknown as RepoActivityStore & {
        upsertCommits: jest.Mock;
        upsertPullRequests: jest.Mock;
    };
}

describe('RepoIngestionOrchestrator activity persistence', () => {
    afterEach(() => { jest.restoreAllMocks(); });

    it('persists structured commits + pull requests when a store is configured', async () => {
        const adapter = new ActivityAdapter();
        const store   = makeActivityStore();
        const { pipeline } = fakePipeline();
        const orch = new RepoIngestionOrchestrator(
            adapter,
            new FakeFileFilter(),
            {} as never,
            pipeline,
            { activityStore: store, repositoryId: 'repo-uuid' },
        );

        await orch.ingestRepo('user-uuid', 'o/a');

        expect(store.upsertCommits).toHaveBeenCalledWith(
            'user-uuid', 'repo-uuid', 'o/a', [SAMPLE_COMMIT],
        );
        expect(store.upsertPullRequests).toHaveBeenCalledWith(
            'user-uuid', 'repo-uuid', 'o/a', [SAMPLE_PULL],
        );
        expect(adapter.listPullRequestsCalled).toBe(true);
    });

    it('resolves without throwing when no activity store is configured', async () => {
        const adapter = new ActivityAdapter();
        const { pipeline } = fakePipeline();
        const orch = new RepoIngestionOrchestrator(
            adapter,
            new FakeFileFilter(),
            {} as never,
            pipeline,
        );

        await expect(orch.ingestRepo('user-uuid', 'o/a')).resolves.toBeDefined();
    });

    it('still persists commits when pull-request fetch throws', async () => {
        const adapter = new ActivityAdapter({ pullsThrow: true });
        const store   = makeActivityStore();
        const { pipeline } = fakePipeline();
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const orch = new RepoIngestionOrchestrator(
            adapter,
            new FakeFileFilter(),
            {} as never,
            pipeline,
            { activityStore: store, repositoryId: 'repo-uuid' },
        );

        await expect(orch.ingestRepo('user-uuid', 'o/a')).resolves.toBeDefined();
        expect(store.upsertCommits).toHaveBeenCalledWith(
            'user-uuid', 'repo-uuid', 'o/a', [SAMPLE_COMMIT],
        );
    });
});

describe('RepoIngestionOrchestrator commit-detail (diff) ingestion', () => {
    afterEach(() => { jest.restoreAllMocks(); });

    const detail: CommitDetail = {
        sha: SAMPLE_COMMIT.sha, additions: 5, deletions: 2, filesChanged: 1,
        files: [{ filePath: 'a.ts', status: 'modified', additions: 5, deletions: 2, changes: 7, patch: '@@', patchTruncated: false }],
    };

    function detailStore(missing: string[]) {
        return {
            upsertCommits:          jest.fn(async () => 1),
            upsertPullRequests:     jest.fn(async () => 0),
            selectShasMissingStats: jest.fn(async () => missing),
            upsertCommitDetails:    jest.fn(async () => 1),
        };
    }

    it('fetches per-commit detail for missing shas and persists it', async () => {
        const getCommitDetail = jest.fn(async () => detail);
        const adapter = Object.assign(new ActivityAdapter(), { getCommitDetail });
        const store = detailStore([SAMPLE_COMMIT.sha]);
        const { pipeline } = fakePipeline();
        jest.spyOn(console, 'info').mockImplementation(() => {});
        const orch = new RepoIngestionOrchestrator(
            adapter, new FakeFileFilter(), {} as never, pipeline,
            { activityStore: store as unknown as RepoActivityStore, repositoryId: 'repo-uuid' },
        );

        await orch.ingestRepo('user-uuid', 'o/a');

        expect(store.selectShasMissingStats).toHaveBeenCalledWith('user-uuid', 'o/a', [SAMPLE_COMMIT.sha]);
        expect(getCommitDetail).toHaveBeenCalledWith('o/a', SAMPLE_COMMIT.sha);
        expect(store.upsertCommitDetails).toHaveBeenCalledWith('user-uuid', 'repo-uuid', 'o/a', [detail]);
    });

    it('skips detail fetch when no shas are missing stats', async () => {
        const getCommitDetail = jest.fn(async () => detail);
        const adapter = Object.assign(new ActivityAdapter(), { getCommitDetail });
        const store = detailStore([]);   // nothing missing
        const { pipeline } = fakePipeline();
        const orch = new RepoIngestionOrchestrator(
            adapter, new FakeFileFilter(), {} as never, pipeline,
            { activityStore: store as unknown as RepoActivityStore, repositoryId: 'repo-uuid' },
        );

        await orch.ingestRepo('user-uuid', 'o/a');

        expect(getCommitDetail).not.toHaveBeenCalled();
        expect(store.upsertCommitDetails).not.toHaveBeenCalled();
    });

    it('does not abort the run when a detail fetch throws', async () => {
        const getCommitDetail = jest.fn(async () => { throw new Error('boom: detail'); });
        const adapter = Object.assign(new ActivityAdapter(), { getCommitDetail });
        const store = detailStore([SAMPLE_COMMIT.sha]);
        const { pipeline } = fakePipeline();
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const orch = new RepoIngestionOrchestrator(
            adapter, new FakeFileFilter(), {} as never, pipeline,
            { activityStore: store as unknown as RepoActivityStore, repositoryId: 'repo-uuid' },
        );

        await expect(orch.ingestRepo('user-uuid', 'o/a')).resolves.toBeDefined();
        // detail failed → nothing valid to persist
        expect(store.upsertCommitDetails).not.toHaveBeenCalled();
    });
});

// =============================================================================
// ARCHETYPE-SIGNAL DERIVATION + PERSISTENCE
// =============================================================================

/** Adapter whose listFiles returns a fixed tree; fetch/commits are inert. */
class SignalAdapter implements IRepoAdapter {
    constructor(private readonly tree: RepoFile[]) {}
    async listFiles(): Promise<RepoFile[]> { return this.tree; }
    async getHeadCommitSha(): Promise<string> { return 'head'; }
    async fetchFile(): Promise<string> { return ''; }
    async listCommits(): Promise<RepoCommit[]> { return []; }
}

// =============================================================================
// INCREMENTAL TWO-TIER RESYNC
// =============================================================================

/**
 * Adapter whose listFiles + head sha are configurable per test, fetches are
 * recorded, and one chunk per fetched file is produced via the registry.
 */
class ResyncAdapter implements IRepoAdapter {
    public readonly fetched: string[] = [];
    constructor(
        private readonly tree: RepoFile[],
        private readonly headSha: string,
    ) {}
    async listFiles(): Promise<RepoFile[]> { return this.tree; }
    async getHeadCommitSha(): Promise<string> { return this.headSha; }
    async fetchFile(_repo: string, path: string): Promise<string> {
        this.fetched.push(path);
        return `content-${path}`;
    }
    async listCommits(): Promise<RepoCommit[]> { return []; }
}

function makeFileStateStore(initial: Map<string, string> = new Map()) {
    return {
        getFileState: jest.fn(async () => new Map(initial)),
        upsertFileState: jest.fn(async () => {}),
        deleteFileState: jest.fn(async () => {}),
    };
}

function makeWatermarkStore(initialSha: string | null = null) {
    return {
        getLastSyncedCommitSha: jest.fn(async () => initialSha),
        setLastSyncedCommitSha: jest.fn(async () => {}),
    };
}

/** Pipeline that captures both the chunks and the opts passed to ingestChunks. */
function fakePipelineWithOpts(): {
    pipeline: IngestionPipeline;
    lastChunks: () => RawChunk[];
    lastOpts: () => { knownFilePaths?: string[] } | undefined;
} {
    let captured: RawChunk[] = [];
    let capturedOpts: { knownFilePaths?: string[] } | undefined;
    const pipeline = {
        async ingestChunks(
            _u: string, _r: string, chunks: RawChunk[], opts?: { knownFilePaths?: string[] },
        ): Promise<IngestionReport> {
            captured = chunks;
            capturedOpts = opts;
            return { totalRawChunks: chunks.length } as unknown as IngestionReport;
        },
        async forceReindex(_u: string, _r: string, chunks: RawChunk[]): Promise<IngestionReport> {
            captured = chunks;
            return { totalRawChunks: chunks.length } as unknown as IngestionReport;
        },
    } as unknown as IngestionPipeline;
    return { pipeline, lastChunks: () => captured, lastOpts: () => capturedOpts };
}

describe('RepoIngestionOrchestrator incremental resync', () => {
    afterEach(() => { jest.restoreAllMocks(); });

    const TREE: RepoFile[] = [
        { path: 'a.ts', sizeBytes: 10, blobSha: 'sha-a' },
        { path: 'b.ts', sizeBytes: 20, blobSha: 'sha-b' },
        { path: 'c.ts', sizeBytes: 30, blobSha: 'sha-c' },
    ];
    const ALL_PATHS = TREE.map(f => f.path);

    function build(
        adapter: ResyncAdapter,
        opts: {
            fileStateStore?: ReturnType<typeof makeFileStateStore>;
            watermarkStore?: ReturnType<typeof makeWatermarkStore>;
        } = {},
    ) {
        const { pipeline, lastChunks, lastOpts } = fakePipelineWithOpts();
        const orch = new RepoIngestionOrchestrator(
            adapter,
            new FakeFileFilter(),
            fakeChunkerRegistry(),
            pipeline,
            {
                commitChunker: null,
                fileStateStore: opts.fileStateStore,
                watermarkStore: opts.watermarkStore,
            },
        );
        return { orch, lastChunks, lastOpts };
    }

    it('first sync: fetches all included paths, persists state + watermark', async () => {
        const adapter = new ResyncAdapter(TREE, 'head-1');
        const fileStateStore = makeFileStateStore();      // empty
        const watermarkStore = makeWatermarkStore(null);  // no prior watermark
        const { orch, lastOpts } = build(adapter, { fileStateStore, watermarkStore });

        await orch.ingestRepo('u', 'o/a');

        expect(adapter.fetched.sort()).toEqual([...ALL_PATHS].sort());
        expect(lastOpts()?.knownFilePaths).toEqual(ALL_PATHS);
        expect(fileStateStore.upsertFileState).toHaveBeenCalledWith(
            'u', 'o/a',
            TREE.map(f => ({ path: f.path, blobSha: f.blobSha, sizeBytes: f.sizeBytes })),
        );
        expect(watermarkStore.setLastSyncedCommitSha).toHaveBeenCalledWith('u', 'o/a', 'head-1');
    });

    it('includes synthetic _commits/ paths in knownFilePaths so commit chunks survive pruning', async () => {
        class CommitResyncAdapter extends ResyncAdapter {
            override async listCommits(): Promise<RepoCommit[]> { return [SAMPLE_COMMIT]; }
        }
        const adapter = new CommitResyncAdapter(TREE, 'head-1');
        const { pipeline, lastOpts } = fakePipelineWithOpts();
        const orch = new RepoIngestionOrchestrator(
            adapter, new FakeFileFilter(), fakeChunkerRegistry(), pipeline, {},   // default CommitChunker
        );

        await orch.ingestRepo('u', 'o/a');

        const known = lastOpts()?.knownFilePaths ?? [];
        expect(known).toEqual(expect.arrayContaining(ALL_PATHS));
        const commitPaths = known.filter((f) => f.startsWith('_commits/'));
        expect(commitPaths).toHaveLength(1);
        expect(commitPaths[0]).toMatch(/^_commits\/\d{4}-W\d{2}\.commit_history$/);
    });

    it('tier-1: HEAD unchanged → fetches nothing, knownFilePaths still full set', async () => {
        const adapter = new ResyncAdapter(TREE, 'head-1');
        const fileStateStore = makeFileStateStore(
            new Map([['a.ts', 'sha-a'], ['b.ts', 'sha-b'], ['c.ts', 'sha-c']]),
        );
        const watermarkStore = makeWatermarkStore('head-1'); // matches head
        const { orch, lastOpts } = build(adapter, { fileStateStore, watermarkStore });

        await orch.ingestRepo('u', 'o/a');

        expect(adapter.fetched).toEqual([]);                 // nothing fetched
        expect(lastOpts()?.knownFilePaths).toEqual(ALL_PATHS); // prune-safety invariant
    });

    it('tier-2: only the changed file fetched, knownFilePaths still full set', async () => {
        const adapter = new ResyncAdapter(TREE, 'head-2');
        const fileStateStore = makeFileStateStore(
            new Map([['a.ts', 'sha-a'], ['b.ts', 'OLD'], ['c.ts', 'sha-c']]),
        );
        const watermarkStore = makeWatermarkStore('head-1'); // differs from head-2
        const { orch, lastOpts } = build(adapter, { fileStateStore, watermarkStore });

        await orch.ingestRepo('u', 'o/a');

        expect(adapter.fetched).toEqual(['b.ts']);             // only changed file
        expect(lastOpts()?.knownFilePaths).toEqual(ALL_PATHS); // prune-safety invariant
    });

    it('deleted file: knownFilePaths = current included only (prunes the removed path)', async () => {
        const adapter = new ResyncAdapter(TREE, 'head-2');
        const fileStateStore = makeFileStateStore(
            // prior state has an extra path 'gone.ts' absent from the current tree
            new Map([['a.ts', 'sha-a'], ['b.ts', 'sha-b'], ['c.ts', 'sha-c'], ['gone.ts', 'sha-gone']]),
        );
        const watermarkStore = makeWatermarkStore('head-1');
        const { orch, lastOpts } = build(adapter, { fileStateStore, watermarkStore });

        await orch.ingestRepo('u', 'o/a');

        expect(lastOpts()?.knownFilePaths).toEqual(ALL_PATHS); // 'gone.ts' excluded
        expect(lastOpts()?.knownFilePaths).not.toContain('gone.ts');
    });

    it('no stores wired: behaves as today — all included fetched', async () => {
        const adapter = new ResyncAdapter(TREE, 'head-1');
        const { orch, lastOpts } = build(adapter); // no stores

        await orch.ingestRepo('u', 'o/a');

        expect(adapter.fetched.sort()).toEqual([...ALL_PATHS].sort());
        expect(lastOpts()?.knownFilePaths).toEqual(ALL_PATHS);
    });

    it('forceReindex: clears state up front, fetches all, refreshes state + watermark', async () => {
        const adapter = new ResyncAdapter(TREE, 'head-9');
        const fileStateStore = makeFileStateStore(
            new Map([['a.ts', 'sha-a'], ['b.ts', 'sha-b'], ['c.ts', 'sha-c']]),
        );
        const watermarkStore = makeWatermarkStore('head-9');
        const { orch } = build(adapter, { fileStateStore, watermarkStore });

        await orch.forceReindex('u', 'o/a');

        expect(fileStateStore.deleteFileState).toHaveBeenCalledWith('u', 'o/a');
        expect(adapter.fetched.sort()).toEqual([...ALL_PATHS].sort());
        expect(fileStateStore.upsertFileState).toHaveBeenCalledWith(
            'u', 'o/a',
            TREE.map(f => ({ path: f.path, blobSha: f.blobSha, sizeBytes: f.sizeBytes })),
        );
        expect(watermarkStore.setLastSyncedCommitSha).toHaveBeenLastCalledWith('u', 'o/a', 'head-9');
    });
});

describe('RepoIngestionOrchestrator archetype-signal persistence', () => {
    afterEach(() => { jest.restoreAllMocks(); });

    it('derives signals from the full file tree and persists them via the sink', async () => {
        const adapter = new SignalAdapter([
            { path: '.github/workflows/deploy.yml', sizeBytes: 1, blobSha: 'sha1' },
            { path: 'Dockerfile',                   sizeBytes: 1, blobSha: 'sha2' },
            { path: 'infra/terraform/main.tf',      sizeBytes: 1, blobSha: 'sha3' },
        ]);
        const saveArchetypeSignals = jest.fn(async () => {});
        const { pipeline } = fakePipeline();
        const orch = new RepoIngestionOrchestrator(
            adapter,
            new FakeFileFilter(),
            fakeChunkerRegistry(),
            pipeline,
            { commitChunker: null, syncStateSignalSink: { saveArchetypeSignals } },
        );

        await orch.ingestRepo('u', 'o/a');

        expect(saveArchetypeSignals).toHaveBeenCalledTimes(1);
        const [userId, repoFullName, signals] = saveArchetypeSignals.mock.calls[0] as unknown as [
            string, string, Record<string, boolean>,
        ];
        expect(userId).toBe('u');
        expect(repoFullName).toBe('o/a');
        expect(signals.has_ci).toBe(true);
        expect(signals.has_dockerfile).toBe(true);
        expect(signals.has_iac).toBe(true);
    });

    it('resolves without throwing when no signal sink is configured', async () => {
        const adapter = new SignalAdapter([{ path: 'Dockerfile', sizeBytes: 1, blobSha: 'sha1' }]);
        const { pipeline } = fakePipeline();
        const orch = new RepoIngestionOrchestrator(
            adapter,
            new FakeFileFilter(),
            fakeChunkerRegistry(),
            pipeline,
            { commitChunker: null },
        );

        await expect(orch.ingestRepo('u', 'o/a')).resolves.toBeDefined();
    });

    it('does not abort ingestion when the sink throws', async () => {
        const adapter = new SignalAdapter([{ path: 'Dockerfile', sizeBytes: 1, blobSha: 'sha1' }]);
        const saveArchetypeSignals = jest.fn(async () => { throw new Error('boom: sink'); });
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { pipeline } = fakePipeline();
        const orch = new RepoIngestionOrchestrator(
            adapter,
            new FakeFileFilter(),
            fakeChunkerRegistry(),
            pipeline,
            { commitChunker: null, syncStateSignalSink: { saveArchetypeSignals } },
        );

        await expect(orch.ingestRepo('u', 'o/a')).resolves.toBeDefined();
        expect(saveArchetypeSignals).toHaveBeenCalledTimes(1);
    });
});
