/** @format */
const loadRepoDigestsMock = jest.fn();
const loadDescriptionEmbeddingsMock = jest.fn();
const persistClusteringResultMock = jest.fn();
const loadRepoRoleSignalsMock = jest.fn();
const applyGroundedComponentKindsMock = jest.fn((result) => result);

jest.mock('./clustering-loader.js', () => ({
    loadRepoDigests: loadRepoDigestsMock,
    loadDescriptionEmbeddings: loadDescriptionEmbeddingsMock,
}));
jest.mock('./clustering-persistence.js', () => ({
    persistClusteringResult: persistClusteringResultMock,
}));
jest.mock('./repo-role-signals.js', () => ({
    loadRepoRoleSignals: loadRepoRoleSignalsMock,
}));
jest.mock('./grounded-components.js', () => ({
    applyGroundedComponentKinds: applyGroundedComponentKindsMock,
}));

import {
    computeClusteringInputHash,
    runClusteringOrchestration,
} from './clustering-orchestrator.js';
import type { BasePipelineContext } from '../base-agent.js';
import type { WorkflowTrace } from '../observability/workflow-trace.js';
import type {
    ClusteringResult,
    ClusteringSignals,
    RepoClusteringDigest,
} from './types.js';

const REPO_A = '00000000-0000-4000-8000-000000000001';
const REPO_B = '00000000-0000-4000-8000-000000000002';

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

const clusteringResult: ClusteringResult = {
    proposals: [{
        name: 'Platform',
        confidence: 'high',
        reasoning: 'The repositories form one deployable product.',
        components: [{
            name: 'Application',
            kind: 'shared',
            repositoryIds: [REPO_A, REPO_B],
        }],
    }],
};

function makePipelineContext(): BasePipelineContext {
    return {
        pipelineId: 'run-1',
        environment: 'test',
        cumulativeTokens: { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
    };
}

function makePool() {
    return {
        connect: jest.fn().mockResolvedValue({ release: jest.fn() }),
    };
}

function makeWorkflow(stages: string[]): WorkflowTrace {
    return {
        traceId: '0123456789abcdef0123456789abcdef',
        rootSpan: {} as WorkflowTrace['rootSpan'],
        setAttributes: jest.fn(),
        stage: jest.fn(async (name, _attributes, work) => {
            stages.push(name);
            return work();
        }),
    };
}

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

describe('runClusteringOrchestration tracing', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        loadRepoDigestsMock.mockResolvedValue([
            digest(REPO_A, ['react']),
            digest(REPO_B, ['node']),
        ]);
        loadDescriptionEmbeddingsMock.mockResolvedValue([]);
        loadRepoRoleSignalsMock.mockResolvedValue(new Map());
        applyGroundedComponentKindsMock.mockImplementation((result) => result);
        persistClusteringResultMock.mockResolvedValue({
            proposalsInserted: 1,
            componentsInserted: 1,
            linksInserted: 2,
            proposalsSkipped: 0,
            priorProposalsCleared: 0,
        });
    });

    it('traces a cache miss in execution order and reports real statuses', async () => {
        const stages: string[] = [];
        const statuses: string[] = [];
        const agent = { invoke: jest.fn().mockResolvedValue({ data: clusteringResult }) };
        const cache = {
            get: jest.fn().mockResolvedValue({ hit: false }),
            put: jest.fn().mockResolvedValue(undefined),
            invalidate: jest.fn(),
        };

        await runClusteringOrchestration(makePool() as never, {
            userId: 'user-1',
            pipelineRunId: 'run-1',
            agent: agent as never,
            ctx: makePipelineContext(),
            cache: cache as never,
            workflow: makeWorkflow(stages),
            onStage: async (stage) => { statuses.push(stage); },
        });

        expect(stages).toEqual([
            'project.clustering.load_signals',
            'project.clustering.cache_lookup',
            'project.clustering.generate',
            'project.clustering.ground_components',
            'project.clustering.persist',
            'project.clustering.cache_write',
        ]);
        expect(statuses).toEqual(['signals_extracting', 'analysing', 'persisting']);
    });

    it('traces a cache hit without generation and still persists', async () => {
        const stages: string[] = [];
        const statuses: string[] = [];
        const agent = { invoke: jest.fn() };
        const cache = {
            get: jest.fn().mockResolvedValue({ hit: true, response: clusteringResult }),
            put: jest.fn(),
            invalidate: jest.fn(),
        };

        await runClusteringOrchestration(makePool() as never, {
            userId: 'user-1',
            pipelineRunId: 'run-1',
            agent: agent as never,
            ctx: makePipelineContext(),
            cache: cache as never,
            workflow: makeWorkflow(stages),
            onStage: async (stage) => { statuses.push(stage); },
        });

        expect(stages).toEqual([
            'project.clustering.load_signals',
            'project.clustering.cache_lookup',
            'project.clustering.ground_components',
            'project.clustering.persist',
        ]);
        expect(statuses).toEqual(['signals_extracting', 'persisting']);
        expect(agent.invoke).not.toHaveBeenCalled();
        expect(cache.put).not.toHaveBeenCalled();
    });

    it('preserves the solo-repository short circuit inside signal loading', async () => {
        const stages: string[] = [];
        const statuses: string[] = [];
        const agent = { invoke: jest.fn() };
        loadRepoDigestsMock.mockResolvedValue([digest(REPO_A, ['react'])]);

        const result = await runClusteringOrchestration(makePool() as never, {
            userId: 'user-1',
            pipelineRunId: 'run-1',
            agent: agent as never,
            ctx: makePipelineContext(),
            workflow: makeWorkflow(stages),
            onStage: async (stage) => { statuses.push(stage); },
        });

        expect(stages).toEqual(['project.clustering.load_signals']);
        expect(statuses).toEqual(['signals_extracting']);
        expect(result.result.proposals).toEqual([]);
        expect(agent.invoke).not.toHaveBeenCalled();
        expect(persistClusteringResultMock).not.toHaveBeenCalled();
    });

});
