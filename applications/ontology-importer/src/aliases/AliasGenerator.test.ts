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
    it('npm: adds .js/js variants and de-scopes', () => {
        const a = generateAliases(e({ proposed_canonical_name: 'react', proposed_display_name: 'React' }), 'npm');
        expect(a).toEqual(expect.arrayContaining(['react', 'react.js', 'reactjs']));
    });
    it('lowercases + dedupes', () => {
        const a = generateAliases(e({ proposed_canonical_name: 'Vite', proposed_display_name: 'Vite' }), 'npm');
        expect(a).toEqual([...new Set(a.map((x) => x.toLowerCase()))]);
    });
});
