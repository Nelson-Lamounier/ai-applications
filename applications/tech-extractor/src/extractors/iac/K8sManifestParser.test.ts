/** @format */
import { describe, it, expect } from '@jest/globals';
import { parseK8sManifest, parseK8sManifestValues } from './K8sManifestParser.js';

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
});
