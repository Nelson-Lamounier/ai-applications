import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Pool, PoolClient } from 'pg';

// ─── Pool mock helpers ────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockClient = {
    query:   jest.Mock<any>;
    release: jest.Mock<any>;
};

function makeClient(dataRows: unknown[]): MockClient {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: jest.Mock<any> = jest.fn() as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (query as any)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)   // BEGIN
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)   // SET LOCAL
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce({ rows: dataRows, rowCount: dataRows.length } as any) // query
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);  // COMMIT
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const release: jest.Mock<any> = jest.fn();
    return { query, release };
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
    let mockConnect: jest.Mock;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let pool:        any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let embedder:    any;
    let retriever:   PgVectorRetriever;

    beforeEach(() => {
        mockConnect = jest.fn();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pool        = { connect: mockConnect } as any;
        embedder    = {
            embed: jest.fn<IEmbeddingProvider['embed']>().mockResolvedValue(FAKE_EMBEDDING),
            dimension: 1024,
        };
        retriever   = new PgVectorRetriever(pool, embedder as IEmbeddingProvider);
    });

    it('calls embedder.embed with the query text', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mockConnect as any)
            .mockResolvedValueOnce(makeClient([]) as unknown as PoolClient)
            .mockResolvedValueOnce(makeClient([]) as unknown as PoolClient);
        await retriever.retrieve(USER_ID, 'kubernetes operator');
        expect(embedder.embed).toHaveBeenCalledWith('kubernetes operator');
    });

    it('returns profile passages with source="profile"', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mockConnect as any)
            .mockResolvedValueOnce(makeClient([PROFILE_ROW]) as unknown as PoolClient)
            .mockResolvedValueOnce(makeClient([]) as unknown as PoolClient);
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mockConnect as any)
            .mockResolvedValueOnce(makeClient([]) as unknown as PoolClient)
            .mockResolvedValueOnce(makeClient([CHUNK_ROW]) as unknown as PoolClient);
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mockConnect as any)
            .mockResolvedValueOnce(makeClient([PROFILE_ROW]) as unknown as PoolClient)
            .mockResolvedValueOnce(makeClient([CHUNK_ROW]) as unknown as PoolClient);
        const results = await retriever.retrieve(USER_ID, 'kubernetes');
        expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
        expect(results[0]!.source).toBe('profile');
        expect(results[1]!.source).toBe('chunk');
    });

    it('passes maxProfiles as LIMIT to profile query', async () => {
        const profileClient = makeClient([]);
        const chunkClient   = makeClient([]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mockConnect as any)
            .mockResolvedValueOnce(profileClient as unknown as PoolClient)
            .mockResolvedValueOnce(chunkClient   as unknown as PoolClient);
        await retriever.retrieve(USER_ID, 'test', { maxProfiles: 3 });
        // The 4th call (index 3) is the actual query; check that $4 = 3
        const actualQueryCall = profileClient.query.mock.calls[2];
        expect(actualQueryCall![1]).toContain(3);
    });

    it('passes maxChunks as LIMIT to chunk query', async () => {
        const profileClient = makeClient([]);
        const chunkClient   = makeClient([]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mockConnect as any)
            .mockResolvedValueOnce(profileClient as unknown as PoolClient)
            .mockResolvedValueOnce(chunkClient   as unknown as PoolClient);
        await retriever.retrieve(USER_ID, 'test', { maxChunks: 2 });
        // The 4th call (index 3) for chunk client is the actual query
        const actualQueryCall = chunkClient.query.mock.calls[2];
        expect(actualQueryCall![1]).toContain(2);
    });

    it('rolls back and rethrows when profile query throws', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const failQuery: jest.Mock<any> = jest.fn() as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (failQuery as any)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .mockResolvedValueOnce({ rows: [] } as any)  // BEGIN
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .mockResolvedValueOnce({ rows: [] } as any)  // SET LOCAL
            .mockRejectedValueOnce(new Error('DB error'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const failRelease: jest.Mock<any> = jest.fn();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const failClient: MockClient = {
            query:   failQuery,
            release: failRelease,
        };
        const chunkClient = makeClient([]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mockConnect as any)
            .mockResolvedValueOnce(failClient as unknown as PoolClient)
            .mockResolvedValueOnce(chunkClient as unknown as PoolClient);
        await expect(retriever.retrieve(USER_ID, 'test')).rejects.toThrow('DB error');
        expect(failClient.release).toHaveBeenCalled();
        expect(failClient.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('returns empty array when both layers return no rows', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mockConnect as any)
            .mockResolvedValueOnce(makeClient([]) as unknown as PoolClient)
            .mockResolvedValueOnce(makeClient([]) as unknown as PoolClient);
        const results = await retriever.retrieve(USER_ID, 'nothing');
        expect(results).toEqual([]);
    });
});
