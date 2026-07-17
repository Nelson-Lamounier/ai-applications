/** @format */
import { describe, it, expect } from '@jest/globals';
import { deriveRepoSignals, REPO_SIGNAL_KEYS } from '../repo-signals.js';
import type { RepoFileEntry } from '../repo-signals.js';

const files = (...paths: string[]): RepoFileEntry[] => paths.map((path) => ({ path }));

// The canonical 46-key vocabulary the seeded ontology (migration 046) gates on.
const EXPECTED_KEYS = [
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
].sort();

describe('deriveRepoSignals — contract', () => {
    it('returns an object with ALL 46 signal keys present', () => {
        const result = deriveRepoSignals(files('README.md'));
        expect(Object.keys(result).sort()).toEqual(EXPECTED_KEYS);
        expect(EXPECTED_KEYS).toHaveLength(46);
    });

    it('exports REPO_SIGNAL_KEYS matching the 46-key vocabulary', () => {
        expect([...REPO_SIGNAL_KEYS].sort()).toEqual(EXPECTED_KEYS);
    });

    it('empty file list → all 46 keys false, no throw', () => {
        const result = deriveRepoSignals([]);
        expect(Object.keys(result).sort()).toEqual(EXPECTED_KEYS);
        expect(Object.values(result).every((v) => v === false)).toBe(true);
    });

    it('always sets path-undetectable signals false', () => {
        const result = deriveRepoSignals(files('README.md', 'src/app.ts'));
        expect(result.has_live_url_in_readme).toBe(false);
        expect(result.has_app_store_link).toBe(false);
    });
});

describe('deriveRepoSignals — production SaaS tree', () => {
    const result = deriveRepoSignals(files(
        '.github/workflows/deploy.yml',
        'Dockerfile',
        'infra/terraform/main.tf',
        'src/index.ts',
    ));
    it('detects CI', () => expect(result.has_ci).toBe(true));
    it('detects deployment workflow', () => expect(result.has_deployment_workflow).toBe(true));
    it('detects Dockerfile', () => expect(result.has_dockerfile).toBe(true));
    it('detects IaC', () => expect(result.has_iac).toBe(true));
});

describe('deriveRepoSignals — ML tree', () => {
    const result = deriveRepoSignals(files(
        'notebooks/explore.ipynb',
        'notebooks/train.ipynb',
        'notebooks/eval.ipynb',
        'data/x.csv',
        'requirements.txt',
    ));
    it('detects notebooks', () => expect(result.has_notebooks).toBe(true));
    it('detects notebook_heavy (≥3 ipynb)', () => expect(result.notebook_heavy).toBe(true));
    it('detects data dir', () => expect(result.has_data_dir).toBe(true));
    it('detects requirements with ML deps', () => expect(result.has_requirements_with_ml_deps).toBe(true));
});

describe('deriveRepoSignals — monorepo', () => {
    const result = deriveRepoSignals(files(
        'pnpm-workspace.yaml',
        'packages/a/package.json',
        'packages/b/package.json',
        'package.json',
    ));
    it('detects pnpm workspace', () => expect(result.has_pnpm_workspace).toBe(true));
    it('detects multi-package src', () => expect(result.has_multi_package_src).toBe(true));
    it('infers workspaces field from pnpm-workspace', () => expect(result.has_workspaces_field).toBe(true));
});

describe('deriveRepoSignals — packageJson opts', () => {
    it('detects bin field from packageJson', () => {
        const result = deriveRepoSignals(files('package.json'), { packageJson: { bin: { foo: 'cli.js' } } });
        expect(result.has_bin_field).toBe(true);
    });
    it('detects publish config from packageJson.publishConfig', () => {
        const result = deriveRepoSignals(files('package.json'), { packageJson: { publishConfig: {} } });
        expect(result.has_package_publish_config).toBe(true);
    });
    it('detects publish config from explicit private:false', () => {
        const result = deriveRepoSignals(files('package.json'), { packageJson: { private: false } });
        expect(result.has_package_publish_config).toBe(true);
    });
    it('detects workspaces field from packageJson.workspaces', () => {
        const result = deriveRepoSignals(files('package.json'), { packageJson: { workspaces: ['packages/*'] } });
        expect(result.has_workspaces_field).toBe(true);
    });
    it('detects react-native from packageJson deps', () => {
        const result = deriveRepoSignals(files('package.json'), {
            packageJson: { dependencies: { 'react-native': '0.74.0' } },
        });
        expect(result.has_react_native).toBe(true);
    });
    it('infers workspaces field from projectShape multi_repo', () => {
        const result = deriveRepoSignals(files('package.json'), { projectShape: 'multi_repo' });
        expect(result.has_workspaces_field).toBe(true);
    });
});

