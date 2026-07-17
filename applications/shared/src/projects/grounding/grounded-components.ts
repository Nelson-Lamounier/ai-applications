/**
 * @format
 * grounded-components — rebuild a project's components from code-grounded kinds.
 *
 * The shared core of two fixes:
 *   - clustering (increment 3): after the agent proposes groupings, regroup each
 *     proposal's repos by their deterministic {@link classifyComponentKind} so a
 *     GitOps-infra repo and a web app can't share one "shared/Main" component.
 *   - confirmed-project refresh (increment 4): regroup an existing confirmed
 *     project's repos the same way, fixing wrong kinds/names without changing
 *     which repos belong to the project.
 *
 * Pure — operates on a repoId → signals map. The grouping (which repos are in
 * the project/proposal) is preserved; only the component structure is corrected.
 */

import type { ClusteringComponent, ClusteringProposal, ClusteringResult, ProjectComponentKind } from '../types.js';
import type { RepoRoleSignals } from './component-kind.js';
import { classifyComponentKind, componentNameFor } from './component-kind.js';

/** Stable display order for components within a project. */
const KIND_ORDER: ProjectComponentKind[] = ['backend', 'frontend', 'mobile', 'ml', 'data', 'infra', 'docs', 'shared'];

/** Name an infra group GitOps/K8s when ANY repo in it carries those markers. */
function infraName(group: RepoRoleSignals[]): string {
    if (group.some((s) => s.archetype.has_helm_chart || s.archetype.has_argocd_apps)) return 'GitOps Infrastructure';
    if (group.some((s) => s.archetype.has_k8s_manifests)) return 'Kubernetes Infrastructure';
    return 'Infrastructure';
}

/**
 * Regroup repoIds into one component per derived kind. Repos whose signals are
 * unknown (absent from the map) fall to 'shared'. One component per distinct
 * kind, ordered deterministically, each given a meaningful name.
 */
export function regroupComponentsByKind(
    repoIds: readonly string[],
    signalsById: ReadonlyMap<string, RepoRoleSignals>,
): ClusteringComponent[] {
    const byKind = new Map<ProjectComponentKind, { ids: string[]; signals: RepoRoleSignals[] }>();
    for (const id of repoIds) {
        const s = signalsById.get(id);
        const kind = s ? classifyComponentKind(s) : 'shared';
        const bucket = byKind.get(kind) ?? { ids: [], signals: [] };
        bucket.ids.push(id);
        if (s) bucket.signals.push(s);
        byKind.set(kind, bucket);
    }

    const order = (k: ProjectComponentKind): number => {
        const i = KIND_ORDER.indexOf(k);
        return i === -1 ? KIND_ORDER.length : i;
    };

    return [...byKind.entries()]
        .sort((a, b) => order(a[0]) - order(b[0]))
        .map(([kind, { ids, signals }]) => ({
            kind,
            name: kind === 'infra' ? infraName(signals) : componentNameFor(kind, signals[0] ?? EMPTY_SIGNALS),
            repositoryIds: ids,
        }));
}

const EMPTY_SIGNALS: RepoRoleSignals = {
    primaryLanguage: null, techStack: [], topics: [], archetype: {}, evidence: {}, fileClassCounts: {},
};

/**
 * Apply grounded kinds to a whole clustering result: every proposal's repos are
 * regrouped by derived kind. The proposal's name/confidence/reasoning are kept;
 * only its components are rebuilt.
 */
export function applyGroundedComponentKinds(
    result: ClusteringResult,
    signalsById: ReadonlyMap<string, RepoRoleSignals>,
): ClusteringResult {
    const proposals: ClusteringProposal[] = result.proposals.map((p) => {
        const repoIds = [...new Set(p.components.flatMap((c) => c.repositoryIds))];
        return { ...p, components: regroupComponentsByKind(repoIds, signalsById) };
    });
    return { proposals };
}
