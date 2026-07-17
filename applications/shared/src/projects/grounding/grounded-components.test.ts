/** @format */
import { describe, it, expect } from '@jest/globals';
import { regroupComponentsByKind, applyGroundedComponentKinds } from './grounded-components.js';
import type { RepoRoleSignals } from './component-kind.js';
import type { ClusteringResult } from '../types.js';

const sig = (over: Partial<RepoRoleSignals>): RepoRoleSignals => ({
    primaryLanguage: 'TypeScript', techStack: [], topics: [], archetype: {}, evidence: {}, fileClassCounts: {}, ...over,
});

// The real project's four repos, grounded.
const SIGNALS = new Map<string, RepoRoleSignals>([
    ['ai',    sig({ techStack: ['bedrock', 'postgres'], archetype: { has_iac: true, has_k8s_manifests: true }, fileClassCounts: { source: 141, iac: 13, ci: 36 } })],
    ['kb',    sig({ archetype: { has_iac: true, has_k8s_manifests: true, has_helm_chart: true, has_argocd_apps: true }, fileClassCounts: { source: 1, iac: 4, ci: 57 } })],
    ['app',   sig({ techStack: ['react', 'next'], archetype: { has_ci: true }, fileClassCounts: { source: 45, ci: 14, test: 314 } })],
    ['infra', sig({ archetype: { has_iac: true, has_k8s_manifests: true }, fileClassCounts: { source: 0, iac: 45, ci: 63 } })],
]);

describe('regroupComponentsByKind', () => {
    it('splits the wrong "Main" lump into role-correct components', () => {
        const comps = regroupComponentsByKind(['ai', 'kb', 'app', 'infra'], SIGNALS);
        const byKind = new Map(comps.map((c) => [c.kind, c]));

        expect(byKind.get('backend')!.repositoryIds).toEqual(['ai']);
        expect(byKind.get('frontend')!.repositoryIds).toEqual(['app']);
        // both infra repos collapse into one infra component...
        expect(byKind.get('infra')!.repositoryIds.sort()).toEqual(['infra', 'kb']);
        // ...named GitOps because kubernetes-bootstrap ships helm + argocd.
        expect(byKind.get('infra')!.name).toBe('GitOps Infrastructure');
        expect(byKind.get('frontend')!.name).toBe('Web Application');
    });

    it('names are never the generic "Main"', () => {
        const comps = regroupComponentsByKind(['ai', 'kb', 'app', 'infra'], SIGNALS);
        for (const c of comps) expect(c.name).not.toBe('Main');
    });

    it('repos with unknown signals fall to shared', () => {
        const comps = regroupComponentsByKind(['ghost'], new Map());
        expect(comps).toEqual([{ kind: 'shared', name: 'Shared Libraries', repositoryIds: ['ghost'] }]);
    });
});

describe('applyGroundedComponentKinds', () => {
    it('rebuilds a proposal\'s components from grounded kinds, keeping its identity', () => {
        const result: ClusteringResult = {
            proposals: [{
                name: 'AI Applications Platform with Infrastructure-as-Code',
                confidence: 'high',
                reasoning: 'shared product',
                components: [
                    { name: 'Main', kind: 'shared', repositoryIds: ['kb', 'app'] }, // the wrong lump
                    { name: 'AI Applications Backend', kind: 'backend', repositoryIds: ['ai'] },
                    { name: 'Infrastructure & Monitoring', kind: 'infra', repositoryIds: ['infra'] },
                ],
            }],
        };
        const fixed = applyGroundedComponentKinds(result, SIGNALS);
        const p = fixed.proposals[0]!;
        expect(p.name).toBe('AI Applications Platform with Infrastructure-as-Code'); // identity kept
        const kinds = p.components.map((c) => c.kind).sort();
        expect(kinds).toEqual(['backend', 'frontend', 'infra']); // shared/Main gone; frontend recovered
        const infra = p.components.find((c) => c.kind === 'infra')!;
        expect(infra.repositoryIds.sort()).toEqual(['infra', 'kb']); // kb moved out of "Main" into infra
    });
});
