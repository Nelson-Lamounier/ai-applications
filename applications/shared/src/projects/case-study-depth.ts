/**
 * @format
 * case-study-depth — derive grounded DepthMarkers from code signals.
 *
 * DepthMarkers (hasTests, testCoverageSignal, hasCi, ciMaturity,
 * documentationDensity, hasDeploymentEvidence, refactorCount) were inferred by
 * the LLM from commit/KB hints. This computes them deterministically from the
 * new RAG signals — fileClass lane counts + archetype_signals + refactor commit
 * count — so the depth claims are measured facts, not guesses. The orchestrator
 * overrides the model's depthMarkers with these.
 *
 * Pure — no I/O, no LLM.
 */

import type { DepthMarkers } from './case-study-types.js';

export interface DepthSignals {
    /** Summed fileClass lane counts across the project's repos. */
    readonly laneCounts: {
        readonly source?: number;
        readonly test?:   number;
        readonly ci?:     number;
        readonly iac?:    number;
        readonly docs?:   number;
        readonly config?: number;
    };
    /** OR-merged archetype_signals across the project's repos. */
    readonly archetype: {
        readonly has_ci?:                 boolean;
        readonly has_deployment_workflow?: boolean;
        readonly has_argocd_apps?:        boolean;
        readonly has_k8s_manifests?:      boolean;
        readonly has_iac?:                boolean;
        readonly has_dockerfile?:         boolean;
        readonly has_docs_site_config?:   boolean;
        readonly has_live_url_in_readme?: boolean;
    };
    /** Commits whose message indicates a refactor (counted by the loader). */
    readonly refactorCount?: number;
    /** Deployment URL if known (e.g. from a README live link). */
    readonly deploymentUrl?: string | null;
}

function n(v: number | undefined): number {
    return v ?? 0;
}

function testCoverage(source: number, test: number): DepthMarkers['testCoverageSignal'] {
    if (test === 0) return 'none';
    const ratio = test / Math.max(source, 1);
    if (ratio >= 0.5) return 'strong';
    if (ratio >= 0.2) return 'moderate';
    return 'light';
}

function ciMaturity(s: DepthSignals['archetype'], hasCi: boolean): DepthMarkers['ciMaturity'] {
    if (!hasCi) return 'none';
    if (s.has_argocd_apps || (s.has_k8s_manifests && s.has_deployment_workflow)) return 'multi_env';
    if (s.has_deployment_workflow || s.has_dockerfile) return 'deploys_to_prod';
    return 'basic';
}

function docDensity(docs: number, s: DepthSignals['archetype']): DepthMarkers['documentationDensity'] {
    if (s.has_docs_site_config) return 'comprehensive';
    if (docs >= 10) return 'docs_dir';
    if (docs > 0) return 'readme_only';
    return 'none';
}

/** Compute deterministic DepthMarkers from grounded signals. */
export function deriveDepthMarkers(s: DepthSignals): DepthMarkers {
    const test   = n(s.laneCounts.test);
    const source = n(s.laneCounts.source);
    const docs   = n(s.laneCounts.docs);
    const a      = s.archetype;

    const hasCi = Boolean(a.has_ci) || n(s.laneCounts.ci) > 0;
    const hasDeploymentEvidence =
        Boolean(a.has_iac || a.has_argocd_apps || a.has_dockerfile) || n(s.laneCounts.iac) > 0;

    return {
        hasTests:              test > 0,
        testCoverageSignal:    testCoverage(source, test),
        hasCi,
        ciMaturity:            ciMaturity(a, hasCi),
        documentationDensity:  docDensity(docs, a),
        hasDeploymentEvidence,
        deploymentUrl:         s.deploymentUrl ?? null,
        refactorCount:         Math.max(0, Math.trunc(s.refactorCount ?? 0)),
    };
}
