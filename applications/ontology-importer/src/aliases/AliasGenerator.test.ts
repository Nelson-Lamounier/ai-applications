/** @format */
import { describe, it, expect } from '@jest/globals';
import { generateAliases } from './AliasGenerator.js';
import type { RawImportEntry } from '@bedrock/shared';

const e = (o: Partial<RawImportEntry>): RawImportEntry =>
    ({ source_identifier: '', proposed_canonical_name: '', proposed_display_name: '', source_metadata: {}, ...o });

describe('generateAliases', () => {
    it('produces canonical, display-lower, and spacing variants', () => {
        const a = generateAliases(e({ proposed_canonical_name: 'aws_s3', proposed_display_name: 'Amazon S3' }), 'aws');
        expect(a).toEqual(expect.arrayContaining(['aws_s3', 'amazon s3', 'amazons3', 'amazon-s3']));
    });
    it('npm: adds .js/js suffix variants', () => {
        const a = generateAliases(e({ proposed_canonical_name: 'react', proposed_display_name: 'React' }), 'npm');
        expect(a).toEqual(expect.arrayContaining(['react', 'react.js', 'reactjs']));
    });
    it('lowercases + dedupes', () => {
        const a = generateAliases(e({ proposed_canonical_name: 'vite', proposed_display_name: 'Vite' }), 'npm');
        // all entries are lowercase
        expect(a.every((x) => x === x.toLowerCase())).toBe(true);
        // no duplicates
        expect(a.length).toBe(new Set(a).size);
        // 'Vite' display + 'vite' canonical must collapse to a single 'vite'
        expect(a.filter((x) => x === 'vite')).toHaveLength(1);
    });
});
