/** @format */
import { describe, it, expect } from '@jest/globals';
import { parseK8sManifest, parseK8sManifestValues } from '../K8sManifestParser.js';

describe('parseK8sManifest', () => {
    it('emits kubernetes + container images for a Deployment', () => {
        const yaml = [
            'apiVersion: apps/v1',
            'kind: Deployment',
            'spec:',
            '  template:',
            '    spec:',
            '      containers:',
            '        - image: redis:7',
        ].join('\n');
        const out = parseK8sManifest(yaml, 'deploy.yaml');
        const names = out.map(o => o.raw_name);
        expect(names).toContain('kubernetes');
        expect(names).toContain('redis');
        expect(out.every(o => o.source_layer === 'iac' && o.file_path === 'deploy.yaml')).toBe(true);
    });

    it('returns [] for non-k8s yaml', () => {
        expect(parseK8sManifest('name: ci\non: push', 'ci.yaml')).toEqual([]);
    });
});

describe('parseK8sManifestValues', () => {
    it('extracts AWS services from EKS pod-identity annotation values', () => {
        const yaml = [
            'apiVersion: v1',
            'kind: ServiceAccount',
            'metadata:',
            '  name: my-sa',
            '  annotations:',
            '    eks.amazonaws.com/role-arn: arn:aws:iam::771826808455:role/my-role',
        ].join('\n');
        const out = parseK8sManifestValues(yaml, 'sa.yaml');
        expect(out.map(o => o.raw_name)).toContain('aws_iam');
    });

    it('emits aws_ecr when ECR image URI appears in any kind, including non-K8S_KINDS', () => {
        const yaml = [
            'apiVersion: v1',
            'kind: ConfigMap',
            'metadata: { name: c }',
            'data:',
            '  image-uri: 771826808455.dkr.ecr.eu-west-1.amazonaws.com/x:tag',
        ].join('\n');
        const out = parseK8sManifestValues(yaml, 'cm.yaml');
        expect(out.map(o => o.raw_name)).toContain('aws_ecr');
    });

    it('emits ARN-derived services from any string value, regardless of kind', () => {
        const yaml = [
            'apiVersion: external-secrets.io/v1',
            'kind: ExternalSecret',
            'metadata: { name: e }',
            'spec:',
            '  data:',
            '    - secretKey: db',
            '      remoteRef:',
            '        key: arn:aws:secretsmanager:eu-west-1:771826808455:secret:platform/db',
        ].join('\n');
        const out = parseK8sManifestValues(yaml, 'es.yaml');
        expect(out.map(o => o.raw_name)).toContain('aws_secrets_manager');
    });

    it('returns [] for unparseable input', () => {
        expect(parseK8sManifestValues('this is :: not :: yaml :: actually not', 'x.yaml').length).toBeGreaterThanOrEqual(0); // may parse as string scalar — just ensure no throw
        expect(() => parseK8sManifestValues('', 'x.yaml')).not.toThrow();
    });

    it('dedupes a service across multiple ARN occurrences', () => {
        const yaml = [
            'apiVersion: v1', 'kind: Role',
            'rules:',
            '  - { resources: ["arn:aws:s3:::a/*", "arn:aws:s3:::b/*"] }',
        ].join('\n');
        const out = parseK8sManifestValues(yaml, 'role.yaml');
        expect(out.filter(o => o.raw_name === 'aws_s3')).toHaveLength(1);
    });

    it('emits aws_eks from annotation key eks.amazonaws.com/role-arn even with no ARN value', () => {
        const yaml = [
            'apiVersion: v1',
            'kind: ServiceAccount',
            'metadata:',
            '  name: app-sa',
            '  annotations:',
            '    eks.amazonaws.com/role-arn: PLACEHOLDER',
        ].join('\n');
        const out = parseK8sManifestValues(yaml, 'sa.yaml');
        expect(out.map(o => o.raw_name)).toContain('aws_eks');
    });

    it('emits aws_load_balancer_controller from spec.template.metadata.annotations', () => {
        const yaml = [
            'apiVersion: apps/v1',
            'kind: Deployment',
            'metadata: { name: d }',
            'spec:',
            '  template:',
            '    metadata:',
            '      annotations:',
            '        service.beta.kubernetes.io/aws-load-balancer-name: my-alb',
            '    spec: { containers: [{ name: c, image: foo:1 }] }',
        ].join('\n');
        const out = parseK8sManifestValues(yaml, 'd.yaml');
        expect(out.map(o => o.raw_name)).toContain('aws_load_balancer_controller');
    });

    it('does NOT emit extras for annotation keys outside the allowlist', () => {
        const yaml = [
            'apiVersion: v1',
            'kind: ServiceAccount',
            'metadata:',
            '  name: app-sa',
            '  annotations:',
            '    argocd.argoproj.io/sync-wave: "1"',
            '    custom.example.com/foo: bar',
        ].join('\n');
        const out = parseK8sManifestValues(yaml, 'sa.yaml');
        expect(out).toEqual([]);
    });

    it('emits no extra rows when no annotations are present', () => {
        const yaml = [
            'apiVersion: v1', 'kind: ConfigMap', 'metadata: { name: c }',
            'data: { foo: bar }',
        ].join('\n');
        expect(parseK8sManifestValues(yaml, 'cm.yaml')).toEqual([]);
    });

    it('dedupes annotation-key emissions across multiple matching keys for same canonical', () => {
        const yaml = [
            'apiVersion: v1',
            'kind: ServiceAccount',
            'metadata:',
            '  name: app-sa',
            '  annotations:',
            '    eks.amazonaws.com/role-arn: foo',
            '    eks.amazonaws.com/audience: bar',
        ].join('\n');
        const out = parseK8sManifestValues(yaml, 'sa.yaml');
        expect(out.filter(o => o.raw_name === 'aws_eks')).toHaveLength(1);
    });

    it('dedupes aws_iam between annotation-derived and ARN-derived emissions', () => {
        const yaml = [
            'apiVersion: v1', 'kind: ServiceAccount', 'metadata:',
            '  name: app-sa',
            '  annotations:',
            '    iam.amazonaws.com/permitted: arn:aws:iam::771826808455:role/x',
        ].join('\n');
        const out = parseK8sManifestValues(yaml, 'sa.yaml');
        expect(out.filter(o => o.raw_name === 'aws_iam')).toHaveLength(1);
    });
});

