/**
 * @format
 * persistCaseStudy folds the computed archetype/stage into the same
 * `UPDATE projects` that writes tagline/pitch/case_study_status, so the
 * calibration commits atomically with the case study (single transaction).
 */
import { describe, it, expect } from '@jest/globals';

import { persistCaseStudy } from './case-study-persistence.js';
import type { CaseStudy } from './case-study-types.js';

interface CapturedQuery {
    readonly sql:    string;
    readonly params: readonly unknown[];
}

function makeClient(): {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any;
    calls:  CapturedQuery[];
} {
    const calls: CapturedQuery[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = {
        async query(sql: string, params?: readonly unknown[]) {
            calls.push({ sql, params: params ?? [] });
            // user_overrides lookup → no sticky flags.
            if (/SELECT user_overrides/.test(sql)) return { rows: [{ user_overrides: {} }] };
            return { rows: [], rowCount: 0 };
        },
    };
    return { client, calls };
}

const emptyCaseStudy: CaseStudy = {
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

function findProjectsUpdate(calls: CapturedQuery[]): CapturedQuery {
    const hit = calls.find(
        (c) => /UPDATE projects/.test(c.sql) && /case_study_status/.test(c.sql),
    );
    if (!hit) throw new Error('no UPDATE projects (top-fields) query captured');
    return hit;
}

describe('persistCaseStudy — computed archetype/stage', () => {
    it('writes computed_archetype/computed_stage in the projects top-fields UPDATE', async () => {
        const { client, calls } = makeClient();
        await persistCaseStudy(client, {
            projectId:     'proj-1',
            userId:        'user-1',
            pipelineRunId: 'run-1',
            model:         'sonnet',
            inputHash:     'hash-1',
            caseStudy:     emptyCaseStudy,
            computedArchetype: 'production_saas',
            computedStage:     'senior',
        });

        const upd = findProjectsUpdate(calls);
        expect(upd.sql).toMatch(/computed_archetype/);
        expect(upd.sql).toMatch(/computed_stage/);
        expect(upd.sql).toMatch(/archetype_computed_at/);
        expect(upd.params).toContain('production_saas');
        expect(upd.params).toContain('senior');
    });

    it('passes nulls when archetype/stage are absent (no stamp)', async () => {
        const { client, calls } = makeClient();
        await persistCaseStudy(client, {
            projectId:     'proj-1',
            userId:        'user-1',
            pipelineRunId: 'run-1',
            model:         'sonnet',
            inputHash:     'hash-1',
            caseStudy:     emptyCaseStudy,
        });

        const upd = findProjectsUpdate(calls);
        // computed_archetype + computed_stage params resolve to null.
        expect(upd.params[upd.params.length - 2]).toBeNull();
        expect(upd.params[upd.params.length - 1]).toBeNull();
    });
});
