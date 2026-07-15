/**
 * @format
 * Repository Profile — Increment 1 (docs/repository-profile-strategy.md).
 *
 * Assembles a repo-level IDENTITY from two already-stored, deterministic sources:
 *   - archetype signals (repo_sync_state.archetype_signals — folder-structure scan)
 *   - the code-derived tech set (technology_evidence deterministic layers, via
 *     TechnologyOntologyRepository.loadRepoCodeTech)
 *
 * Output per repo: a `repo_type`, the `frameworks` + `services` it actually uses,
 * and higher-level `concepts` — e.g. cdk-monitoring → {type: cdk-infra,
 * frameworks: [aws cdk], services: [aws eks, …], concepts: [provisions-managed-kubernetes]}.
 * The matcher/strategist can then reason about "this repo IS the EKS infra" instead
 * of isolated tech names.
 *
 * Fully deterministic + auditable: frameworks/services are drawn ONLY from the
 * code tech set (never prose), so a profile cannot claim what the code lacks. The
 * one-line natural-language summary is added later (Increment 2) from these facts.
 */

import type { Pool } from 'pg';

import { withUserRls } from '../../lib/db/rls.js';

/** IaC / delivery frameworks (ontology canonicals) that define HOW infra is built. */
const FRAMEWORK_CANONICALS = new Set([
    'aws_cdk', 'terraform', 'pulumi', 'helm', 'cloudformation', 'argocd', 'ansible', 'serverless_framework',
]);

/** Non-AWS canonicals that still count as a provisioned/operated service. */
const EXTRA_SERVICE_CANONICALS = new Set([
    'kubernetes', 'aurora_postgres', 'postgresql', 'redis', 'prometheus', 'grafana', 'loki', 'tempo',
]);

// Run-time evidence topology, derived from ingested file paths (test files,
// migrations, nested manifests). Evidence (real files), not README claims.
const TEST_FILE_RE = /(?:\.(?:test|spec)\.[jt]sx?$)|(?:\/__tests__\/)|(?:\/tests?\/)/i;
const MIGRATION_RE = /(?:^|\/)migrations?\//i;
const NESTED_PKG_RE = /\/package\.json$/i;
/** A repo is "well-tested" when test files are a meaningful share of its ingested files. */
const WELL_TESTED_RATIO = 0.1;

export interface RepoTopology {
    readonly hasTests: boolean;
    /** distinct test files / distinct ingested files. */
    readonly testRatio: number;
    readonly hasMigrations: boolean;
    readonly isMonorepo: boolean;
}

/** Derive evidence topology from a repo's ingested file paths. Pure. */
export function deriveTopology(paths: ReadonlySet<string>): RepoTopology {
    let testFiles = 0;
    let migrationFiles = 0;
    let nestedPkg = 0;
    for (const p of paths) {
        if (TEST_FILE_RE.test(p)) testFiles += 1;
        if (MIGRATION_RE.test(p)) migrationFiles += 1;
        if (NESTED_PKG_RE.test(p)) nestedPkg += 1;
    }
    const total = paths.size;
    return {
        hasTests: testFiles > 0,
        testRatio: total > 0 ? Math.round((testFiles / total) * 1000) / 1000 : 0,
        hasMigrations: migrationFiles > 0,
        isMonorepo: nestedPkg >= 2,
    };
}

export interface RepoProfile {
    readonly repoFullName: string;
    /** cdk-infra | k8s-platform | iac-infra | ml | mobile | docs-site | library | monorepo | application | unknown */
    readonly repoType: string;
    /** IaC/delivery frameworks the code uses (lowercased canonicals). */
    readonly frameworks: string[];
    /** Cloud services / infra the repo provisions or operates (lowercased canonicals). */
    readonly services: string[];
    /** Higher-level patterns inferred by rule (gitops, observability, …). */
    readonly concepts: string[];
}

export type Signals = Readonly<Record<string, boolean>>;

