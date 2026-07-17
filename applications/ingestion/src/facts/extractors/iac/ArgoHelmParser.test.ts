/** @format */
import { describe, it, expect } from '@jest/globals';
import { parseArgoApplication, parseHelmChart, parseHelmValues } from './ArgoHelmParser.js';

describe('parseArgoApplication', () => {
    it('emits argocd + tool name from charts/<name> path', () => {
        const yaml = [
            'apiVersion: argoproj.io/v1alpha1',
            'kind: Application',
            'metadata:',
            '  name: cert-manager',
            'spec:',
            '  source:',
            '    path: charts/cert-manager/chart',
        ].join('\n');
        const out = parseArgoApplication(yaml, 'apps/cert-manager.yaml');
        const names = out.map(o => o.raw_name);
        expect(names).toContain('argocd');
        expect(names).toContain('cert-manager');
        const argoToken = out.find(o => o.raw_name === 'argocd');
        expect(argoToken?.ecosystem).toBe('iac');
        expect(argoToken?.source_layer).toBe('iac');
        const toolToken = out.find(o => o.raw_name === 'cert-manager');
        expect(toolToken?.ecosystem).toBe('argocd');
        expect(toolToken?.source_layer).toBe('iac');
        expect(toolToken?.file_path).toBe('apps/cert-manager.yaml');
    });

    it('derives tool name from charts/<name> even when nested deeper', () => {
        const yaml = [
            'apiVersion: argoproj.io/v1alpha1',
            'kind: Application',
            'metadata:',
            '  name: traefik-app',
            'spec:',
            '  source:',
            '    path: charts/traefik/chart',
        ].join('\n');
        const out = parseArgoApplication(yaml, 'argocd-apps/traefik.yaml');
        const names = out.map(o => o.raw_name);
        expect(names).toContain('traefik');
        expect(names).not.toContain('traefik-app');
    });

    it('falls back to metadata.name with env suffix stripped', () => {
        const yaml = [
            'apiVersion: argoproj.io/v1alpha1',
            'kind: Application',
            'metadata:',
            '  name: my-service-eks-development',
            'spec:',
            '  source:',
            '    path: some/other/path',
        ].join('\n');
        const out = parseArgoApplication(yaml, 'apps/my-service.yaml');
        const names = out.map(o => o.raw_name);
        expect(names).toContain('argocd');
        expect(names).toContain('my-service');
    });

    it('strips -production suffix from metadata.name fallback', () => {
        const yaml = [
            'apiVersion: argoproj.io/v1alpha1',
            'kind: Application',
            'metadata:',
            '  name: api-gateway-production',
            'spec:',
            '  source:',
            '    path: no-charts-here',
        ].join('\n');
        const out = parseArgoApplication(yaml, 'apps/api-gateway.yaml');
        const names = out.map(o => o.raw_name);
        expect(names).toContain('api-gateway');
    });

    it('returns [] for non-ArgoCD YAML', () => {
        const yaml = [
            'apiVersion: apps/v1',
            'kind: Deployment',
            'metadata:',
            '  name: my-app',
        ].join('\n');
        expect(parseArgoApplication(yaml, 'deploy.yaml')).toEqual([]);
    });

    it('returns [] for invalid YAML', () => {
        expect(parseArgoApplication('{{{{invalid', 'bad.yaml')).toEqual([]);
    });

    it('handles multi-doc YAML with mixed docs', () => {
        const yaml = [
            'apiVersion: apps/v1',
            'kind: Deployment',
            'metadata:',
            '  name: boring',
            '---',
            'apiVersion: argoproj.io/v1alpha1',
            'kind: Application',
            'metadata:',
            '  name: redis',
            'spec:',
            '  source:',
            '    path: charts/redis/chart',
        ].join('\n');
        const out = parseArgoApplication(yaml, 'multi.yaml');
        const names = out.map(o => o.raw_name);
        expect(names).toContain('argocd');
        expect(names).toContain('redis');
        expect(names).not.toContain('boring');
    });
});

