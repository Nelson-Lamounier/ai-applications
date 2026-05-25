/** @format */
import { describe, it, expect } from '@jest/globals';
import { parseCratesPage, cratesCategory } from './CratesIoSource.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('parseCratesPage', () => {
    it('maps a crates page to RawImportEntry[]', () => {
        const raw = JSON.parse(readFileSync(path.join(__dirname, '__tests__/fixtures/cratesio.json'), 'utf-8'));
        const entries = parseCratesPage(raw);
        expect(entries).toHaveLength(2);

        const tokio = entries[0];
        expect(tokio).toMatchObject({
            source_identifier: 'tokio',
            proposed_canonical_name: 'tokio',
            proposed_display_name: 'tokio',
            repository_url: 'https://github.com/tokio-rs/tokio',
        });
        expect(tokio.source_metadata.categories).toEqual(['asynchronous']);

        const actix = entries[1];
        expect(actix).toMatchObject({
            source_identifier: 'actix-web',
            proposed_canonical_name: 'actix-web',
            repository_url: 'https://github.com/actix/actix-web',
        });
        expect(actix.source_metadata.categories).toEqual(['web-programming::http-server']);
    });
});

describe('cratesCategory', () => {
    it('maps native crates categories to OntologyCategory', () => {
        expect(cratesCategory(['web-programming::http-server'])).toBe('framework_web');
        expect(cratesCategory(['database'])).toBe('database_relational');
        expect(cratesCategory(['asynchronous'])).toBe('runtime');
        expect(cratesCategory(['nonexistent'])).toBe(null);
    });
});
