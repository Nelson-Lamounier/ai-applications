/** @format */
import { describe, it, expect } from '@jest/globals';
import { parseAzureServices, azureCategoryFor } from './AzureRestSpecsSource.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('parseAzureServices', () => {
    it('maps Azure service dirs to RawImportEntries', () => {
        const raw = JSON.parse(readFileSync(path.join(__dirname, '__tests__/fixtures/azure-specs.json'), 'utf-8'));
        const entries = parseAzureServices(raw);
        const cosmos = entries.find((e) => e.source_identifier === 'cosmos-db');
        expect(cosmos).toMatchObject({
            source_identifier: 'cosmos-db',
            proposed_canonical_name: 'azure_cosmos_db',
            proposed_display_name: 'Cosmos Db',
        });
    });
});

describe('azureCategoryFor', () => {
    it('classifies known services', () => {
        expect(azureCategoryFor('storage')).toBe('cloud_storage');
        expect(azureCategoryFor('cosmos-db')).toBe('database_nosql');
        expect(azureCategoryFor('unknown-svc')).toBe('cloud_compute');
    });
});
