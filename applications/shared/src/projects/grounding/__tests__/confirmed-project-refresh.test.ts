/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { recomputeConfirmedProjectComponents } from '../confirmed-project-refresh.js';
import type { RepoRoleSignals } from '../component-kind.js';
import type { PoolClient } from 'pg';

const sig = (over: Partial<RepoRoleSignals>): RepoRoleSignals => ({
    primaryLanguage: 'TypeScript', techStack: [], topics: [], archetype: {}, evidence: {}, fileClassCounts: {}, ...over,
});

const SIGNALS = new Map<string, RepoRoleSignals>([
    ['ai',    sig({ techStack: ['bedrock'], archetype: { has_iac: true }, fileClassCounts: { source: 141, iac: 13, ci: 36 } })],
    ['kb',    sig({ archetype: { has_helm_chart: true, has_argocd_apps: true, has_k8s_manifests: true }, fileClassCounts: { source: 1, ci: 57 } })],
    ['app',   sig({ techStack: ['react', 'next'], fileClassCounts: { source: 45, test: 314 } })],
    ['infra', sig({ archetype: { has_iac: true, has_k8s_manifests: true }, fileClassCounts: { source: 0, iac: 45 } })],
]);

/** Mock client: confirmed project P with the 4 repos in one wrong "Main" component. */
function makeClient() {
    const inserts: Array<{ name: string; kind: string }> = [];
    let nextId = 0;
    const query = jest.fn(async (sql: string, params?: unknown[]) => {
        if (/SELECT p\.id AS project_id/.test(sql)) {
            return { rows: [
                { project_id: 'P', repository_id: 'ai' }, { project_id: 'P', repository_id: 'kb' },
                { project_id: 'P', repository_id: 'app' }, { project_id: 'P', repository_id: 'infra' },
            ] };
        }
        if (/INSERT INTO project_components/.test(sql)) {
            inserts.push({ name: params![2] as string, kind: params![3] as string });
            return { rows: [{ id: `c${nextId++}` }] };
        }
        return { rows: [] };
    });
    return { client: { query } as unknown as PoolClient, query, inserts };
}

describe('recomputeConfirmedProjectComponents', () => {
    it('regroups a confirmed project into role-correct components', async () => {
        const { client, query, inserts } = makeClient();
        const summary = await recomputeConfirmedProjectComponents(client, 'user-1', SIGNALS);

        expect(summary.projectsRefreshed).toBe(1);
        // The wrong single "Main" lump becomes backend + frontend + infra.
        const kinds = inserts.map((i) => i.kind).sort();
        expect(kinds).toEqual(['backend', 'frontend', 'infra']);
        expect(inserts.find((i) => i.kind === 'infra')!.name).toBe('GitOps Infrastructure');
        expect(inserts.find((i) => i.kind === 'frontend')!.name).toBe('Web Application');
        // Old components were cleared before re-inserting.
        const sqls = query.mock.calls.map((c) => c[0] as string);
        expect(sqls.some((s) => /DELETE FROM project_components/.test(s))).toBe(true);
        expect(sqls.some((s) => /DELETE FROM project_repositories/.test(s))).toBe(true);
    });

    it('no confirmed projects → no-op', async () => {
        const query = jest.fn(async () => ({ rows: [] }));
        const client = { query } as unknown as PoolClient;
        const summary = await recomputeConfirmedProjectComponents(client, 'user-1', SIGNALS);
        expect(summary).toEqual({ projectsRefreshed: 0, componentsWritten: 0 });
    });
});