describe('deriveRepoSignals — mobile tree', () => {
    const result = deriveRepoSignals(files(
        'ios/Podfile',
        'android/build.gradle',
        'pubspec.yaml',
        'lib/main.dart',
    ));
    it('detects ios dir', () => expect(result.has_ios_dir).toBe(true));
    it('detects android dir', () => expect(result.has_android_dir).toBe(true));
    it('detects flutter pubspec', () => expect(result.has_flutter_pubspec).toBe(true));
});

describe('deriveRepoSignals — misc signal coverage', () => {
    it('detects compose, helm, k8s, argocd, monitoring', () => {
        const result = deriveRepoSignals(files(
            'docker-compose.yml',
            'charts/app/Chart.yaml',
            'k8s/deployment.yaml',
            'argocd/app.yaml',
            'monitoring/grafana/dashboard.json',
        ));
        expect(result.has_compose).toBe(true);
        expect(result.has_helm_chart).toBe(true);
        expect(result.has_k8s_manifests).toBe(true);
        expect(result.has_argocd_apps).toBe(true);
        expect(result.has_monitoring_config).toBe(true);
    });

    it('detects standard repo hygiene files', () => {
        const result = deriveRepoSignals(files(
            'LICENSE',
            'CHANGELOG.md',
            'Makefile',
            '.env.example',
            'examples/demo.ts',
        ));
        expect(result.has_license).toBe(true);
        expect(result.has_changelog).toBe(true);
        expect(result.has_makefile).toBe(true);
        expect(result.has_env_example).toBe(true);
        expect(result.has_examples_dir).toBe(true);
    });

    it('detects monorepo tooling and python publish signals', () => {
        const result = deriveRepoSignals(files('nx.json', 'turbo.json', 'pyproject.toml', 'setup.py'));
        expect(result.has_nx_json).toBe(true);
        expect(result.has_turbo_json).toBe(true);
        expect(result.has_pyproject_publish).toBe(true);
        expect(result.has_console_scripts).toBe(true);
        expect(result.has_workspaces_field).toBe(true); // inferred via nx/turbo
    });

    it('detects static site, docs site, content, api docs, man pages', () => {
        const result = deriveRepoSignals(files(
            'astro.config.mjs',
            'mkdocs.yml',
            'content/post.md',
            'docs/api/openapi.yaml',
            'man/tool.1',
        ));
        expect(result.has_static_site_config).toBe(true);
        expect(result.has_docs_site_config).toBe(true);
        expect(result.has_content_dir).toBe(true);
        expect(result.has_api_docs).toBe(true);
        expect(result.has_man_page).toBe(true);
    });

    it('detects ML experiments/models dirs and screenshots', () => {
        const result = deriveRepoSignals(files(
            'experiments/run1.py',
            'models/checkpoint.pt',
            'screenshots/home.png',
        ));
        expect(result.has_experiments_dir).toBe(true);
        expect(result.has_models_dir).toBe(true);
        expect(result.has_screenshots_dir).toBe(true);
    });

    it('detects root native apps, expo, react-native config, xamarin', () => {
        const ios = deriveRepoSignals(files('MyApp.xcodeproj/project.pbxproj'));
        expect(ios.has_root_ios_app).toBe(true);
        const android = deriveRepoSignals(files('build.gradle', 'settings.gradle', 'app/build.gradle'));
        expect(android.has_root_android_app).toBe(true);
        const expo = deriveRepoSignals(files('eas.json', 'app.config.ts'));
        expect(expo.has_expo_config).toBe(true);
        const rn = deriveRepoSignals(files('metro.config.js'));
        expect(rn.has_react_native).toBe(true);
        const xamarin = deriveRepoSignals(files('App.Droid/MainActivity.cs', 'App.iOS/AppDelegate.cs'));
        expect(xamarin.has_xamarin_mobile).toBe(true);
    });

    it('detects single-script entry in a tiny repo', () => {
        const result = deriveRepoSignals(files('main.py', 'README.md'));
        expect(result.has_single_script_entry).toBe(true);
    });

    it('does NOT flag single-script entry in a large repo', () => {
        const many = Array.from({ length: 20 }, (_, i) => `src/mod${i}.ts`);
        const result = deriveRepoSignals(files('main.py', ...many));
        expect(result.has_single_script_entry).toBe(false);
    });

    it('notebook_heavy via ratio (≥20% of files)', () => {
        const result = deriveRepoSignals(files('a.ipynb', 'b.py', 'c.py', 'd.py'));
        expect(result.has_notebooks).toBe(true);
        expect(result.notebook_heavy).toBe(true); // 1/4 = 25% ≥ 20%
    });

    it('uses bin/ dir as path-only fallback for has_bin_field', () => {
        const result = deriveRepoSignals(files('bin/mycli', 'src/index.ts'));
        expect(result.has_bin_field).toBe(true);
    });
});
