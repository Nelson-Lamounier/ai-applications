/**
 * @format
 * persistCaseStudy folds the computed archetype/stage into the same
 * `UPDATE projects` that writes tagline/pitch/case_study_status, so the
 * calibration commits atomically with the case study (single transaction).
 */
import { describe, it, expect } from '@jest/globals';

import { persistCaseStudy, upsertArchitecture } from './case-study-persistence.js';
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
    const client = {
        async query(sql: string, params?: readonly unknown[]) {
            calls.push({ sql, params: params ?? [] });
            // user_overrides lookup → no sticky flags.
            if (/SELECT user_overrides/.test(sql)) return { rows: [{ user_overrides: {} }] };
            if (/DELETE FROM project_/.test(sql)) return { rows: [], rowCount: 2 };
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
        // Params must be explicitly cast — a bare $9 used only in a NULL-test
        // makes Postgres throw "could not determine data type of parameter $9".
        expect(upd.sql).toMatch(/computed_archetype\s*=\s*\$9::text/);
        expect(upd.sql).toMatch(/CASE WHEN \$9::text IS NOT NULL/);
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

const emptySignals = { commits: [], pulls: [], files: [], ungroundedClaims: [], grounding: 'NOT_VERIFIED' as const };

function deletesFor(calls: CapturedQuery[], table: string): CapturedQuery[] {
    return calls.filter((c) => new RegExp(`DELETE FROM ${table}\\b`).test(c.sql));
}

describe('persistCaseStudy — replace/prune semantics (no accumulation)', () => {
    it('prunes superseded rows so a section reflects only the current run', async () => {
        const { client, calls } = makeClient();
        const persisted = await persistCaseStudy(client, {
            projectId: 'proj-1', userId: 'user-1', pipelineRunId: 'run-2', model: 'sonnet', inputHash: 'h',
            caseStudy: {
                ...emptyCaseStudy,
                decisions:  [{ title: 'D', context: 'c', decision: 'x', consequences: 'y', confidence: 'high', sourceSignals: emptySignals }],
                highlights: [{ title: 'H', description: 'd', sourceSignals: emptySignals }],
            },
        });

        // Each populated list section emits a content_hash-set prune.
        const decDel = deletesFor(calls, 'project_decisions');
        expect(decDel).toHaveLength(1);
        expect(decDel[0].sql).toMatch(/content_hash <> ALL\(\$2::text\[\]\)/);
        // Decisions preserve user-confirmed rows; the others do not have that column.
        expect(decDel[0].sql).toMatch(/is_user_confirmed = FALSE/);

        const hiDel = deletesFor(calls, 'project_highlights');
        expect(hiDel).toHaveLength(1);
        expect(hiDel[0].sql).toMatch(/content_hash <> ALL\(\$2::text\[\]\)/);
        expect(hiDel[0].sql).not.toMatch(/is_user_confirmed/);

        expect(persisted.stackItemsPruned).toBe(2);
        expect(persisted.decisionsPruned).toBe(2);
        expect(persisted.highlightsPruned).toBe(2);
        expect(persisted.challengesPruned).toBe(2);
    });

    it('clears stale machine rows when a section comes back empty (keeps NULL-hash user rows)', async () => {
        const { client, calls } = makeClient();
        await persistCaseStudy(client, {
            projectId: 'proj-1', userId: 'user-1', pipelineRunId: 'run-3', model: 'sonnet', inputHash: 'h',
            caseStudy: emptyCaseStudy, // all list sections empty
        });

        const hiDel = deletesFor(calls, 'project_highlights');
        expect(hiDel).toHaveLength(1);
        expect(hiDel[0].sql).toMatch(/content_hash IS NOT NULL/);
        expect(hiDel[0].sql).not.toMatch(/<> ALL/);
    });

    it('does not prune sticky sections (user owns them)', async () => {
        const calls: CapturedQuery[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const client: any = {
            async query(sql: string, params?: readonly unknown[]) {
                calls.push({ sql, params: params ?? [] });
                if (/SELECT user_overrides/.test(sql)) return { rows: [{ user_overrides: { highlights: true } }] };
                return { rows: [], rowCount: 0 };
            },
        };
        const persisted = await persistCaseStudy(client, {
            projectId: 'proj-1', userId: 'user-1', pipelineRunId: 'run-4', model: 'sonnet', inputHash: 'h',
            caseStudy: {
                ...emptyCaseStudy,
                highlights: [{ title: 'H', description: 'd', sourceSignals: emptySignals }],
            },
        });
        // highlights is sticky → neither inserted nor pruned.
        expect(deletesFor(calls, 'project_highlights')).toHaveLength(0);
        expect(persisted.highlightsInserted).toBe(0);
        expect(persisted.highlightsPruned).toBe(0);
    });
});

describe('upsertArchitecture — Mermaid normalisation', () => {
    it('normalises a literal-\\n Mermaid diagram before persisting', async () => {
        const calls: { sql: string; params: readonly unknown[] }[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const client: any = {
            async query(sql: string, params: readonly unknown[] = []) {
                calls.push({ sql, params });
                return { rows: [], rowCount: 1 };
            },
        };
        const input: Parameters<typeof upsertArchitecture>[1] = {
            projectId:     'proj-x',
            userId:        'user-x',
            pipelineRunId: 'run-x',
            model:         'sonnet',
            inputHash:     'h',
            caseStudy: {
                ...emptyCaseStudy,
                architecture: {
                    diagramFormat: 'mermaid',
                    diagramSource: 'graph LR\n  App[admin-api BFF\\nHono]',
                    nodes: [],
                    edges: [],
                },
            },
        };
        await upsertArchitecture(client, input);
        const insert = calls.find((c) => /INSERT INTO project_architecture/i.test(c.sql))!;
        const sourceParam = insert.params[3] as string; // diagram_source is $4
        expect(sourceParam).not.toMatch(/\\n/);
        expect(sourceParam).toContain('["admin-api BFF<br/>Hono"]');
    });

    it('does not modify an SVG diagram source', async () => {
        const calls: { sql: string; params: readonly unknown[] }[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const client: any = {
            async query(sql: string, params: readonly unknown[] = []) {
                calls.push({ sql, params });
                return { rows: [], rowCount: 1 };
            },
        };
        const svgSource = '<svg><text>App\\nServer</text></svg>';
        const input: Parameters<typeof upsertArchitecture>[1] = {
            projectId:     'proj-y',
            userId:        'user-y',
            pipelineRunId: 'run-y',
            model:         'sonnet',
            inputHash:     'h2',
            caseStudy: {
                ...emptyCaseStudy,
                architecture: {
                    diagramFormat: 'svg',
                    diagramSource: svgSource,
                    nodes: [],
                    edges: [],
                },
            },
        };
        await upsertArchitecture(client, input);
        const insert = calls.find((c) => /INSERT INTO project_architecture/i.test(c.sql))!;
        const sourceParam = insert.params[3] as string; // diagram_source is $4
        expect(sourceParam).toBe(svgSource); // untouched
    });
});
