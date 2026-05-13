import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock @bedrock/shared before imports
jest.mock('@bedrock/shared', () => ({
    PgVectorRetriever: jest.fn(),
    TitanEmbeddingProvider: {
        fromEnvironment: jest.fn(() => ({ embed: jest.fn(), dimension: 1024 })),
    },
    expandQuery: jest.fn(() => [
        'topic deployment reliability outcomes',
        'topic infrastructure architecture tools',
    ]),
}));

import { PgVectorRetriever, expandQuery } from '@bedrock/shared';
import { multiQueryRetrieve } from '../retrieval.js';
import type { Pool } from 'pg';

const MOCK_PASSAGE = {
    text:      'Built k8s cluster',
    score:     0.9,
    source:    'profile' as const,
    sourceUri: 'owner/repo',
    metadata:  { repo_full_name: 'owner/repo' },
};

const DUPLICATE_PASSAGE = {
    text:      'Built k8s cluster',    // same text as MOCK_PASSAGE
    score:     0.85,
    source:    'profile' as const,
    sourceUri: 'owner/repo',           // same sourceUri
    metadata:  { repo_full_name: 'owner/repo' },
};

describe('multiQueryRetrieve', () => {
    let mockRetrieve: jest.Mock<() => Promise<typeof MOCK_PASSAGE[]>>;
    let mockPool: Pool;

    beforeEach(() => {
        mockRetrieve = jest.fn<() => Promise<typeof MOCK_PASSAGE[]>>().mockResolvedValue([]);
        (PgVectorRetriever as jest.Mock).mockImplementation(() => ({
            retrieve: mockRetrieve,
        }));
        mockPool = {} as Pool;
    });

    it('fires exactly 3 retriever calls (one per query)', async () => {
        await multiQueryRetrieve('user-id', 'kubernetes experience', mockPool);
        expect(mockRetrieve).toHaveBeenCalledTimes(3);
    });

    it('calls expandQuery with the original question', async () => {
        await multiQueryRetrieve('user-id', 'kubernetes experience', mockPool);
        expect(expandQuery).toHaveBeenCalledWith('kubernetes experience');
    });

    it('deduplicates passages with identical sourceUri + text prefix', async () => {
        mockRetrieve
            .mockResolvedValueOnce([MOCK_PASSAGE])
            .mockResolvedValueOnce([DUPLICATE_PASSAGE])
            .mockResolvedValueOnce([]);
        const result = await multiQueryRetrieve('user-id', 'kubernetes', mockPool);
        expect(result).toHaveLength(1);
    });

    it('caps results at 8 passages', async () => {
        const passages = Array.from({ length: 10 }, (_, i) => ({
            ...MOCK_PASSAGE, text: `passage ${i}`, sourceUri: `repo/${i}`, score: 0.9 - i * 0.01,
        }));
        mockRetrieve.mockResolvedValue(passages);
        const result = await multiQueryRetrieve('user-id', 'kubernetes', mockPool);
        expect(result.length).toBeLessThanOrEqual(8);
    });

    it('sorts merged results by score descending', async () => {
        const low  = { ...MOCK_PASSAGE, text: 'low score',  sourceUri: 'repo/low',  score: 0.5 };
        const high = { ...MOCK_PASSAGE, text: 'high score', sourceUri: 'repo/high', score: 0.9 };
        mockRetrieve
            .mockResolvedValueOnce([low])
            .mockResolvedValueOnce([high])
            .mockResolvedValueOnce([]);
        const result = await multiQueryRetrieve('user-id', 'test', mockPool);
        expect(result[0].score).toBeGreaterThan(result[1].score);
    });
});
