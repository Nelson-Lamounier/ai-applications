/** @format */
import { describe, it, expect } from '@jest/globals';
import { parseK8sManifest } from './K8sManifestParser.js';

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
