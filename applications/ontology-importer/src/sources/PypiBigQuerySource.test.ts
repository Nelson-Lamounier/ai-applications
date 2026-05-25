/** @format */
import { describe, it, expect } from '@jest/globals';
import { parsePypiDoc, pypiCategoryFromClassifiers } from './PypiBigQuerySource.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('parsePypiDoc', () => {
    it('maps PyPI JSON to RawImportEntry (canonical lowercased)', () => {
        const raw = JSON.parse(readFileSync(path.join(__dirname, '__tests__/fixtures/pypi-package.json'), 'utf-8'));
        const e = parsePypiDoc(raw);
        expect(e).toMatchObject({ source_identifier: 'django', proposed_canonical_name: 'django', proposed_display_name: 'Django' });
    });
});
describe('pypiCategoryFromClassifiers', () => {
    it('maps Framework :: Django → framework_web', () => {
        expect(pypiCategoryFromClassifiers(['Framework :: Django'])).toBe('framework_web');
        expect(pypiCategoryFromClassifiers(['Topic :: Database'])).toBe('database_relational');
        expect(pypiCategoryFromClassifiers(['Programming Language :: Python'])).toBeNull();
    });
});

describe('pypi-top-5k.json seed list', () => {
    it('parses to a non-empty string[], all lowercase, no duplicates', () => {
        const list = JSON.parse(
            readFileSync(path.join(__dirname, 'data/pypi-top-5k.json'), 'utf-8'),
        ) as unknown;
        expect(Array.isArray(list)).toBe(true);
        const arr = list as unknown[];
        expect(arr.length).toBeGreaterThan(0);
        expect(arr.every((x) => typeof x === 'string')).toBe(true);
        expect((arr as string[]).every((x) => x === x.toLowerCase())).toBe(true);
        expect(new Set(arr as string[]).size).toBe(arr.length);
    });
});