describe('parseHelmChart', () => {
    it('emits helm + chart name + dependencies', () => {
        const yaml = [
            'apiVersion: v2',
            'name: my-chart',
            'type: application',
            'version: 1.0.0',
            'dependencies:',
            '  - name: postgresql',
            '    version: 12.0.0',
            '    repository: https://charts.bitnami.com/bitnami',
            '  - name: redis',
            '    version: 17.0.0',
            '    repository: https://charts.bitnami.com/bitnami',
        ].join('\n');
        const out = parseHelmChart(yaml, 'Chart.yaml');
        const names = out.map(o => o.raw_name);
        expect(names).toContain('helm');
        expect(names).toContain('my-chart');
        expect(names).toContain('postgresql');
        expect(names).toContain('redis');
        const helmToken = out.find(o => o.raw_name === 'helm');
        expect(helmToken?.ecosystem).toBe('iac');
        const chartToken = out.find(o => o.raw_name === 'my-chart');
        expect(chartToken?.ecosystem).toBe('helm');
        expect(chartToken?.source_layer).toBe('iac');
        expect(chartToken?.file_path).toBe('Chart.yaml');
    });

    it('emits helm + chart name when no dependencies', () => {
        const yaml = [
            'apiVersion: v1',
            'name: simple-chart',
            'version: 0.1.0',
        ].join('\n');
        const out = parseHelmChart(yaml, 'charts/simple/Chart.yaml');
        const names = out.map(o => o.raw_name);
        expect(names).toContain('helm');
        expect(names).toContain('simple-chart');
        expect(names).toHaveLength(2);
    });

    it('returns [] for non-Chart YAML (missing name)', () => {
        const yaml = [
            'apiVersion: apps/v1',
            'kind: Deployment',
        ].join('\n');
        expect(parseHelmChart(yaml, 'deploy.yaml')).toEqual([]);
    });

    it('returns [] for wrong apiVersion', () => {
        const yaml = [
            'apiVersion: v3',
            'name: fake',
        ].join('\n');
        expect(parseHelmChart(yaml, 'Chart.yaml')).toEqual([]);
    });

    it('returns [] for invalid YAML', () => {
        expect(parseHelmChart('{{{{invalid', 'Chart.yaml')).toEqual([]);
    });
});

describe('parseHelmValues', () => {
    const monitoringValues = [
        '# Prometheus',
        'prometheus:',
        '  image: prom/prometheus:v3.3.0',
        '# Grafana',
        'grafana:',
        '  image: grafana/grafana:11.6.0',
        'loki:',
        '  image: grafana/loki:3.5.0',
        'tempo:',
        '  image: grafana/tempo:2.7.2',
    ].join('\n');

    it('extracts tool name from each image: <vendor>/<tool>:<tag> declaration', () => {
        const out = parseHelmValues(monitoringValues, 'charts/monitoring/chart/values.yaml');
        const names = out.map((o) => o.raw_name).sort();
        expect(names).toEqual(['grafana', 'loki', 'prometheus', 'tempo']);
        for (const ev of out) {
            expect(ev.ecosystem).toBe('docker');
            expect(ev.source_layer).toBe('iac');
            expect(ev.file_path).toBe('charts/monitoring/chart/values.yaml');
        }
    });

    it('handles digest-only images (image: name@sha256:…)', () => {
        const src = 'agent:\n  image: grafana/alloy@sha256:abc123\n';
        const out = parseHelmValues(src, 'values.yaml');
        expect(out.map((o) => o.raw_name)).toEqual(['alloy']);
    });

    it('handles bare image names without a registry prefix', () => {
        const src = 'svc:\n  image: redis:7.2\n';
        const out = parseHelmValues(src, 'values.yaml');
        expect(out.map((o) => o.raw_name)).toEqual(['redis']);
    });

    it('descends into nested objects and arrays', () => {
        const src = [
            'a:',
            '  b:',
            '    image: docker.io/library/postgres:16',
            'list:',
            '  - image: bitnami/redis:7',
            '  - image: bitnami/mongodb:7',
        ].join('\n');
        const out = parseHelmValues(src, 'values.yaml');
        expect(out.map((o) => o.raw_name).sort()).toEqual(['mongodb', 'postgres', 'redis']);
    });

    it('returns [] for non-yaml / unparseable input', () => {
        expect(parseHelmValues('{{{{invalid', 'values.yaml')).toEqual([]);
    });

    it('returns [] when no image: keys present', () => {
        expect(parseHelmValues('namespace: monitoring\nreplicas: 3\n', 'values.yaml')).toEqual([]);
    });

    it('ignores image: values that are NOT strings (e.g. nested image: { repository, tag } objects)', () => {
        // Common Helm pattern — repository/tag split. Not handled here; emits nothing for this shape.
        const src = 'svc:\n  image:\n    repository: grafana/loki\n    tag: 3.5.0\n';
        expect(parseHelmValues(src, 'values.yaml')).toEqual([]);
    });
});
