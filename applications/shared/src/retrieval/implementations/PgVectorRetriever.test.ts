import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Pool, PoolClient } from 'pg';

// ─── Pool mock helpers ────────────────────────────────────────────────────────

// Narrowed to the Promise overload so mockResolvedValueOnce infers PoolClient, not never.
type ConnectMock = jest.MockedFunction<() => Promise<PoolClient>>;

// as-never casts silence Jest's chained-mock type narrowing (which collapses to never
// after the first call).  They are genuinely required — not SonarQube false positives.
function makeQueryMock(dataRows: unknown[]): jest.Mock {
    return jest.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        .mockResolvedValueOnce({ rows: dataRows, rowCount: dataRows.length } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
}

function makeClient(dataRows: unknown[]): PoolClient {
    return { query: makeQueryMock(dataRows), release: jest.fn() } as unknown as PoolClient;
}

function makeFailClient(error: Error): { client: PoolClient; query: jest.Mock; release: jest.Mock } {
    const query = jest.fn()
        .mockResolvedValueOnce({ rows: [] } as never)
        .mockResolvedValueOnce({ rows: [] } as never)
        .mockRejectedValueOnce(error as never);
    const release = jest.fn();
    return { client: { query, release } as unknown as PoolClient, query, release };
}

// ─── Imports after mock setup ─────────────────────────────────────────────────

import { PgVectorRetriever } from './PgVectorRetriever.js';
import type { IEmbeddingProvider } from '../../rds/interfaces/IEmbeddingProvider.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FAKE_EMBEDDING = new Array(1024).fill(0.1) as number[];
const USER_ID        = 'user-00000000-0000-0000-0000-000000000001';

const PROFILE_ROW = {
    content:        'Automated Kubernetes drift remediation across multi-env EKS clusters.',
    chunk_type:     'highlight',
    metadata:       {},
    repo_full_name: 'owner/k8s-operator',
    domain:         'devops',
    tech_stack:     ['Kubernetes', 'Go'],
    score:          1.2,   // 0.8 raw × 1.5 weight
};

const CHUNK_ROW = {
    content:        'This file implements the reconciliation loop.',
    repo_full_name: 'owner/k8s-operator',
    file_path:      'pkg/reconcile/loop.go',
    metadata:       {},
    score:          0.7,
};

describe('PgVectorRetriever', () => {
    let mockConnect: ConnectMock;
    let pool:        Pool;
    let embedder:    IEmbeddingProvider;
    let retriever:   PgVectorRetriever;

    beforeEach(() => {
        mockConnect = jest.fn() as ConnectMock;
        pool        = { connect: mockConnect } as unknown as Pool;
        embedder    = {
            embed:     jest.fn().mockResolvedValue(FAKE_EMBEDDING as never),
            dimension: 1024,
        } as unknown as IEmbeddingProvider;
        retriever   = new PgVectorRetriever(pool, embedder);
    });

    it('calls embedder.embed with the query text', async () => {
        mockConnect
            .mockResolvedValueOnce(makeClient([]))
            .mockResolvedValueOnce(makeClient([]));
        await retriever.retrieve(USER_ID, 'kubernetes operator');
        expect(embedder.embed).toHaveBeenCalledWith('kubernetes operator');
    });

    it('returns profile passages with source="profile"', async () => {
        mockConnect
            .mockResolvedValueOnce(makeClient([PROFILE_ROW]))
            .mockResolvedValueOnce(makeClient([]));
        const results = await retriever.retrieve(USER_ID, 'kubernetes');
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            text:      PROFILE_ROW.content,
            score:     PROFILE_ROW.score,
            source:    'profile',
            sourceUri: PROFILE_ROW.repo_full_name,
            metadata: {
                repo_full_name: PROFILE_ROW.repo_full_name,
                chunk_type:     PROFILE_ROW.chunk_type,
                domain:         PROFILE_ROW.domain,
                technologies:   PROFILE_ROW.tech_stack,
            },
        });
    });

    it('returns chunk passages with source="chunk"', async () => {
        mockConnect
            .mockResolvedValueOnce(makeClient([]))
            .mockResolvedValueOnce(makeClient([CHUNK_ROW]));
        const results = await retriever.retrieve(USER_ID, 'reconciliation');
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            text:      CHUNK_ROW.content,
            score:     CHUNK_ROW.score,
            source:    'chunk',
            sourceUri: CHUNK_ROW.file_path,
            metadata: {
                repo_full_name: CHUNK_ROW.repo_full_name,
                file_path:      CHUNK_ROW.file_path,
            },
        });
    });

    it('merges and sorts results by score descending', async () => {
        mockConnect
            .mockResolvedValueOnce(makeClient([PROFILE_ROW]))
            .mockResolvedValueOnce(makeClient([CHUNK_ROW]));
        const results = await retriever.retrieve(USER_ID, 'kubernetes');
        expect(results[0].score).toBeGreaterThan(results[1].score);
        expect(results[0].source).toBe('profile');
        expect(results[1].source).toBe('chunk');
    });

    it('passes maxProfiles as LIMIT to profile query', async () => {
        const profileQuery = makeQueryMock([]);
        const profileClient = { query: profileQuery, release: jest.fn() } as unknown as PoolClient;
        mockConnect
            .mockResolvedValueOnce(profileClient)
            .mockResolvedValueOnce(makeClient([]));
        await retriever.retrieve(USER_ID, 'test', { maxProfiles: 3 });
        // Index 2 is the actual query call (after BEGIN and SET LOCAL)
        expect(profileQuery.mock.calls[2][1]).toContain(3);
    });

    it('passes maxChunks as LIMIT to chunk query', async () => {
        const chunkQuery = makeQueryMock([]);
        const chunkClient = { query: chunkQuery, release: jest.fn() } as unknown as PoolClient;
        mockConnect
            .mockResolvedValueOnce(makeClient([]))
            .mockResolvedValueOnce(chunkClient);
        await retriever.retrieve(USER_ID, 'test', { maxChunks: 2 });
        // Index 2 is the actual query call (after BEGIN and SET LOCAL)
        expect(chunkQuery.mock.calls[2][1]).toContain(2);
    });

    it('rolls back and rethrows when profile query throws', async () => {
        const { client, query, release } = makeFailClient(new Error('DB error'));
        mockConnect
            .mockResolvedValueOnce(client)
            .mockResolvedValueOnce(makeClient([]));
        await expect(retriever.retrieve(USER_ID, 'test')).rejects.toThrow('DB error');
        expect(query).toHaveBeenCalledWith('ROLLBACK');
        expect(release).toHaveBeenCalled();
    });

    it('rolls back and rethrows when chunk query throws', async () => {
        const { client, query, release } = makeFailClient(new Error('chunk DB error'));
        mockConnect
            .mockResolvedValueOnce(makeClient([]))
            .mockResolvedValueOnce(client);
        await expect(retriever.retrieve(USER_ID, 'test')).rejects.toThrow('chunk DB error');
        expect(query).toHaveBeenCalledWith('ROLLBACK');
        expect(release).toHaveBeenCalled();
    });

    it('returns empty array when both layers return no rows', async () => {
        mockConnect
            .mockResolvedValueOnce(makeClient([]))
            .mockResolvedValueOnce(makeClient([]));
        const results = await retriever.retrieve(USER_ID, 'nothing');
        expect(results).toEqual([]);
    });

    // ─── repo-signals / evidence-topology in the profile layer ─────────────
    describe('repo signals + primary language', () => {
        const SIGNAL_ROW = {
            ...PROFILE_ROW,
            score: 1.2, // 0.8 cosine × 1.5 weight
            archetype_signals: { has_ci: 'true', has_iac: 'true' },
            evidence_topology: { has_test_script: 'true', primary_language: 'TypeScript' },
            primary_language: 'TypeScript',
        };

        it('exposes primaryLanguage on the profile passage', async () => {
            mockConnect.mockResolvedValueOnce(makeClient([SIGNAL_ROW])).mockResolvedValueOnce(makeClient([]));
            const results = await retriever.retrieve(USER_ID, 'q');
            expect(results[0].metadata.primaryLanguage).toBe('TypeScript');
        });

        it('passes filterByRepoSignals to the profile query params', async () => {
            const q = makeQueryMock([]);
            const client = { query: q, release: jest.fn() } as unknown as PoolClient;
            mockConnect.mockResolvedValueOnce(client).mockResolvedValueOnce(makeClient([]));
            await retriever.retrieve(USER_ID, 'q', { filterByRepoSignals: ['has_ci', 'has_iac'] });
            const params = q.mock.calls[2][1] as unknown[];
            expect(params).toContainEqual(['has_ci', 'has_iac']);
        });

        it('passes filterByPrimaryLanguage to the profile query params', async () => {
            const q = makeQueryMock([]);
            const client = { query: q, release: jest.fn() } as unknown as PoolClient;
            mockConnect.mockResolvedValueOnce(client).mockResolvedValueOnce(makeClient([]));
            await retriever.retrieve(USER_ID, 'q', { filterByPrimaryLanguage: ['TypeScript', 'Go'] });
            const params = q.mock.calls[2][1] as unknown[];
            expect(params).toContainEqual(['TypeScript', 'Go']);
        });

        it('boosts profiles whose repo has the requested signals', async () => {
            mockConnect.mockResolvedValueOnce(makeClient([SIGNAL_ROW])).mockResolvedValueOnce(makeClient([]));
            const results = await retriever.retrieve(USER_ID, 'q', { boostByRepoSignals: ['has_ci', 'has_iac'] });
            // 1.2 × (1 + 0.1 × 2 matched) = 1.44
            expect(results[0].score).toBeCloseTo(1.44, 5);
        });

        it('does not boost when a requested signal is absent', async () => {
            mockConnect.mockResolvedValueOnce(makeClient([SIGNAL_ROW])).mockResolvedValueOnce(makeClient([]));
            const results = await retriever.retrieve(USER_ID, 'q', { boostByRepoSignals: ['has_mobile'] });
            expect(results[0].score).toBeCloseTo(1.2, 5);
        });
    });

    // ─── fileClass filter + weighting ──────────────────────────────────────
    describe('fileClass', () => {
        it('exposes fileClass from chunk metadata on the passage', async () => {
            const row = { ...CHUNK_ROW, metadata: { fileClass: 'source' } };
            mockConnect.mockResolvedValueOnce(makeClient([])).mockResolvedValueOnce(makeClient([row]));
            const results = await retriever.retrieve(USER_ID, 'q', { neighbourRadius: 0 });
            expect(results[0].metadata.fileClass).toBe('source');
        });

        it('down-weights low-signal classes (test) by the default weight map', async () => {
            const row = { ...CHUNK_ROW, score: 0.8, metadata: { fileClass: 'test' } };
            mockConnect.mockResolvedValueOnce(makeClient([])).mockResolvedValueOnce(makeClient([row]));
            const results = await retriever.retrieve(USER_ID, 'q', { neighbourRadius: 0 });
            // 0.8 cosine × 0.6 test weight = 0.48 (source would stay ~0.8).
            expect(results[0].score).toBeCloseTo(0.48, 5);
        });

        it('leaves source chunks at full weight', async () => {
            const row = { ...CHUNK_ROW, score: 0.8, metadata: { fileClass: 'source' } };
            mockConnect.mockResolvedValueOnce(makeClient([])).mockResolvedValueOnce(makeClient([row]));
            const results = await retriever.retrieve(USER_ID, 'q', { neighbourRadius: 0 });
            expect(results[0].score).toBeCloseTo(0.8, 5);
        });

        it('passes filterByFileClass through to the chunk query params', async () => {
            const chunkQuery = makeQueryMock([]);
            const chunkClient = { query: chunkQuery, release: jest.fn() } as unknown as PoolClient;
            mockConnect.mockResolvedValueOnce(makeClient([])).mockResolvedValueOnce(chunkClient);
            await retriever.retrieve(USER_ID, 'q', { filterByFileClass: ['iac', 'source'], neighbourRadius: 0 });
            const params = chunkQuery.mock.calls[2][1] as unknown[];
            expect(params).toContainEqual(['iac', 'source']);
        });
    });

    // ─── docType filter ─────────────────────────────────────────────────────
    describe('docType', () => {
        it('passes filterByDocType through to the chunk query params', async () => {
            const chunkQuery = makeQueryMock([]);
            const chunkClient = { query: chunkQuery, release: jest.fn() } as unknown as PoolClient;
            mockConnect.mockResolvedValueOnce(makeClient([])).mockResolvedValueOnce(chunkClient);
            await retriever.retrieve(USER_ID, 'q', { filterByDocType: ['adr', 'readme'], neighbourRadius: 0 });
            const params = chunkQuery.mock.calls[2][1] as unknown[];
            expect(params).toContainEqual(['adr', 'readme']);
        });

        it('binds null when filterByDocType is absent (fail-open, unchanged shape)', async () => {
            const chunkQuery = makeQueryMock([]);
            const chunkClient = { query: chunkQuery, release: jest.fn() } as unknown as PoolClient;
            mockConnect.mockResolvedValueOnce(makeClient([])).mockResolvedValueOnce(chunkClient);
            await retriever.retrieve(USER_ID, 'q', { neighbourRadius: 0 });
            const params = chunkQuery.mock.calls[2][1] as unknown[];
            expect(params[params.length - 1]).toBeNull();
        });
    });

    // ─── Neighbour expansion ───────────────────────────────────────────────
    describe('neighbour expansion', () => {
        const ANCHOR = {
            content:        'middle chunk — the actual vector hit',
            repo_full_name: 'owner/k8s-operator',
            file_path:      'pkg/reconcile/loop.go',
            metadata:       {},
            chunk_index:    2,
            score:          0.7,
        };
        const PREV = {
            content:        'preceding chunk of the same file',
            repo_full_name: 'owner/k8s-operator',
            file_path:      'pkg/reconcile/loop.go',
            metadata:       {},
            chunk_index:    1,
        };
        const NEXT = {
            content:        'following chunk of the same file',
            repo_full_name: 'owner/k8s-operator',
            file_path:      'pkg/reconcile/loop.go',
            metadata:       {},
            chunk_index:    3,
        };

        /** Chunk-layer client: BEGIN, SET LOCAL, main query, neighbour query, COMMIT. */
        function makeChunkClient(primaryRows: unknown[], neighbourRows: unknown[]): {
            client: PoolClient;
            query: jest.Mock;
        } {
            const query = jest.fn()
                .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // BEGIN
                .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // SET LOCAL
                .mockResolvedValueOnce({ rows: primaryRows, rowCount: primaryRows.length } as never)
                .mockResolvedValueOnce({ rows: neighbourRows, rowCount: neighbourRows.length } as never)
                .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // COMMIT
            return { client: { query, release: jest.fn() } as unknown as PoolClient, query };
        }

        it('pulls adjacent chunks of the same file after a hit (radius 1)', async () => {
            const { client } = makeChunkClient([ANCHOR], [PREV, NEXT]);
            mockConnect.mockResolvedValueOnce(makeClient([])).mockResolvedValueOnce(client);

            const results = await retriever.retrieve(USER_ID, 'reconciliation');

            const texts = results.map((r) => r.text);
            expect(texts).toContain(ANCHOR.content);
            expect(texts).toContain(PREV.content);
            expect(texts).toContain(NEXT.content);
            expect(results).toHaveLength(3);
        });

        it('tags neighbours and ranks them just below their anchor', async () => {
            const { client } = makeChunkClient([ANCHOR], [PREV, NEXT]);
            mockConnect.mockResolvedValueOnce(makeClient([])).mockResolvedValueOnce(client);

            const results = await retriever.retrieve(USER_ID, 'reconciliation');

            const anchor = results.find((r) => r.text === ANCHOR.content);
            const prev = results.find((r) => r.text === PREV.content);
            expect(anchor!.score).toBeGreaterThan(prev!.score);
            expect(prev!.metadata.neighbourOf).toBe('pkg/reconcile/loop.go#2');
        });

        it('does not duplicate a chunk already returned as a primary hit', async () => {
            const { client } = makeChunkClient([ANCHOR], [ANCHOR, NEXT]);
            mockConnect.mockResolvedValueOnce(makeClient([])).mockResolvedValueOnce(client);

            const results = await retriever.retrieve(USER_ID, 'reconciliation');

            const anchorHits = results.filter((r) => r.text === ANCHOR.content);
            expect(anchorHits).toHaveLength(1);
        });

        it('neighbourRadius 0 disables expansion (no neighbour query)', async () => {
            mockConnect
                .mockResolvedValueOnce(makeClient([]))
                .mockResolvedValueOnce(makeClient([ANCHOR]));
            const results = await retriever.retrieve(USER_ID, 'reconciliation', {
                neighbourRadius: 0,
            });
            expect(results).toHaveLength(1);
            expect(results[0].text).toBe(ANCHOR.content);
        });
    });
});
