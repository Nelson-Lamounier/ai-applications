/**
 * @format
 * Unit tests for computeInputHash — the stable cache-key hash over the
 * inputs that influence the case-study model output. Commit SHAs and PR
 * identity (number/state/mergedAt) must both feed the hash so a change to
 * the underlying evidence busts the semantic cache.
 */
const loadCaseStudyContextMock = jest.fn();
const persistCaseStudyMock = jest.fn();
const reconstructPriorCaseStudyMock = jest.fn();
const underrepresentedReposMock = jest.fn(() => []);
const scopeEvidenceToReposMock = jest.fn((context) => context);

jest.mock('./case-study-loader.js', () => ({
    loadCaseStudyContext: loadCaseStudyContextMock,
}));
jest.mock('./case-study-persistence.js', () => ({
    persistCaseStudy: persistCaseStudyMock,
}));
jest.mock('./case-study-refine.js', () => ({
    reconstructPriorCaseStudy: reconstructPriorCaseStudyMock,
    underrepresentedRepos: underrepresentedReposMock,
    scopeEvidenceToRepos: scopeEvidenceToReposMock,
}));

import {
    computeInputHash,
    runCaseStudyOrchestration,
    summarizeGrounding,
} from './case-study-orchestrator.js';
import type { BasePipelineContext } from '../base-agent.js';
import type { WorkflowTrace } from '../observability/workflow-trace.js';
import type { LoadCaseStudyContextResult } from './case-study-loader.js';
import type { CaseStudy, CaseStudyContext, SourceSignal } from './case-study-types.js';

type Commit = CaseStudyContext['commits'][number];
type Pull = CaseStudyContext['pulls'][number];

function makeContext(overrides?: {
    commits?: Commit[];
    pulls?: Pull[];
    archetype?: { id: string; name: string } | null;
    stage?: 'junior' | 'mid' | 'senior' | 'staff' | null;
}): LoadCaseStudyContextResult {
    const context: CaseStudyContext = {
        projectId:     'proj-1',
        projectName:   'Example Project',
        tagline:       'A tagline',
        pitch:         'A pitch',
        userOverrides: {},
        components: [
            { id: 'c1', name: 'api', kind: 'service' },
        ],
        repositories: [
            {
                id:              'r1',
                fullName:        'acme/api',
                primaryLanguage: 'TypeScript',
                topics:          ['backend'],
                techStack:       ['node', 'pg'],
                defaultBranch:   'main',
            },
        ],
        commits: overrides?.commits ?? [
            {
                repoFullName: 'acme/api',
                sha:          'abc1234',
                authoredAt:   '2026-01-01T00:00:00.000Z',
                authorName:   'Alice',
                message:      'init',
            },
        ],
        pulls: overrides?.pulls ?? [],
        kbChunks: [],
        archetype: overrides?.archetype ?? null,
        stage:     overrides?.stage ?? null,
    };
    return { userId: 'user-1', context };
}

const onePull: Pull = {
    repoFullName: 'acme/api',
    number:       42,
    title:        'Add feature',
    body:         'body text',
    state:        'open',
    mergedAt:     null,
    htmlUrl:      'https://github.com/acme/api/pull/42',
};

function makeSignal(grounding: SourceSignal['grounding']): SourceSignal {
    return {
        commits: [{ repoFullName: 'acme/api', sha: 'abc1234', authoredAt: '2026-01-01T00:00:00.000Z', message: 'init' }],
        pulls:   [],
        files:   [],
        ungroundedClaims: grounding === 'NOT_GROUNDED' ? ['unsupported claim'] : [],
        grounding,
    };
}

