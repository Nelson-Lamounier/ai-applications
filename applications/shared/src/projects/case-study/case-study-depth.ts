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

import type { DepthMarkers, DifficultySignals, EvidenceMix } from './case-study-types.js';

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

/**
 * App-vs-infra evidence split from fileClass lane counts: application =
 * source + test, infrastructure = iac + ci. Docs and config are excluded —
 * docs is its own narrative lane and config is classification noise.
 * Percentages are rounded to the nearest 5 so the value — which feeds the
 * system prompt AND the case-study cache key — stays stable across small
 * syncs. Returns null when either side is empty: a single-lane project
 * (e.g. a pure Terraform repo, or an app with no IaC) has nothing to
 * balance, and the prompt must not pressure the model to invent one.
 */
export function deriveEvidenceMix(laneCounts: DepthSignals['laneCounts']): EvidenceMix | null {
    const app   = n(laneCounts.source) + n(laneCounts.test);
    const infra = n(laneCounts.iac) + n(laneCounts.ci);
    if (app === 0 || infra === 0) return null;
    const appPct = Math.round((app / (app + infra)) * 20) * 5;
    return { appPct, infraPct: 100 - appPct, appFiles: app, infraFiles: infra };
}

/** Raw per-area row from the full-history fix-density SQL. node-postgres
 *  returns timestamptz columns as Date objects; counts arrive as text. */
export interface DifficultyAreaRow {
    readonly area:          string;
    readonly fix_commits:   string | number;
    readonly total_commits: string | number;
    readonly first_at:      string | Date;
    readonly last_at:       string | Date;
}

/** Raw whole-repo span row (min/max authored_at over ALL stored commits). */
export interface CommitSpanRow {
    readonly first_commit_at: string | Date;
    readonly last_commit_at:  string | Date;
    readonly total:           string | number;
}

/** Nearest-5 bucket with a floor of 1, so small-but-real counts stay visible. */
function bucket5(v: number): number {
    return Math.max(1, Math.round(v / 5) * 5);
}

/** Timestamp -> YYYY-MM. node-postgres hands timestamptz back as Date. */
function month(v: string | Date): string {
    return (v instanceof Date ? v.toISOString() : String(v)).slice(0, 7);
}

/**
 * Shape the full-history fix-density rows into the <difficultySignals> block:
 * where sustained fix activity happened, over what span, across the ENTIRE
 * stored commit history — the measured "what was actually hard and for how
 * long" that the recency-capped packing window cannot express. Counts bucket
 * to the nearest 5 and dates to months so the value (prompt + cache key)
 * stays stable across small syncs. Null when there is nothing fix-dense —
 * the prompt then simply omits the block.
 */
export function deriveDifficultySignals(
    areas: readonly DifficultyAreaRow[],
    span: CommitSpanRow | null,
): DifficultySignals | null {
    if (areas.length === 0 || !span) return null;
    return {
        firstCommitMonth: month(span.first_commit_at),
        lastCommitMonth:  month(span.last_commit_at),
        totalCommits:     bucket5(Number(span.total)),
        areas: areas.map((r) => ({
            area:         r.area,
            fixCommits:   bucket5(Number(r.fix_commits)),
            totalCommits: bucket5(Number(r.total_commits)),
            firstMonth:   month(r.first_at),
            lastMonth:    month(r.last_at),
        })),
    };
}
