/** @format */
import { describe, it, expect } from '@jest/globals';
import { scanEcrUris } from '../EcrUriScanner.js';

describe('scanEcrUris', () => {
    const FILE = 'test/file.yaml';

    it('emits one row for a single ECR URI with tag', () => {
        const rows = scanEcrUris(
            '771826808455.dkr.ecr.eu-west-1.amazonaws.com/tech-extractor:abc-r1',
            FILE,
        );
        expect(rows).toEqual([
            {
                raw_name: 'aws_ecr',
                ecosystem: 'image-uri',
                source_layer: 'iac',
                file_path: FILE,
            },
        ]);
    });

    it('dedupes two distinct ECR URIs in the same call', () => {
        const src = [
            '771826808455.dkr.ecr.eu-west-1.amazonaws.com/tech-extractor:abc-r1',
            '771826808455.dkr.ecr.us-east-1.amazonaws.com/other-repo:latest',
        ].join('\n');
        const rows = scanEcrUris(src, FILE);
        expect(rows).toHaveLength(1);
        expect(rows[0].raw_name).toBe('aws_ecr');
    });

    it('rejects placeholder accounts', () => {
        expect(
            scanEcrUris(
                '000000000000.dkr.ecr.us-east-1.amazonaws.com/x:y',
                FILE,
            ),
        ).toEqual([]);
        expect(
            scanEcrUris(
                '123456789012.dkr.ecr.us-east-1.amazonaws.com/x:y',
                FILE,
            ),
        ).toEqual([]);
    });

    it('returns empty for non-ECR registries', () => {
        expect(scanEcrUris('docker.io/library/nginx:latest', FILE)).toEqual([]);
        expect(scanEcrUris('ghcr.io/owner/img:tag', FILE)).toEqual([]);
    });

    it('returns empty for empty input', () => {
        expect(scanEcrUris('', FILE)).toEqual([]);
    });
});