function caseStudyWithVerdicts(
    decision: SourceSignal['grounding'] = 'NOT_VERIFIED',
    highlight: SourceSignal['grounding'] = 'NOT_VERIFIED',
    challenge: SourceSignal['grounding'] = 'NOT_VERIFIED',
): CaseStudy {
    return {
        tagline: 'A recruiter-facing project summary',
        pitch:   'I built a product that solves a real problem.',
        stack:   [],
        decisions: [{
            title:         'Used queues',
            context:       'Traffic spikes caused back-pressure.',
            decision:      'I added a queue.',
            consequences:  'Workers could retry safely.',
            confidence:    'high',
            sourceSignals: makeSignal(decision),
        }],
        highlights: [{
            title:         'Launched self-serve flow',
            description:   'Customers could onboard without support.',
            sourceSignals: makeSignal(highlight),
        }],
        challenges: [{
            problem:       'Imports timed out on large payloads.',
            solution:      'I moved them into a background worker.',
            sourceSignals: makeSignal(challenge),
        }],
        depthMarkers: {
            hasTests:              true,
            testCoverageSignal:    'moderate',
            hasCi:                 true,
            ciMaturity:            'basic',
            documentationDensity:  'docs_dir',
            hasDeploymentEvidence: true,
            deploymentUrl:         'https://example.com',
            refactorCount:         1,
        },
        architecture: {
            diagramFormat: 'mermaid',
            diagramSource: 'graph TD\nA[API] --> B[(DB)]',
            nodes:         [],
            edges:         [],
        },
        resumeBullets: [{
            angle:   'backend',
            bullets: ['Built an asynchronous import pipeline.'],
        }],
    };
}

function makePersisted() {
    return {
        stackItemsInserted:        0,
        stackItemsPruned:          0,
        decisionsInserted:         0,
        decisionsPruned:           0,
        highlightsInserted:        0,
        highlightsPruned:          0,
        challengesInserted:        0,
        challengesPruned:          0,
        resumeBulletSetsUpserted:  1,
        architectureUpserted:      true,
        depthMarkersUpserted:      true,
        skippedSections:           [],
    };
}

