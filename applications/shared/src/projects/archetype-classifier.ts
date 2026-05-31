/** @format */
import type { ArchetypeDef, ClassifyInput } from './archetype-types.js';

export type SignalMap = Record<string, boolean>;

const RE = {
    notebook: /\.ipynb$/i,
    iac:      /(^|\/)(infra|terraform|deploy|helm|k8s|kubernetes|cdk|pulumi|argocd)(\/|$)/i,
    docker:   /(^|\/)(dockerfile|docker-compose\.ya?ml)$/i,
    ci:       /(^|\/)\.github\/workflows\//i,
    dataDir:  /(^|\/)(data|datasets)(\/|$)/i,
    mobile:   /(^|\/)(ios|android)(\/|$)|\.xcodeproj|pubspec\.yaml/i,
};
function anyPath(repos: ClassifyInput['repos'], re: RegExp): boolean {
    return repos.some(r => r.filePaths.some(p => re.test(p)));
}
function techHas(repos: ClassifyInput['repos'], needles: string[]): boolean {
    const hay = repos.flatMap(r => [...r.techStack, ...r.topics, r.primaryLanguage ?? '']).map(s => s.toLowerCase());
    return needles.some(n => hay.some(h => h.includes(n)));
}
export function deriveSignals(input: ClassifyInput): SignalMap {
    const { repos, projectShape } = input;
    return {
        has_notebooks:           anyPath(repos, RE.notebook),
        notebook_heavy:          anyPath(repos, RE.notebook) && techHas(repos, ['python','jupyter']),
        has_iac:                 anyPath(repos, RE.iac) || techHas(repos, ['terraform','kubernetes','helm','pulumi']),
        has_k8s_manifests:       anyPath(repos, RE.iac) || techHas(repos, ['kubernetes','helm']),
        has_dockerfile:          anyPath(repos, RE.docker) || techHas(repos, ['docker']),
        has_compose:             anyPath(repos, RE.docker),
        has_ci:                  anyPath(repos, RE.ci) || techHas(repos, ['github-actions','gitlab-ci','circleci']),
        has_deployment_workflow: anyPath(repos, RE.ci),
        has_data_dir:            anyPath(repos, RE.dataDir),
        has_workspaces_field:    projectShape === 'monorepo_subset' || projectShape === 'multi_repo',
        has_bin_field:           techHas(repos, ['cli','commander','clap','cobra']),
        mobile:                  anyPath(repos, RE.mobile) || techHas(repos, ['react-native','flutter','swift','kotlin']),
        has_package_publish:     techHas(repos, ['npm','pypi','crates']),
    };
}
function priorFor(projectType: string): string | null {
    switch (projectType) {
        case 'production_saas': return 'production_saas';
        case 'open_source':     return 'open_source_library';
        case 'internal_tool':   return 'internal_tool';
        default:                return null;
    }
}
function scoreArchetype(def: ArchetypeDef, signals: SignalMap): number {
    const s = def.classificationSignals;
    let score = 0;
    if (s.required_any && s.required_any.some(k => signals[k])) score += 2;
    for (const k of s.positive ?? []) if (signals[k]) score += 1;
    for (const k of s.negative ?? []) if (signals[k]) score -= 2;
    return score;
}
export function classifyArchetype(
    input: ClassifyInput, archetypes: readonly ArchetypeDef[],
): { archetypeId: string; confidence: number } | null {
    if (input.repos.length === 0) return null;
    const signals = deriveSignals(input);
    const prior = priorFor(input.projectType);
    let best: { id: string; score: number } | null = null;
    for (const def of archetypes) {
        let score = scoreArchetype(def, signals);
        if (prior && def.id === prior) score += 1;
        if (best === null || score > best.score) best = { id: def.id, score };
    }
    if (!best || best.score <= 0) return null;
    return { archetypeId: best.id, confidence: Math.min(1, best.score / 4) };
}
