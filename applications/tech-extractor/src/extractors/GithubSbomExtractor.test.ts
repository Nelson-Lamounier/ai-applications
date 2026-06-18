/** @format */
import { describe, it, expect } from '@jest/globals';
import { parseGithubSpdx } from './GithubSbomExtractor.js';

const doc = JSON.stringify({
    sbom: {
        spdxVersion: 'SPDX-2.3',
        packages: [
            // The root document package describes the repo itself — no purl → skipped.
            { name: 'com.github.owner/repo', SPDXID: 'SPDXRef-DOCUMENT' },
            {
                name: 'cors', versionInfo: '2.8.5',
                externalRefs: [{ referenceType: 'purl', referenceLocator: 'pkg:npm/cors@2.8.5' }],
            },
            {
                name: '@aws-sdk/client-s3', versionInfo: '3.0.0',
                externalRefs: [{ referenceType: 'purl', referenceLocator: 'pkg:npm/%40aws-sdk/client-s3@3.0.0' }],
            },
        ],
    },
});

describe('parseGithubSpdx', () => {
    it('maps SPDX packages (via their purl) to github-sbom evidence, skipping purl-less ones', () => {
        const out = parseGithubSpdx(doc);
        expect(out).toHaveLength(2);
        expect(out[0]).toEqual({
            raw_name: 'cors', ecosystem: 'npm', version: '2.8.5',
            source_layer: 'github-sbom', file_path: '(github-dependency-graph)',
        });
        expect(out[1]).toMatchObject({ raw_name: '@aws-sdk/client-s3', ecosystem: 'npm', version: '3.0.0' });
    });

    it('returns [] for empty or non-JSON input', () => {
        expect(parseGithubSpdx('{}')).toEqual([]);
        expect(parseGithubSpdx('not json')).toEqual([]);
    });
});
