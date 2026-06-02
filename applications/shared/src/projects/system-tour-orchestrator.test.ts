/**
 * @format
 * runSystemTour — lean orchestration that re-projects an already-generated
 * CaseStudy into a SystemTour: hash(caseStudy) → optional cache → agent →
 * repo.upsert. Mirrors case-study-orchestrator's computeInputHash (sha256
 * over the stable model inputs) and its cache short-circuit. Verified with
 * injected fakes for the agent, repo, and cache.
 */
import { describe, it, expect, jest } from '@jest/globals';

import { runSystemTour } from './system-tour-orchestrator.js';
import type { CaseStudy } from './case-study-types.js';
import type { SystemTour } from './system-tour-types.js';
import type { BasePipelineContext } from '../base-agent.js';

const caseStudy: CaseStudy = {
    tagline: 'A tagline',
    pitch:   'A pitch',
    stack:        [],
    decisions:    [],
    highlights:   [],
    challenges:   [],
    depthMarkers: {
        hasTests:              false,
        testCoverageSignal:    'none',
        hasCi:                 false,
        ciMaturity:            'none',
        documentationDensity:  'readme_only',
        hasDeploymentEvidence: false,
        refactorCount:         0,
    },
    architecture: {
        diagramFormat: 'mermaid',
        diagramSource: 'graph TD; a-->b',
        nodes: [],
        edges: [],
    },
    resumeBullets: [{ angle: 'backend', bullets: ['Did a thing'] }],
};

const tour: SystemTour = {
    area:    'Ingestion pipeline',
    context: 'Sync repos.',
    keyDecisions: [{ decision: 'Watermark', rationale: 'Avoid re-fetch' }],
    tradeoffs:    [],
    systemMap: caseStudy.architecture,
    outcomes:     [],
    whatIdChange: [],
};

const ctx = {} as BasePipelineContext;

function makeAgent(result: SystemTour = tour) {
    return {
        invoke: jest.fn(async () => ({ data: result }) as { data: SystemTour }),
    };
}

function makeRepo() {
    return { upsert: jest.fn(async () => undefined) };
}

describe('runSystemTour — no cache', () => {
    it('invokes the agent and persists via repo.upsert', async () => {
        const agent = makeAgent();
        const repo  = makeRepo();

        const out = await runSystemTour({
            projectId: 'p1',
            userId:    'u1',
            caseStudy,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            agent: agent as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            repo: repo as any,
            ctx,
        });

        expect(agent.invoke).toHaveBeenCalledWith(caseStudy, ctx);
        expect(out.cacheHit).toBe(false);
        expect(out.tour).toEqual(tour);
        expect(typeof out.inputHash).toBe('string');
        expect(out.inputHash.length).toBeGreaterThan(0);

        expect(repo.upsert).toHaveBeenCalledWith('u1', 'p1', tour, out.inputHash);
    });

    it('is deterministic in its hash for identical case studies', async () => {
        const a = await runSystemTour({
            projectId: 'p1', userId: 'u1', caseStudy,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            agent: makeAgent() as any, repo: makeRepo() as any, ctx,
        });
        const b = await runSystemTour({
            projectId: 'p1', userId: 'u1', caseStudy,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            agent: makeAgent() as any, repo: makeRepo() as any, ctx,
        });
        expect(a.inputHash).toBe(b.inputHash);
    });
});

describe('runSystemTour — cache', () => {
    it('short-circuits the agent on a cache hit and still persists', async () => {
        const agent = makeAgent();
        const repo  = makeRepo();
        const cache = {
            get: jest.fn(async () => tour),
            set: jest.fn(async () => undefined),
        };

        const out = await runSystemTour({
            projectId: 'p1', userId: 'u1', caseStudy,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            agent: agent as any, repo: repo as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            cache: cache as any, ctx,
        });

        expect(out.cacheHit).toBe(true);
        expect(agent.invoke).not.toHaveBeenCalled();
        expect(cache.get).toHaveBeenCalledWith(out.inputHash);
        // A cache hit does NOT re-write the cache.
        expect(cache.set).not.toHaveBeenCalled();
        expect(repo.upsert).toHaveBeenCalledWith('u1', 'p1', tour, out.inputHash);
    });

    it('on a cache miss invokes the agent and populates the cache', async () => {
        const agent = makeAgent();
        const repo  = makeRepo();
        const cache = {
            get: jest.fn(async () => null),
            set: jest.fn(async () => undefined),
        };

        const out = await runSystemTour({
            projectId: 'p1', userId: 'u1', caseStudy,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            agent: agent as any, repo: repo as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            cache: cache as any, ctx,
        });

        expect(out.cacheHit).toBe(false);
        expect(agent.invoke).toHaveBeenCalledTimes(1);
        expect(cache.set).toHaveBeenCalledWith(out.inputHash, tour);
        expect(repo.upsert).toHaveBeenCalledWith('u1', 'p1', tour, out.inputHash);
    });
});
