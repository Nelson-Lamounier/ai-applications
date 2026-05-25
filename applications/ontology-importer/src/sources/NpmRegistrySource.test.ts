/** @format */
import { describe, it, expect } from '@jest/globals';
import { parseNpmDoc, npmKeep } from './NpmRegistrySource.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('parseNpmDoc', () => {
    it('maps a registry doc to RawImportEntry', () => {
        const raw = JSON.parse(readFileSync(path.join(__dirname, '__tests__/fixtures/npm-package.json'), 'utf-8'));
        const e = parseNpmDoc(raw);
        expect(e).toMatchObject({ source_identifier: 'react', proposed_canonical_name: 'react' });
        expect(e.description).toContain('JavaScript library');
        expect(e.repository_url).toContain('github.com/facebook/react');
    });
});
describe('npmKeep', () => {
    it('drops @types and micro-utils', () => {
        expect(npmKeep({ source_identifier: '@types/node' } as never)).toBe(false);
        expect(npmKeep({ source_identifier: 'is-odd' } as never)).toBe(false);
        expect(npmKeep({ source_identifier: 'react' } as never)).toBe(true);
    });
});

describe('npm-top-5k.json seed list', () => {
    it('parses to a non-empty string[] with no duplicates', () => {
        const list = JSON.parse(
            readFileSync(path.join(__dirname, 'data/npm-top-5k.json'), 'utf-8'),
        ) as unknown;
        expect(Array.isArray(list)).toBe(true);
        const arr = list as unknown[];
        expect(arr.length).toBeGreaterThan(0);
        expect(arr.every((x) => typeof x === 'string')).toBe(true);
        expect(new Set(arr as string[]).size).toBe(arr.length);
    });
});
