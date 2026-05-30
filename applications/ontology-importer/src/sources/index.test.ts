/** @format */
import { describe, it, expect } from '@jest/globals';
import { ALL_SOURCES } from './index.js';

describe('ALL_SOURCES', () => {
    it('returns 7 sources with unique names and non-empty ecosystems', () => {
        const sources = ALL_SOURCES();
        expect(sources).toHaveLength(7);
        const names = sources.map((s) => s.name);
        expect(new Set(names).size).toBe(7);
        for (const s of sources) {
            expect(typeof s.name).toBe('string');
            expect(s.name.length).toBeGreaterThan(0);
            expect(s.ecosystem.length).toBeGreaterThan(0);
            expect(typeof s.fetch).toBe('function');
        }
    });
    it('includes all expected source names', () => {
        const names = ALL_SOURCES().map((s) => s.name).sort();
        expect(names).toEqual([
            'aws_botocore', 'azure_rest_specs', 'crates_top_2k',
            'gcp_service_usage', 'maven_top_2k', 'npm_top_5k', 'pypi_top_5k',
        ].sort());
    });
});
