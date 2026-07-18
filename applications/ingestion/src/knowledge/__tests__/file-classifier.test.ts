/**
 * @format
 * file-classifier Unit Tests
 *
 * Pure path-based classification. Each file gets one semantic role so retrieval
 * can filter and weight by role (source vs test vs CI vs IaC vs config vs db …)
 * instead of treating every chunk as undifferentiated text.
 */

import { classifyFile } from '../file-classifier';

describe('classifyFile', () => {
    it('classifies documentation by extension', () => {
        expect(classifyFile('README.md')).toBe('docs');
        expect(classifyFile('docs/architecture.mdx')).toBe('docs');
    });

    it('classifies commit-history synthetic paths', () => {
        expect(classifyFile('_commits/2026-W12.commit_history')).toBe('history');
    });

    it('classifies test files by path, beating their source extension', () => {
        expect(classifyFile('src/foo.test.ts')).toBe('test');
        expect(classifyFile('pkg/bar.spec.tsx')).toBe('test');
        expect(classifyFile('src/__tests__/helper.ts')).toBe('test');
        expect(classifyFile('internal/handler_test.go')).toBe('test');
        expect(classifyFile('tests/test_pipeline.py')).toBe('test');
    });

    it('classifies CI/CD workflows', () => {
        expect(classifyFile('.github/workflows/ci.yml')).toBe('ci');
        expect(classifyFile('.github/workflows/deploy.yaml')).toBe('ci');
        expect(classifyFile('.gitlab-ci.yml')).toBe('ci');
        expect(classifyFile('Jenkinsfile')).toBe('ci');
        expect(classifyFile('.circleci/config.yml')).toBe('ci');
    });

    it('classifies infrastructure as code', () => {
        expect(classifyFile('infra/main.tf')).toBe('iac');
        expect(classifyFile('terraform/variables.tfvars')).toBe('iac');
        expect(classifyFile('Dockerfile')).toBe('iac');
        expect(classifyFile('docker-compose.yaml')).toBe('iac');
        expect(classifyFile('infra/lib/stacks/api-stack.ts')).toBe('iac');
        expect(classifyFile('charts/app/templates/deployment.yaml')).toBe('iac');
        expect(classifyFile('ansible/playbooks/site.yml')).toBe('iac');
        expect(classifyFile('k8s/ingress.yaml')).toBe('iac');
    });

    it('classifies database/migration files', () => {
        expect(classifyFile('migrations/084_add_index.sql')).toBe('db');
        expect(classifyFile('db/schema.sql')).toBe('db');
        expect(classifyFile('prisma/schema.prisma')).toBe('db');
    });

    it('classifies shell/build scripts', () => {
        expect(classifyFile('scripts/deploy.sh')).toBe('script');
        expect(classifyFile('bin/setup.bash')).toBe('script');
        expect(classifyFile('Makefile')).toBe('script');
    });

    it('classifies application source code', () => {
        expect(classifyFile('src/index.ts')).toBe('source');
        expect(classifyFile('app/main.py')).toBe('source');
        expect(classifyFile('cmd/server/main.go')).toBe('source');
        expect(classifyFile('src/lib.rs')).toBe('source');
        expect(classifyFile('Service.java')).toBe('source');
    });

    it('classifies plain config', () => {
        expect(classifyFile('config/settings.yaml')).toBe('config');
        expect(classifyFile('tsconfig.json')).toBe('config');
        expect(classifyFile('app.toml')).toBe('config');
    });

    it('classifies tabular data', () => {
        expect(classifyFile('data/seed.csv')).toBe('data');
        expect(classifyFile('fixtures/rows.ndjson')).toBe('data');
    });

    it('falls back to other for unknown paths', () => {
        expect(classifyFile('LICENSE')).toBe('other');
        expect(classifyFile('assets/logo.png')).toBe('other');
    });

    it('prefers CI over generic config for a workflow YAML', () => {
        // A workflow is a .yml but must not read as plain config.
        expect(classifyFile('.github/workflows/release.yml')).toBe('ci');
    });

    it('prefers IaC over generic config for a helm/k8s YAML', () => {
        expect(classifyFile('deploy/helm/templates/svc.yaml')).toBe('iac');
    });
});