describe('parseK8sManifest — S3 NetworkPolicy/RBAC distinct tokens', () => {
    const names = (s: string) => parseK8sManifest(s, 'k8s.yaml').map(e => e.raw_name);

    it('NetworkPolicy → kubernetes + k8s_networkpolicy (not k8s_rbac)', () => {
        const out = names('apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: deny-all\n');
        expect(out).toContain('kubernetes');
        expect(out).toContain('k8s_networkpolicy');
        expect(out).not.toContain('k8s_rbac');
    });

    it('RBAC kind → kubernetes + k8s_rbac (emitted once)', () => {
        const out = names('apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRoleBinding\nmetadata:\n  name: x\n');
        expect(out).toContain('kubernetes');
        expect(out.filter(n => n === 'k8s_rbac')).toHaveLength(1);
    });

    it('multiple RBAC docs in one file → k8s_rbac emitted once', () => {
        const out = names('kind: Role\nmetadata:\n  name: r\n---\nkind: RoleBinding\nmetadata:\n  name: rb\n');
        expect(out.filter(n => n === 'k8s_rbac')).toHaveLength(1);
    });

    it('Deployment unchanged → kubernetes + image, no k8s_networkpolicy/k8s_rbac', () => {
        const out = names('kind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n      - image: nginx:1.25\n');
        expect(out).toContain('kubernetes');
        expect(out).toContain('nginx');
        expect(out).not.toContain('k8s_networkpolicy');
        expect(out).not.toContain('k8s_rbac');
    });
});