function makePipelineContext(): BasePipelineContext {
    return {
        pipelineId: 'pipeline-1',
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

describe('computeInputHash', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        reconstructPriorCaseStudyMock.mockResolvedValue(null);
        underrepresentedReposMock.mockReturnValue([]);
        scopeEvidenceToReposMock.mockImplementation((context) => context);
    });

    it('is deterministic for identical input', () => {
        expect(computeInputHash(makeContext())).toBe(computeInputHash(makeContext()));
    });

    it('changes when a PR is added', () => {
        const without = computeInputHash(makeContext({ pulls: [] }));
        const withPr  = computeInputHash(makeContext({ pulls: [onePull] }));
        expect(withPr).not.toBe(without);
    });

    it("changes when a PR's state / mergedAt changes", () => {
        const open = computeInputHash(makeContext({ pulls: [onePull] }));
        const merged = computeInputHash(makeContext({
            pulls: [{ ...onePull, state: 'merged', mergedAt: '2026-02-01T00:00:00.000Z' }],
        }));
        expect(merged).not.toBe(open);
    });

    it('changes when a commit sha changes', () => {
        const a = computeInputHash(makeContext({
            commits: [{
                repoFullName: 'acme/api',
                sha:          'abc1234',
                authoredAt:   '2026-01-01T00:00:00.000Z',
                authorName:   'Alice',
                message:      'init',
            }],
        }));
        const b = computeInputHash(makeContext({
            commits: [{
                repoFullName: 'acme/api',
                sha:          'def5678',
                authoredAt:   '2026-01-01T00:00:00.000Z',
                authorName:   'Alice',
                message:      'init',
            }],
        }));
        expect(b).not.toBe(a);
    });

    it('changes when archetype/stage is added; identical when absent', () => {
        const base    = computeInputHash(makeContext());
        const withArch = computeInputHash(makeContext({ archetype: { id: 'production_saas', name: 'Production SaaS Application' }, stage: 'senior' }));
        expect(withArch).not.toBe(base);
        // Two absent-archetype contexts hash identically (cache back-compat).
        expect(computeInputHash(makeContext())).toBe(base);
    });

    it('summarizes grounding verdicts across decisions, highlights, and challenges', () => {
        expect(summarizeGrounding(caseStudyWithVerdicts(
            'GROUNDED',
            'NOT_GROUNDED',
            'NOT_VERIFIED',
        ))).toEqual({ checked: 2, grounded: 1, flagged: 1, notVerified: 1 });
    });

    it('returns grounding summary for generated case studies', async () => {
        const pool = makePool();
        const caseStudy = caseStudyWithVerdicts('GROUNDED', 'NOT_GROUNDED', 'NOT_VERIFIED');
        const agent = { invoke: jest.fn().mockResolvedValue({ data: caseStudy }) };

        loadCaseStudyContextMock.mockResolvedValue(makeContext());
        persistCaseStudyMock.mockResolvedValue(makePersisted());

        const result = await runCaseStudyOrchestration(pool as never, {
            projectId: 'proj-1',
            pipelineRunId: 'run-1',
            model: 'eu.anthropic.claude-sonnet-4-6',
            kbTag: 'kb-1',
            agent: agent as never,
            ctx: makePipelineContext(),
        });

        expect(result.cacheHit).toBe(false);
        expect(result.grounding).toEqual({ checked: 2, grounded: 1, flagged: 1, notVerified: 1 });
        expect(agent.invoke).toHaveBeenCalledTimes(1);
    });

    it('returns grounding summary for cached case studies', async () => {
        const pool = makePool();
        const caseStudy = caseStudyWithVerdicts('NOT_GROUNDED', 'GROUNDED', 'NOT_VERIFIED');
        const agent = { invoke: jest.fn() };
        const cache = {
            get: jest.fn().mockResolvedValue({ hit: true, response: caseStudy }),
            put: jest.fn(),
            invalidate: jest.fn(),
        };

        loadCaseStudyContextMock.mockResolvedValue(makeContext());
        persistCaseStudyMock.mockResolvedValue(makePersisted());

        const result = await runCaseStudyOrchestration(pool as never, {
            projectId: 'proj-1',
            pipelineRunId: 'run-1',
            model: 'eu.anthropic.claude-sonnet-4-6',
            kbTag: 'kb-1',
            agent: agent as never,
            cache: cache as never,
            ctx: makePipelineContext(),
        });

        expect(result.cacheHit).toBe(true);
        expect(result.grounding).toEqual({ checked: 2, grounded: 1, flagged: 1, notVerified: 1 });
        expect(agent.invoke).not.toHaveBeenCalled();
        expect(cache.put).not.toHaveBeenCalled();
    });

    it('traces cache-miss stages in execution order and reports real statuses', async () => {
        const stages: string[] = [];
        const statuses: string[] = [];
        const caseStudy = caseStudyWithVerdicts();
        const agent = { invoke: jest.fn().mockResolvedValue({ data: caseStudy }) };
        const cache = {
            get: jest.fn().mockResolvedValue({ hit: false }),
            put: jest.fn().mockResolvedValue(undefined),
            invalidate: jest.fn(),
        };

        loadCaseStudyContextMock.mockResolvedValue(makeContext());
        persistCaseStudyMock.mockResolvedValue(makePersisted());

        await runCaseStudyOrchestration(makePool() as never, {
            projectId: 'proj-1',
            pipelineRunId: 'run-1',
            model: 'eu.anthropic.claude-sonnet-4-6',
            kbTag: 'kb-1',
            agent: agent as never,
            cache: cache as never,
            ctx: makePipelineContext(),
            workflow: makeWorkflow(stages),
            onStage: async (stage) => {
                statuses.push(stage);
            },
        });

        expect(stages).toEqual([
            'project.case_study.load_context',
            'project.case_study.cache_lookup',
            'project.case_study.generate',
            'project.case_study.ground',
            'project.case_study.persist',
            'project.case_study.cache_write',
        ]);
        expect(statuses).toEqual(['fetching_context', 'generating', 'grounding', 'persisting']);
    });

    it('traces cache-hit load, lookup, and persistence without generation or grounding', async () => {
        const stages: string[] = [];
        const statuses: string[] = [];
        const caseStudy = caseStudyWithVerdicts();
        const agent = { invoke: jest.fn() };
        const cache = {
            get: jest.fn().mockResolvedValue({ hit: true, response: caseStudy }),
            put: jest.fn(),
            invalidate: jest.fn(),
        };

        loadCaseStudyContextMock.mockResolvedValue(makeContext());
        persistCaseStudyMock.mockResolvedValue(makePersisted());

        await runCaseStudyOrchestration(makePool() as never, {
            projectId: 'proj-1',
            pipelineRunId: 'run-1',
            model: 'eu.anthropic.claude-sonnet-4-6',
            kbTag: 'kb-1',
            agent: agent as never,
            cache: cache as never,
            ctx: makePipelineContext(),
            workflow: makeWorkflow(stages),
            onStage: async (stage) => {
                statuses.push(stage);
            },
        });

        expect(stages).toEqual([
            'project.case_study.load_context',
            'project.case_study.cache_lookup',
            'project.case_study.persist',
        ]);
        expect(statuses).toEqual(['fetching_context', 'persisting']);
        expect(agent.invoke).not.toHaveBeenCalled();
    });
});
