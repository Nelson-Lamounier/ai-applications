/** @format */
import { describe, it, expect } from '@jest/globals';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parseK8sManifest, parseK8sManifestValues } from '../extractors/iac/K8sManifestParser.js';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'iac-value-chart');

describe('IaC value scanner integration', () => {
    it('emits expected union of canonicals across a mini chart', async () => {
        const files = ['sa.yaml', 'external-secret.yaml', 'job.yaml'];
        const all: string[] = [];
        for (const f of files) {
            const src = await fs.readFile(path.join(FIXTURE_DIR, f), 'utf-8');
            for (const e of parseK8sManifest(src, f))       all.push(e.raw_name);
            for (const e of parseK8sManifestValues(src, f)) all.push(e.raw_name);
        }
        // parseK8sManifest also emits the container-image basename as a
        // docker-ecosystem raw_name (here `tech-extractor` from the ECR URI);
        // assert the AWS canonicals + `kubernetes` are present rather than
        // freezing the docker basename which is fixture-incidental.
        expect([...new Set(all)].sort()).toEqual([
            'aws_ecr',
            'aws_eks',
            'aws_iam',
            'aws_secrets_manager',
            'kubernetes',
            'tech-extractor',
        ]);
    });
});
