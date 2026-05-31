/**
 * @format
 * Pure, deterministic repo-signal derivation.
 *
 * Detects archetype-classification signals from a repository's full file-path
 * list (plus, optionally, parsed package.json content). This is the canonical
 * signal vocabulary the seeded ontology (migration 046) gates on: every
 * returned object MUST contain ALL {@link REPO_SIGNAL_KEYS} (false when not
 * detected), because the classifier scores against these exact names.
 *
 * The signal MEANINGS mirror the tucaken-signal RepoReader
 * (packages/signal-cli/src/repo/RepoReader.ts). RepoReader works from a live
 * filesystem (existsSync + file contents); this module works from PATHS only
 * (+ optional package.json), since at our call site we have the full file tree
 * (paths + sizes) but not all file contents. Where RepoReader reads file
 * contents we fall back to the closest faithful path-level proxy.
 *
 * No I/O, no clock, no randomness — fully deterministic and side-effect free.
 */

export interface RepoFileEntry {
    readonly path: string;
}

export interface DeriveRepoSignalsOptions {
    /** Parsed package.json contents, when available, for bin/workspaces/publishConfig detection. Optional. */
    readonly packageJson?: Record<string, unknown> | null;
    /** Project shape hint from the projects table (multi_repo/monorepo_subset → workspaces signal). Optional. */
    readonly projectShape?: string;
}

/**
 * The canonical 46-key signal vocabulary. Exported so callers (and tests) can
 * assert the contract without duplicating the list.
 */
export const REPO_SIGNAL_KEYS = [
    'has_android_dir', 'has_api_docs', 'has_app_store_link', 'has_argocd_apps', 'has_bin_field',
    'has_changelog', 'has_ci', 'has_compose', 'has_console_scripts', 'has_content_dir',
    'has_data_dir', 'has_deployment_workflow', 'has_dockerfile', 'has_docs_site_config',
    'has_env_example', 'has_examples_dir', 'has_experiments_dir', 'has_expo_config',
    'has_flutter_pubspec', 'has_helm_chart', 'has_iac', 'has_ios_dir', 'has_k8s_manifests',
    'has_license', 'has_live_url_in_readme', 'has_makefile', 'has_man_page', 'has_models_dir',
    'has_monitoring_config', 'has_multi_package_src', 'has_notebooks', 'has_nx_json',
    'has_package_publish_config', 'has_pnpm_workspace', 'has_pyproject_publish',
    'has_react_native', 'has_requirements_with_ml_deps', 'has_root_android_app',
    'has_root_ios_app', 'has_screenshots_dir', 'has_single_script_entry',
    'has_static_site_config', 'has_turbo_json', 'has_workspaces_field', 'has_xamarin_mobile',
    'notebook_heavy',
] as const;

export type RepoSignalKey = (typeof REPO_SIGNAL_KEYS)[number];

const RE = {
    dockerfile: /(^|\/)dockerfile[^/]*$/i,
    compose: /(^|\/)(docker-compose|compose)\.ya?ml$/i,
    iacDir: /(^|\/)(infra|terraform|deploy|cdk|pulumi)(\/)/i,
    tfFile: /\.tf$/i,
    k8sDir: /(^|\/)(k8s|kubernetes)(\/)/i,
    manifestsYaml: /(^|\/)manifests\/[^/]*\.ya?ml$/i,
    chartYaml: /(^|\/)chart\.ya?ml$/i,
    chartsDir: /(^|\/)charts\//i,
    argocd: /(^|\/)(argocd|argocd-apps)(\/)/i,
    workflowFile: /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i,
    gitlabCi: /(^|\/)\.gitlab-ci\.ya?ml$/i,
    circleCi: /(^|\/)\.circleci\/config\.ya?ml$/i,
    deployWorkflowName: /(deploy|release|cd)/i,
    monitoring: /(grafana|prometheus|(^|\/)dashboards\/|\.dashboard\.json$)/i,
    envExample: /(^|\/)\.env\.(example|sample|template)$/i,
    notebook: /\.ipynb$/i,
    dataDir: /(^|\/)(data|datasets)(\/)/i,
    experimentsDir: /(^|\/)(experiments|exp)(\/)/i,
    modelsDir: /(^|\/)(models|checkpoints)(\/)/i,
    requirements: /(^|\/)(requirements[^/]*\.txt|environment\.ya?ml)$/i,
    mlDepInPath: /(^|\/)(torch|tensorflow|sklearn|scikit-learn|jax|pandas|numpy)/i,
    makefile: /(^|\/)makefile$/i,
    license: /(^|\/)(license|licence|copying)(\.md|\.txt)?$/i,
    changelog: /(^|\/)(changelog|history)(\.md)?$/i,
    examplesDir: /(^|\/)examples?(\/)/i,
    apiDocsDir: /(^|\/)docs\/api\//i,
    openapi: /(\.openapi\.[^/]+$|(^|\/)openapi\.ya?ml$|(^|\/)swagger\.[^/]+$)/i,
    manDir: /(^|\/)man\//i,
    manPage: /\.1$/,
    contentDir: /(^|\/)(content|posts|_posts)(\/)/i,
    nxJson: /(^|\/)nx\.json$/i,
    turboJson: /(^|\/)turbo\.json$/i,
    pnpmWorkspace: /(^|\/)pnpm-workspace\.ya?ml$/i,
    pyprojectToml: /(^|\/)pyproject\.toml$/i,
    setupPy: /(^|\/)setup\.py$/i,
    iosDir: /(^|\/)ios(\/)/i,
    androidDir: /(^|\/)android(\/)/i,
    xcode: /\.(xcodeproj|xcworkspace)(\/|$)/i,
    metroConfig: /(^|\/)metro\.config\.[^/]+$/i,
    rnConfig: /(^|\/)react-native\.config\.[^/]+$/i,
    pubspec: /(^|\/)pubspec\.ya?ml$/i,
    easJson: /(^|\/)eas\.json$/i,
    appConfig: /(^|\/)app\.config\.(js|ts)$/i,
    xamarinDir: /(^|\/)[^/]*\.(droid|ios)(\/)/i,
    screenshotsDir: /(^|\/)(\.github\/)?(screenshots|screens)(\/)/i,
    packageJson: /(^|\/)package\.json$/i,
    binDir: /(^|\/)bin\/[^/]+$/i,
    // Static-site / docs-site generators (root-or-nested config files).
    staticSiteConfig: /(^|\/)(astro\.config\.[^/]+|next\.config\.[^/]+|_config\.ya?ml|hugo\.(toml|ya?ml)|config\.toml|gatsby-config\.[^/]+|docusaurus\.config\.[^/]+|mkdocs\.ya?ml)$/i,
    docsSiteConfig: /(^|\/)(mkdocs\.ya?ml|docusaurus\.config\.[^/]+)$/i,
    docsDir: /(^|\/)docs\//i,
};

