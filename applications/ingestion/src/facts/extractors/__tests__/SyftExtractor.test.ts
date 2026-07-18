/** @format */
import { describe, it, expect } from '@jest/globals';
import { parseSyftJson } from '../SyftExtractor.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('parseSyftJson', () => {
    it('maps syft artifacts to RawTechnologyEvidence with provenance', () => {
        const json = readFileSync(path.join(__dirname, 'fixtures/syft-output.json'), 'utf-8');
        const out = parseSyftJson(json);
        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({
            raw_name: 'react', ecosystem: 'npm', source_layer: 'syft', file_path: 'package.json',
            version: '18.2.0',
        });
        expect(out[1]).toMatchObject({ raw_name: 'boto3', ecosystem: 'python', source_layer: 'syft', version: '1.34.0' });
    });

    it('returns [] for empty or non-JSON input', () => {
        expect(parseSyftJson('{}')).toEqual([]);
        expect(parseSyftJson('not json')).toEqual([]);
    });
});
