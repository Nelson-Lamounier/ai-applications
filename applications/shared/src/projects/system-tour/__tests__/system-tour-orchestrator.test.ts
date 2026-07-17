/**
 * @format
 * runSystemTour — lean orchestration that re-projects an already-generated
 * CaseStudy into a SystemTour: hash(caseStudy) → optional cache → agent →
 * repo.upsert. Mirrors case-study-orchestrator's computeInputHash (sha256
 * over the stable model inputs) and its cache short-circuit. Verified with
 * injected fakes for the agent, repo, and cache.
 */
import { describe, it, expect, jest } from '@jest/globals';

import { runSystemTour } from '../system-tour-orchestrator.js';
import type { CaseStudy } from '../../case-study/case-study-types.js';
import type { SystemTour } from '../system-tour-types.js';
import type { BasePipelineContext } from '../../../base-agent.js';

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

describe('semanticTourCache — ISemanticCache adapter (P1.4 cost fix)', () => {
    const opts = { userId: 'u1', projectId: 'p1', kbTag: 'dev:v1:sonnet' };

    it('reads through with the scoped key and validates the hit', async () => {
        const { semanticTourCache } = await import('../system-tour-orchestrator.js');
        const get = jest.fn(async (_input: unknown) => ({ hit: true as const, response: tour, similarity: 1 }));
        const sc = { get, put: jest.fn(async () => undefined), invalidate: jest.fn(async () => 0) };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const out = await semanticTourCache(sc as any, opts).get('abc123');
        expect(out).toEqual(tour);
        expect(get).toHaveBeenCalledWith({
            scope: 'systemtour:u1:p1', kbTag: 'dev:v1:sonnet', queryText: 'abc123',
        });
    });

    it('treats malformed payloads and cache errors as misses (fail-open)', async () => {
        const { semanticTourCache } = await import('../system-tour-orchestrator.js');
        const bad = {
            get: async () => ({ hit: true as const, response: { nope: true }, similarity: 1 }),
            put: async () => undefined, invalidate: async () => 0,
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(await semanticTourCache(bad as any, opts).get('h')).toBeNull();
        const boom = {
            get: async () => { throw new Error('redis down'); },
            put: async () => { throw new Error('redis down'); },
            invalidate: async () => 0,
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const adapter = semanticTourCache(boom as any, opts);
        expect(await adapter.get('h')).toBeNull();
        await expect(adapter.set('h', tour)).resolves.toBeUndefined();
    });

    it('writes through with the same key shape', async () => {
        const { semanticTourCache } = await import('../system-tour-orchestrator.js');
        const put = jest.fn(async (_input: unknown) => undefined);
        const sc = { get: async () => ({ hit: false as const }), put, invalidate: async () => 0 };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await semanticTourCache(sc as any, opts).set('abc123', tour);
        expect(put).toHaveBeenCalledWith({
            scope: 'systemtour:u1:p1', kbTag: 'dev:v1:sonnet', queryText: 'abc123', response: tour,
        });
    });
});
