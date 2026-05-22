/** @format */
import { computeClusteringInputHash } from './clustering-orchestrator.js';
import type { RepoClusteringDigest, ClusteringSignals } from './types.js';

function digest(id: string, stack: string[]): RepoClusteringDigest {
    return {
        repositoryId: id,
        fullName: `owner/${id}`,
        shortName: id,
        primaryLanguage: 'TypeScript',
        topics: ['web'],
        firstSeenAt: null,
        lastSyncedAt: null,
        techStack: stack,
        classification: 'single_repo',
    };
}

const emptySignals: ClusteringSignals = {
    namingPrefixes: new Map(),
    sharedTopics: new Map(),
    sharedTechStack: new Map(),
    embeddingPairs: [],
};

describe('computeClusteringInputHash', () => {
    it('is stable for identical inputs regardless of digest order', () => {
        const a = computeClusteringInputHash([digest('a', ['react']), digest('b', ['node'])], emptySignals);
        const b = computeClusteringInputHash([digest('b', ['node']), digest('a', ['react'])], emptySignals);
        expect(a).toBe(b);
    });

    it('changes when a digest tech stack changes', () => {
        const a = computeClusteringInputHash([digest('a', ['react'])], emptySignals);
        const b = computeClusteringInputHash([digest('a', ['vue'])], emptySignals);
        expect(a).not.toBe(b);
    });

    it('changes when an embedding pair changes', () => {
        const a = computeClusteringInputHash([digest('a', ['react'])], emptySignals);
        const b = computeClusteringInputHash([digest('a', ['react'])], {
            ...emptySignals,
            embeddingPairs: [{ repoA: 'owner/a', repoB: 'owner/b', score: 0.9 }],
        });
        expect(a).not.toBe(b);
    });
});
