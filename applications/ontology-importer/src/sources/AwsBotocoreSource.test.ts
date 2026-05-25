/** @format */
import { describe, it, expect } from '@jest/globals';
import { parseBotocoreService, awsCategoryFor } from './AwsBotocoreSource.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('parseBotocoreService', () => {
    it('maps service metadata to a RawImportEntry', () => {
        const raw = JSON.parse(readFileSync(path.join(__dirname, '__tests__/fixtures/botocore-s3-service-2.json'), 'utf-8'));
        const e = parseBotocoreService(raw, 's3');
        expect(e).toMatchObject({
            source_identifier: 's3',
            proposed_canonical_name: 'aws_s3',
            proposed_display_name: 'Amazon S3',
        });
        expect(e.keywords).toEqual(expect.arrayContaining(['s3', 'amazon s3', 'aws s3']));
    });
});

describe('awsCategoryFor', () => {
    it('classifies known services', () => {
        expect(awsCategoryFor('s3')).toBe('cloud_storage');
        expect(awsCategoryFor('lambda')).toBe('cloud_serverless');
        expect(awsCategoryFor('dynamodb')).toBe('database_nosql');
        expect(awsCategoryFor('cloudformation')).toBe('iac');
        expect(awsCategoryFor('unknown-svc')).toBe('cloud_compute');
    });
});
