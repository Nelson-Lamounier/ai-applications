/** @format */
import { describe, it, expect } from '@jest/globals';
import { parseMavenResponse } from './MavenCentralSource.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('parseMavenResponse', () => {
    it('maps a Maven solr response to RawImportEntry[]', () => {
        const raw = JSON.parse(readFileSync(path.join(__dirname, '__tests__/fixtures/maven.json'), 'utf-8'));
        const entries = parseMavenResponse(raw);
        expect(entries).toHaveLength(2);

        const spring = entries[0];
        expect(spring).toMatchObject({
            source_identifier: 'org.springframework:spring-core',
            proposed_canonical_name: 'spring-core',
            proposed_display_name: 'spring-core',
        });
        expect(spring.source_metadata.groupId).toBe('org.springframework');
        expect(spring.source_metadata.artifactId).toBe('spring-core');
        expect(spring.keywords).toEqual(expect.arrayContaining(['spring-core', 'org.springframework']));
    });
});