function isFramework(tech: string): boolean {
    return FRAMEWORK_CANONICALS.has(tech);
}

/** A provisioned/operated service: an AWS resource (not a framework) or a known extra. */
function isService(tech: string): boolean {
    if (isFramework(tech)) return false;
    return tech.startsWith('aws_') || EXTRA_SERVICE_CANONICALS.has(tech);
}

/** Deterministic repo-type cascade (most specific first). */
function classifyRepoType(sig: Signals, tech: ReadonlySet<string>, frameworks: ReadonlyArray<string>): string {
    const has = (k: string): boolean => sig[k] === true;
    const k8sShaped = has('has_k8s_manifests') || has('has_argocd_apps') || has('has_helm_chart');

    if (has('has_iac') && frameworks.includes('aws_cdk')) return 'cdk-infra';
    if (has('has_iac') && (frameworks.includes('terraform') || frameworks.includes('pulumi'))) return 'iac-infra';
    if (k8sShaped) return 'k8s-platform';
    if (has('notebook_heavy') || has('has_requirements_with_ml_deps') || has('has_models_dir')) return 'ml';
    if (has('has_react_native') || has('has_flutter_pubspec') || has('has_expo_config') || has('has_android_dir') || has('has_ios_dir')) return 'mobile';
    if (has('has_static_site_config') || has('has_docs_site_config')) return 'docs-site';
    if (has('has_package_publish_config') || has('has_pyproject_publish')) return 'library';
    if (has('has_multi_package_src') && has('has_workspaces_field')) return 'monorepo';
    if (has('has_dockerfile') || has('has_ci') || tech.size > 0) return 'application';
    return 'unknown';
}

/** Rule-based higher-level concepts from signals, assembled facts, and evidence topology. */
function deriveConcepts(
    sig: Signals,
    services: ReadonlyArray<string>,
    frameworks: ReadonlyArray<string>,
    topology: RepoTopology,
): string[] {
    const has = (k: string): boolean => sig[k] === true;
    const out = new Set<string>();
    if (has('has_argocd_apps')) out.add('gitops');
    if (has('has_monitoring_config') || services.some((s) => ['prometheus', 'grafana', 'loki', 'tempo'].includes(s))) out.add('observability');
    if (services.includes('aws_eks')) out.add('provisions-managed-kubernetes');
    else if (has('has_k8s_manifests')) out.add('kubernetes-workloads');
    if (has('has_iac')) out.add('infrastructure-as-code');
    if (has('has_dockerfile') || has('has_compose')) out.add('containerized');
    if (has('has_deployment_workflow')) out.add('ci-cd-delivery');
    if (frameworks.includes('aws_cdk') || frameworks.includes('cloudformation')) out.add('aws-native-iac');
    // Evidence topology (real files, not README claims).
    if (topology.hasTests) out.add(topology.testRatio >= WELL_TESTED_RATIO ? 'well-tested' : 'tested');
    if (topology.hasMigrations) out.add('database-migrations');
    if (topology.isMonorepo) out.add('monorepo');
    return [...out];
}

/**
 * Build one RepoProfile per repo present in either input. Pure + deterministic.
 * Repos with neither tech nor signals are skipped.
 */
/** Concepts from the ingestion-derived evidence topology (scripts, DB migrations, monorepo). */
function evidenceTopologyConcepts(et: Record<string, unknown> | undefined): string[] {
    if (!et) return [];
    const out: string[] = [];
    const on = (k: string): boolean => et[k] === true;
    if (on('has_test_script')) out.push('tested');
    if (on('has_build_script')) out.push('build-tooling');
    if (on('has_lint_script')) out.push('lint-tooling');
    if (on('has_typecheck_script')) out.push('typechecked');
    if (on('has_migrations')) {
        out.push('database-migrations');
        const tools = et['migration_tools'];
        if (Array.isArray(tools)) for (const t of tools) if (typeof t === 'string') out.push(`migrations:${t}`);
    }
    if (on('is_monorepo')) out.push('monorepo');
    return out;
}