/** Root single-script entry points (path with no slash, i.e. at repo root). */
const ROOT_ENTRY = /^(main\.py|index\.js|index\.ts|main\.go|main\.rs|cli\.py|script\.[^/]+)$/i;

function depsOf(pkg: Record<string, unknown> | null | undefined): Record<string, unknown> {
    if (!pkg) return {};
    const deps = (pkg.dependencies as Record<string, unknown> | undefined) ?? {};
    const dev = (pkg.devDependencies as Record<string, unknown> | undefined) ?? {};
    const peer = (pkg.peerDependencies as Record<string, unknown> | undefined) ?? {};
    return { ...deps, ...dev, ...peer };
}

export function deriveRepoSignals(
    files: readonly RepoFileEntry[],
    opts: DeriveRepoSignalsOptions = {},
): Record<string, boolean> {
    const paths = files.map((f) => f.path);
    const any = (re: RegExp): boolean => paths.some((p) => re.test(p));

    const pkg = opts.packageJson ?? null;
    const deps = depsOf(pkg);
    const depNames = Object.keys(deps).map((k) => k.toLowerCase());

    const total = paths.length;
    const notebookCount = paths.filter((p) => RE.notebook.test(p)).length;
    const hasNotebooks = notebookCount > 0;
    // notebook_heavy: ≥3 notebooks OR notebooks are ≥20% of all files.
    const notebookHeavy = notebookCount >= 3 || (total > 0 && notebookCount / total >= 0.2);

    const hasDataDir = any(RE.dataDir);
    const hasRequirementsFile = any(RE.requirements);

    // CI workflow file paths, used by both has_ci and has_deployment_workflow.
    const workflowPaths = paths.filter((p) => RE.workflowFile.test(p));
    const hasCi = workflowPaths.length > 0 || any(RE.gitlabCi) || any(RE.circleCi);
    const hasDeploymentWorkflow = workflowPaths.some((p) => RE.deployWorkflowName.test(p));

    const hasPnpmWorkspace = any(RE.pnpmWorkspace);
    const hasNxJson = any(RE.nxJson);
    const hasTurboJson = any(RE.turboJson);

    // has_multi_package_src: ≥2 nested (non-root) package.json files.
    const nestedPackageJsons = paths.filter((p) => RE.packageJson.test(p) && p.includes('/'));
    const hasMultiPackageSrc = nestedPackageJsons.length >= 2;

    const hasWorkspacesField =
        (pkg != null && pkg.workspaces != null) ||
        opts.projectShape === 'multi_repo' ||
        opts.projectShape === 'monorepo_subset' ||
        hasPnpmWorkspace || hasNxJson || hasTurboJson;

    // has_bin_field: packageJson.bin, else path-only fallback of a bin/ dir.
    const hasBinField = (pkg != null && pkg.bin != null) || any(RE.binDir);

    // has_package_publish_config: explicit publishConfig or private:false (path
    // proxies for npm publish intent are too noisy, so keep to packageJson).
    const hasPackagePublishConfig =
        (pkg != null && pkg.publishConfig != null) || (pkg != null && pkg.private === false);

    // react-native via packageJson deps OR metro/react-native config files.
    const hasReactNative =
        depNames.includes('react-native') || any(RE.metroConfig) || any(RE.rnConfig);

    // expo via app.json+expo dep, app.config.{js,ts}, or eas.json. app.json
    // content is unavailable from paths, so we approximate expo-via-app.json by
    // the presence of the expo dependency.
    const hasExpoConfig =
        any(RE.easJson) || any(RE.appConfig) || depNames.includes('expo');

    // has_root_android_app: root build.gradle/settings.gradle + an app/ dir.
    const hasRootBuildGradle = paths.some((p) => /^(build|settings)\.gradle(\.kts)?$/i.test(p));
    const hasAppDir = paths.some((p) => /^app\//i.test(p));
    const hasRootAndroidApp = hasRootBuildGradle && hasAppDir;

    // has_root_ios_app: an .xcodeproj/.xcworkspace at/near the repo root.
    const hasRootIosApp = paths.some(
        (p) => RE.xcode.test(p) && p.split('/').findIndex((seg) => /\.(xcodeproj|xcworkspace)$/i.test(seg)) <= 1,
    );

    // has_single_script_entry: tiny repo (<15 files) with exactly one obvious
    // root entry point. Best-effort heuristic.
    const rootEntries = paths.filter((p) => !p.includes('/') && ROOT_ENTRY.test(p));
    const hasSingleScriptEntry = total < 15 && rootEntries.length === 1;

    return {
        has_android_dir: any(RE.androidDir),
        has_api_docs: any(RE.apiDocsDir) || any(RE.openapi),
        // has_app_store_link: needs README content (apps.apple.com / play.google.com
        // links) — undetectable from paths alone, so always false.
        has_app_store_link: false,
        has_argocd_apps: any(RE.argocd),
        has_bin_field: hasBinField,
        has_changelog: any(RE.changelog),
        has_ci: hasCi,
        has_compose: any(RE.compose),
        // has_console_scripts: pyproject.toml/setup.py entry points; their
        // presence is the path-level proxy.
        has_console_scripts: any(RE.pyprojectToml) || any(RE.setupPy),
        has_content_dir: any(RE.contentDir),
        has_data_dir: hasDataDir,
        has_deployment_workflow: hasDeploymentWorkflow,
        has_dockerfile: any(RE.dockerfile),
        has_docs_site_config: any(RE.docsSiteConfig) || (any(RE.docsDir) && any(RE.staticSiteConfig)),
        has_env_example: any(RE.envExample),
        has_examples_dir: any(RE.examplesDir),
        has_experiments_dir: any(RE.experimentsDir),
        has_expo_config: hasExpoConfig,
        has_flutter_pubspec: any(RE.pubspec),
        has_helm_chart: any(RE.chartYaml) || any(RE.chartsDir),
        has_iac: any(RE.iacDir) || any(RE.tfFile),
        has_ios_dir: any(RE.iosDir),
        has_k8s_manifests: any(RE.k8sDir) || any(RE.manifestsYaml),
        has_license: any(RE.license),
        // has_live_url_in_readme: needs README content — undetectable from
        // paths alone, so always false.
        has_live_url_in_readme: false,
        has_makefile: any(RE.makefile),
        has_man_page: any(RE.manDir) || any(RE.manPage),
        has_models_dir: any(RE.modelsDir),
        has_monitoring_config: any(RE.monitoring),
        has_multi_package_src: hasMultiPackageSrc,
        has_notebooks: hasNotebooks,
        has_nx_json: hasNxJson,
        has_package_publish_config: hasPackagePublishConfig,
        has_pnpm_workspace: hasPnpmWorkspace,
        has_pyproject_publish: any(RE.pyprojectToml),
        has_react_native: hasReactNative,
        // Path-only: a requirements file plus ML-shaped context (notebooks or a
        // data dir). When packageJson deps mention ML libs we also count it.
        has_requirements_with_ml_deps:
            (hasRequirementsFile && (hasNotebooks || hasDataDir)) ||
            (hasRequirementsFile && any(RE.mlDepInPath)) ||
            depNames.some((d) => /(torch|tensorflow|scikit-learn|jax|pandas|numpy)/.test(d)),
        has_root_android_app: hasRootAndroidApp,
        has_root_ios_app: hasRootIosApp,
        has_screenshots_dir: any(RE.screenshotsDir),
        has_single_script_entry: hasSingleScriptEntry,
        has_static_site_config: any(RE.staticSiteConfig),
        has_turbo_json: hasTurboJson,
        has_workspaces_field: hasWorkspacesField,
        // has_xamarin_mobile: .csproj/.sln content (Xamarin refs) unavailable
        // from paths — use the *.Droid/ / *.iOS/ directory layout as the proxy.
        has_xamarin_mobile: any(RE.xamarinDir),
        notebook_heavy: notebookHeavy,
    };
}
