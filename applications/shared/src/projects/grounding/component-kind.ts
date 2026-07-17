/**
 * @format
 * component-kind — deterministic repo-level role classification for project
 * components. The code-grounded fix for clustering's md-based kind guessing:
 * a repo's component kind is derived from archetype signals, evidence topology,
 * fileClass lane counts, and tech stack — not inferred by an LLM from READMEs.
 *
 * Used to (a) enrich the clustering digest the agent sees, and (b) validate /
 * override the agent's emitted kind so a GitOps-infra repo can never be filed
 * as "shared". Pure — no I/O.
 */

import type { ProjectComponentKind } from '../types.js';

/** The grounded per-repo signals the kind is derived from. */
export interface RepoRoleSignals {
    readonly primaryLanguage: string | null;
    readonly techStack: readonly string[];
    readonly topics: readonly string[];
    /** Subset of repo_sync_state.archetype_signals (booleans). */
    readonly archetype: {
        readonly has_iac?: boolean;
        readonly has_k8s_manifests?: boolean;
        readonly has_helm_chart?: boolean;
        readonly has_argocd_apps?: boolean;
        readonly has_dockerfile?: boolean;
        readonly has_ci?: boolean;
        readonly has_android_dir?: boolean;
        readonly has_ios_dir?: boolean;
        readonly has_react_native?: boolean;
        readonly has_flutter_pubspec?: boolean;
        readonly has_models_dir?: boolean;
        readonly has_requirements_with_ml_deps?: boolean;
        readonly has_notebooks?: boolean;
    };
    /** Subset of repo_sync_state.evidence_topology. */
    readonly evidence: {
        readonly is_monorepo?: boolean;
        readonly has_migrations?: boolean;
        readonly migration_tools?: readonly string[];
    };
    /** Per-fileClass chunk counts from document_embeddings. */
    readonly fileClassCounts: {
        readonly source?: number;
        readonly iac?:    number;
        readonly ci?:     number;
        readonly test?:   number;
        readonly db?:     number;
        readonly docs?:   number;
        readonly config?: number;
    };
}

const FRONTEND_FRAMEWORKS = new Set([
    'react', 'next', 'nextjs', 'next.js', 'vue', 'nuxt', 'angular', 'svelte',
    'sveltekit', 'remix', 'astro', 'solid', 'solidjs', 'gatsby', 'tailwind',
]);
// ML *training/modelling* frameworks — NOT app-level LLM SDKs (bedrock/langchain),
// which belong to backend platforms, not ML repos.
const ML_FRAMEWORKS = new Set([
    'pytorch', 'torch', 'tensorflow', 'keras', 'sklearn', 'scikit-learn',
    'jax', 'transformers', 'huggingface', 'spacy', 'xgboost', 'lightgbm',
]);

function lower(xs: readonly string[]): string[] {
    return xs.map((x) => x.toLowerCase());
}
function has(set: ReadonlySet<string>, xs: readonly string[]): boolean {
    return lower(xs).some((x) => set.has(x));
}
function n(v: number | undefined): number {
    return v ?? 0;
}

function isMobile(s: RepoRoleSignals): boolean {
    const a = s.archetype;
    return Boolean(a.has_android_dir || a.has_ios_dir || a.has_react_native || a.has_flutter_pubspec);
}

function isMl(s: RepoRoleSignals): boolean {
    const a = s.archetype;
    return Boolean(a.has_models_dir || a.has_requirements_with_ml_deps || a.has_notebooks) ||
        has(ML_FRAMEWORKS, s.techStack) || has(ML_FRAMEWORKS, s.topics);
}

function isData(s: RepoRoleSignals): boolean {
    const db = n(s.fileClassCounts.db);
    const source = n(s.fileClassCounts.source);
    const iac = n(s.fileClassCounts.iac);
    const migrations = Boolean(s.evidence.has_migrations) || (s.evidence.migration_tools?.length ?? 0) > 0;
    return (db > 0 && db >= source && db >= iac) || (migrations && db > 0 && source <= db);
}

function isInfra(s: RepoRoleSignals): boolean {
    const a = s.archetype;
    // helm/argocd are GitOps-platform markers — app repos virtually never ship them.
    if (a.has_helm_chart || a.has_argocd_apps) return true;
    const infraSignal = Boolean(a.has_iac || a.has_k8s_manifests);
    const counts = s.fileClassCounts;
    const fileClassPresent = n(counts.source) + n(counts.iac) + n(counts.ci) + n(counts.config) > 0;
    // Otherwise require source to NOT dominate the infra/ci lanes — i.e. the repo
    // is configuration, not an application that merely deploys to k8s.
    return infraSignal && fileClassPresent && n(counts.source) <= n(counts.iac) + n(counts.ci);
}

function isDocs(s: RepoRoleSignals): boolean {
    const c = s.fileClassCounts;
    return n(c.docs) > 0 && n(c.source) === 0 && n(c.docs) > n(c.iac);
}

function isFrontend(s: RepoRoleSignals): boolean {
    const hasFw = has(FRONTEND_FRAMEWORKS, s.techStack) || has(FRONTEND_FRAMEWORKS, s.topics);
    return hasFw && n(s.fileClassCounts.source) > 0;
}

function isBackend(s: RepoRoleSignals): boolean {
    return n(s.fileClassCounts.source) > 0;
}

const RULES: ReadonlyArray<readonly [(s: RepoRoleSignals) => boolean, ProjectComponentKind]> = [
    [isMobile,   'mobile'],
    [isMl,       'ml'],
    [isData,     'data'],
    [isInfra,    'infra'],
    [isDocs,     'docs'],
    [isFrontend, 'frontend'],
    [isBackend,  'backend'],
];

/** Derive a repo's component kind from its grounded signals. First rule wins. */
export function classifyComponentKind(signals: RepoRoleSignals): ProjectComponentKind {
    for (const [matches, kind] of RULES) {
        if (matches(signals)) return kind;
    }
    return 'shared';
}

const NAME_BY_KIND: Record<ProjectComponentKind, string> = {
    infra:    'Infrastructure',
    frontend: 'Web Application',
    backend:  'Backend Services',
    mobile:   'Mobile Application',
    data:     'Data & Migrations',
    ml:       'Machine Learning',
    docs:     'Documentation',
    shared:   'Shared Libraries',
};

/** A meaningful component name from kind + the dominant signal (never "Main"). */
export function componentNameFor(kind: ProjectComponentKind, signals: RepoRoleSignals): string {
    if (kind === 'infra') {
        const a = signals.archetype;
        if (a.has_helm_chart || a.has_argocd_apps) return 'GitOps Infrastructure';
        if (a.has_k8s_manifests) return 'Kubernetes Infrastructure';
        return 'Infrastructure';
    }
    return NAME_BY_KIND[kind];
}