export function buildRepoProfiles(
    codeTechByRepo: ReadonlyMap<string, ReadonlySet<string>>,
    signalsByRepo: ReadonlyMap<string, Signals>,
    filePathsByRepo: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
    evidenceTopologyByRepo: ReadonlyMap<string, Record<string, unknown>> = new Map(),
): RepoProfile[] {
    const repos = new Set<string>([...codeTechByRepo.keys(), ...signalsByRepo.keys()]);
    const profiles: RepoProfile[] = [];
    for (const repo of repos) {
        const tech = codeTechByRepo.get(repo) ?? new Set<string>();
        const sig = signalsByRepo.get(repo) ?? {};
        if (tech.size === 0 && Object.keys(sig).length === 0) continue;
        const topology = deriveTopology(filePathsByRepo.get(repo) ?? new Set<string>());
        const frameworks = [...tech].filter(isFramework).sort((a, b) => a.localeCompare(b));
        const services = [...tech].filter(isService).sort((a, b) => a.localeCompare(b));
        const repoType = classifyRepoType(sig, tech, frameworks);
        const concepts = [...new Set([
            ...deriveConcepts(sig, services, frameworks, topology),
            ...evidenceTopologyConcepts(evidenceTopologyByRepo.get(repo)),
        ])];
        profiles.push({ repoFullName: repo, repoType, frameworks, services, concepts });
    }
    return profiles.sort((a, b) => a.repoFullName.localeCompare(b.repoFullName));
}

/** Render the profiles into a grounding block for the research/strategist prompt. */
export function buildRepoProfileContext(profiles: ReadonlyArray<RepoProfile>): string {
    if (profiles.length === 0) return '';
    const lines: string[] = [
        '## Repository Profiles — what each repo IS (deterministic, from code + structure)',
        'Each repo\'s identity, derived from its file structure + code-extracted technologies. Use this',
        'to attribute work to the RIGHT repo and present its CURRENT identity — e.g. a "cdk-infra" repo',
        'that provisions "aws eks" is the EKS infrastructure, regardless of older narratives.',
        '',
    ];
    for (const p of profiles) {
        const display = (xs: ReadonlyArray<string>): string => xs.map((x) => x.replaceAll('_', ' ')).join(', ') || 'none';
        lines.push(`- ${p.repoFullName} [${p.repoType}] — frameworks: ${display(p.frameworks)}; services: ${display(p.services)}; concepts: ${display(p.concepts)}`);
    }
    return lines.join('\n');
}

const PROFILE_COLS = 7;

/**
 * Upsert per-run repo profiles (natural key: pipeline_run_id + repo). Fail-open at
 * the call site — observability/grounding side-channel, never a gate on the run.
 */
export async function persistRepoProfiles(
    pool: Pool,
    meta: { pipelineRunId: string; userId: string },
    profiles: ReadonlyArray<RepoProfile>,
): Promise<number> {
    if (profiles.length === 0) return 0;
    const tuples: string[] = [];
    const values: unknown[] = [];
    for (let i = 0; i < profiles.length; i++) {
        const p = profiles[i];
        const b = i * PROFILE_COLS;
        tuples.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`);
        values.push(meta.pipelineRunId, meta.userId, p.repoFullName, p.repoType, p.frameworks, p.services, p.concepts);
    }
    await withUserRls(pool, meta.userId, (client) => client.query(
        `INSERT INTO repo_profile
            (pipeline_run_id, user_id, repo_full_name, repo_type, frameworks, services, concepts)
         VALUES ${tuples.join(',')}
         ON CONFLICT (pipeline_run_id, repo_full_name) DO UPDATE SET
             repo_type  = EXCLUDED.repo_type,
             frameworks = EXCLUDED.frameworks,
             services   = EXCLUDED.services,
             concepts   = EXCLUDED.concepts`,
        values,
    ));
    return profiles.length;
}
