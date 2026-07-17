/** @format */
import { describe, it, expect } from '@jest/globals';
import { scanArns } from './ArnScanner.js';

describe('scanArns', () => {
    const FILE = 'test/file.yaml';

    it('emits one row for a single ARN with real account', () => {
        const rows = scanArns(
            'arn:aws:secretsmanager:eu-west-1:771826808455:secret:foo/bar-Ab1',
            FILE,
        );
        expect(rows).toEqual([
            {
                raw_name: 'aws_secrets_manager',
                ecosystem: 'aws-arn',
                source_layer: 'iac',
                file_path: FILE,
            },
        ]);
    });

    it('emits 3 rows for 3 distinct ARNs across multiple lines', () => {
        const src = [
            'arn:aws:s3:::my-bucket',
            'arn:aws:sns:eu-west-1:771826808455:topic-x',
            'arn:aws:sqs:eu-west-1:771826808455:queue-y',
        ].join('\n');
        const rows = scanArns(src, FILE);
        const names = rows.map((r) => r.raw_name).sort();
        expect(names).toEqual(['aws_s3', 'aws_sns', 'aws_sqs']);
    });

    it('dedupes two s3 ARNs in the same call', () => {
        const src =
            'arn:aws:s3:eu-west-1:771826808455:accesspoint/x\n' +
            'arn:aws:s3:eu-west-1:771826808455:accesspoint/y';
        const rows = scanArns(src, FILE);
        expect(rows).toHaveLength(1);
        expect(rows[0].raw_name).toBe('aws_s3');
    });

    it('rejects placeholder account 123456789012', () => {
        const rows = scanArns(
            'arn:aws:sns:eu-west-1:123456789012:topic',
            FILE,
        );
        expect(rows).toEqual([]);
    });

    it('rejects all-zero account 000000000000', () => {
        const rows = scanArns(
            'arn:aws:sns:eu-west-1:000000000000:topic',
            FILE,
        );
        expect(rows).toEqual([]);
    });

    it('drops unknown service slugs', () => {
        const rows = scanArns(
            'arn:aws:made-up-service:eu-west-1:771826808455:resource/x',
            FILE,
        );
        expect(rows).toEqual([]);
    });

    it('returns empty for input without ARNs', () => {
        expect(scanArns('plain prose no arns', FILE)).toEqual([]);
    });

    it('emits aws_s3 for the standard bare-bucket ARN format', () => {
        const rows = scanArns('arn:aws:s3:::my-bucket/path/to/key.json', FILE);
        expect(rows).toEqual([
            { raw_name: 'aws_s3', ecosystem: 'aws-arn', source_layer: 'iac', file_path: FILE },
        ]);
    });

    it('handles region-less IAM ARN', () => {
        const rows = scanArns(
            'arn:aws:iam::771826808455:role/some-role',
            FILE,
        );
        expect(rows).toEqual([
            {
                raw_name: 'aws_iam',
                ecosystem: 'aws-arn',
                source_layer: 'iac',
                file_path: FILE,
            },
        ]);
    });
});
