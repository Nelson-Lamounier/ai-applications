/** @format */
import { describe, it, expect } from '@jest/globals';
import { parseGcpServices, gcpCategoryFor } from './GcpServiceUsageSource.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('parseGcpServices', () => {
    it('maps GCP service config to RawImportEntries', () => {
        const raw = JSON.parse(readFileSync(path.join(__dirname, '__tests__/fixtures/gcp-services.json'), 'utf-8'));
        const entries = parseGcpServices(raw);
        const compute = entries.find((e) => e.source_identifier === 'compute');
        expect(compute).toMatchObject({
            source_identifier: 'compute',
            proposed_canonical_name: 'gcp_compute',
            proposed_display_name: 'Compute Engine',
        });
        expect(compute?.keywords).toEqual(expect.arrayContaining(['compute', 'gcp compute', 'google cloud compute']));
    });
});

describe('gcpCategoryFor', () => {
    it('classifies known services', () => {
        expect(gcpCategoryFor('compute')).toBe('cloud_compute');
        expect(gcpCategoryFor('storage')).toBe('cloud_storage');
        expect(gcpCategoryFor('bigquery')).toBe('cloud_database');
        expect(gcpCategoryFor('unknown-svc')).toBe('cloud_compute');
    });
});
